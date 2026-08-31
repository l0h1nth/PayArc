import type { CreatePaymentLinkInput, InvoiceRecord, OrderRecord, PaymentLinkRecord, PaymentRecord } from "../domain/types.js";
import type { PaymentProvider } from "./payment-provider.js";
import { ProviderError } from "./payment-provider.js";

type RazorpayProviderOptions = {
  keyId: string;
  keySecret: string;
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function notesFromApi(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, note]) => typeof note === "string" || typeof note === "number" || typeof note === "boolean")
    .map(([key, note]) => [key, String(note)]));
}

function paymentFromApi(value: Record<string, unknown>): PaymentRecord {
  return {
    id: String(value.id),
    amount: Number(value.amount),
    currency: String(value.currency).toUpperCase(),
    status: String(value.status),
    orderId: nullableString(value.order_id),
    invoiceId: nullableString(value.invoice_id),
    method: nullableString(value.method),
    email: nullableString(value.email),
    contact: nullableString(value.contact),
    errorCode: nullableString(value.error_code),
    errorReason: nullableString(value.error_reason),
    errorSource: nullableString(value.error_source),
    errorStep: nullableString(value.error_step),
    notes: notesFromApi(value.notes)
  };
}

function paymentLinkFromApi(value: Record<string, unknown>): PaymentLinkRecord {
  return {
    id: String(value.id),
    referenceId: String(value.reference_id),
    amount: Number(value.amount),
    amountPaid: Number(value.amount_paid ?? 0),
    currency: String(value.currency).toUpperCase(),
    status: String(value.status) as PaymentLinkRecord["status"],
    shortUrl: String(value.short_url),
    expireBy: Number(value.expire_by ?? 0)
  };
}

export class RazorpayProvider implements PaymentProvider {
  readonly mode = "razorpay" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RazorpayProviderOptions) {
    if (!options.keyId.startsWith("rzp_test_")) {
      throw new Error("RazorpayProvider refuses non-test credentials");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
  }

  private async request(path: string, init: RequestInit = {}, retrySafeRead = false): Promise<unknown> {
    const attempts = retrySafeRead ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
          ...init,
          headers: {
            authorization: `Basic ${Buffer.from(`${this.options.keyId}:${this.options.keySecret}`).toString("base64")}`,
            "content-type": "application/json",
            "user-agent": "PayArc/0.1",
            ...(init.headers ?? {})
          },
          signal: controller.signal
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) as unknown : null;
        if (!response.ok) {
          const description = body && typeof body === "object"
            ? (body as { error?: { description?: string } }).error?.description
            : undefined;
          const retryable = response.status === 429 || response.status >= 500;
          throw new ProviderError(`Razorpay request failed (${response.status}): ${description ?? "provider error"}`, response.status, retryable);
        }
        return body;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ProviderError ? error.retryable : true;
        if (!retryable || attempt === attempts) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError(error instanceof Error ? error.message : "Razorpay network error", null, true);
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  async fetchPayment(paymentId: string): Promise<PaymentRecord> {
    const data = await this.request(`/payments/${encodeURIComponent(paymentId)}`, { method: "GET" }, true) as Record<string, unknown>;
    return paymentFromApi(data);
  }

  async fetchOrder(orderId: string): Promise<OrderRecord> {
    const data = await this.request(`/orders/${encodeURIComponent(orderId)}`, { method: "GET" }, true) as Record<string, unknown>;
    return { id: String(data.id), notes: notesFromApi(data.notes) };
  }

  async fetchPaymentsForOrder(orderId: string): Promise<PaymentRecord[]> {
    const data = await this.request(`/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" }, true) as { items?: Array<Record<string, unknown>> };
    return (data.items ?? []).map(paymentFromApi);
  }

  async fetchOutstandingInvoice(subscriptionId: string): Promise<InvoiceRecord | null> {
    const data = await this.request(`/invoices?subscription_id=${encodeURIComponent(subscriptionId)}`, { method: "GET" }, true) as { items?: Array<Record<string, unknown>> };
    const outstanding = (data.items ?? [])
      .filter((invoice) => ["issued", "partially_paid"].includes(String(invoice.status)) && Number(invoice.amount_due) > 0)
      .sort((left, right) => Number(right.issued_at ?? right.created_at ?? 0) - Number(left.issued_at ?? left.created_at ?? 0))[0];
    if (!outstanding) return null;
    const details = outstanding.customer_details && typeof outstanding.customer_details === "object"
      ? outstanding.customer_details as Record<string, unknown>
      : {};
    return {
      id: String(outstanding.id),
      subscriptionId: String(outstanding.subscription_id),
      paymentId: nullableString(outstanding.payment_id),
      orderId: nullableString(outstanding.order_id),
      status: String(outstanding.status),
      amount: Number(outstanding.amount),
      amountPaid: Number(outstanding.amount_paid ?? 0),
      amountDue: Number(outstanding.amount_due),
      currency: String(outstanding.currency).toUpperCase(),
      shortUrl: nullableString(outstanding.short_url),
      email: nullableString(details.email ?? details.customer_email),
      contact: nullableString(details.contact ?? details.customer_contact),
      issuedAt: outstanding.issued_at === null || outstanding.issued_at === undefined ? null : Number(outstanding.issued_at),
      notes: notesFromApi(outstanding.notes)
    };
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkRecord> {
    // Do not attach webhook-derived customer data to a recovery Payment Link.
    // Razorpay accounts can require `customer.name` whenever the optional
    // `customer` object is present, while this service intentionally does not
    // persist a customer's name. Razorpay also no longer pre-fills hosted
    // checkout from these fields. Omitting the optional object is therefore
    // both the valid API shape and the privacy-preserving choice.
    const data = await this.request("/payment_links", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amount,
        currency: input.currency,
        accept_partial: false,
        reference_id: input.referenceId,
        description: input.description,
        expire_by: input.expireBy,
        notify: { email: false, sms: false },
        reminder_enable: false,
        notes: input.notes
      })
    }) as Record<string, unknown>;
    return paymentLinkFromApi(data);
  }

  async findPaymentLinkByReference(referenceId: string): Promise<PaymentLinkRecord | null> {
    const data = await this.request(`/payment_links?reference_id=${encodeURIComponent(referenceId)}`, { method: "GET" }, true) as { payment_links?: Array<Record<string, unknown>> };
    const link = data.payment_links?.find((item) => item.reference_id === referenceId);
    return link ? paymentLinkFromApi(link) : null;
  }

  async fetchPaymentLink(paymentLinkId: string): Promise<PaymentLinkRecord> {
    const data = await this.request(`/payment_links/${encodeURIComponent(paymentLinkId)}`, { method: "GET" }, true) as Record<string, unknown>;
    return paymentLinkFromApi(data);
  }

  async cancelPaymentLink(paymentLinkId: string): Promise<PaymentLinkRecord> {
    const data = await this.request(`/payment_links/${encodeURIComponent(paymentLinkId)}/cancel`, { method: "POST" }) as Record<string, unknown>;
    return paymentLinkFromApi(data);
  }
}
