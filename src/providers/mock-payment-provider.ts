import { randomUUID } from "node:crypto";
import type { CheckoutOrderRecord, CreateCheckoutOrderInput, CreatePaymentLinkInput, InvoiceRecord, OrderRecord, PaymentLinkRecord, PaymentRecord } from "../domain/types.js";
import type { PaymentProvider } from "./payment-provider.js";
import { ProviderError } from "./payment-provider.js";

export class MockPaymentProvider implements PaymentProvider {
  readonly mode = "mock" as const;
  readonly payments = new Map<string, PaymentRecord>();
  readonly orders = new Map<string, OrderRecord>();
  readonly invoices = new Map<string, InvoiceRecord[]>();
  readonly links = new Map<string, PaymentLinkRecord>();
  failNextCreate: Error | null = null;

  seedPayment(payment: PaymentRecord): void {
    this.payments.set(payment.id, payment);
  }

  seedOrder(order: OrderRecord): void {
    this.orders.set(order.id, order);
  }

  seedInvoice(invoice: InvoiceRecord): void {
    const current = this.invoices.get(invoice.subscriptionId) ?? [];
    current.push(invoice);
    this.invoices.set(invoice.subscriptionId, current);
  }

  async fetchPayment(paymentId: string): Promise<PaymentRecord> {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new ProviderError(`Mock payment not found: ${paymentId}`, 404, false);
    return structuredClone(payment);
  }

  async createCheckoutOrder(input: CreateCheckoutOrderInput): Promise<CheckoutOrderRecord> {
    const id = `order_mock_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    this.orders.set(id, { id, notes: structuredClone(input.notes) });
    return {
      id,
      amount: input.amount,
      currency: input.currency,
      receipt: input.receipt,
      status: "created"
    };
  }

  async fetchOrder(orderId: string): Promise<OrderRecord> {
    const order = this.orders.get(orderId);
    if (!order) throw new ProviderError(`Mock order not found: ${orderId}`, 404, false);
    return structuredClone(order);
  }

  async fetchPaymentsForOrder(orderId: string): Promise<PaymentRecord[]> {
    return [...this.payments.values()].filter((payment) => payment.orderId === orderId).map((payment) => structuredClone(payment));
  }

  async fetchOutstandingInvoice(subscriptionId: string): Promise<InvoiceRecord | null> {
    const invoice = (this.invoices.get(subscriptionId) ?? [])
      .filter((item) => ["issued", "partially_paid"].includes(item.status) && item.amountDue > 0)
      .sort((left, right) => (right.issuedAt ?? 0) - (left.issuedAt ?? 0))[0];
    return invoice ? structuredClone(invoice) : null;
  }

  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkRecord> {
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const existing = await this.findPaymentLinkByReference(input.referenceId);
    if (existing) throw new ProviderError("Duplicate payment link reference", 400, false);
    const id = `plink_mock_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const link: PaymentLinkRecord = {
      id,
      referenceId: input.referenceId,
      amount: input.amount,
      amountPaid: 0,
      currency: input.currency,
      status: "created",
      shortUrl: `https://example.test/pay/${id}`,
      expireBy: input.expireBy
    };
    this.links.set(id, link);
    return structuredClone(link);
  }

  async findPaymentLinkByReference(referenceId: string): Promise<PaymentLinkRecord | null> {
    const link = [...this.links.values()].find((item) => item.referenceId === referenceId);
    return link ? structuredClone(link) : null;
  }

  async fetchPaymentLink(paymentLinkId: string): Promise<PaymentLinkRecord> {
    const link = this.links.get(paymentLinkId);
    if (!link) throw new ProviderError(`Mock payment link not found: ${paymentLinkId}`, 404, false);
    return structuredClone(link);
  }

  async cancelPaymentLink(paymentLinkId: string): Promise<PaymentLinkRecord> {
    const link = this.links.get(paymentLinkId);
    if (!link) throw new ProviderError(`Mock payment link not found: ${paymentLinkId}`, 404, false);
    if (link.status === "paid" || link.status === "partially_paid") {
      throw new ProviderError(`Cannot cancel payment link in status ${link.status}`, 400, false);
    }
    link.status = "cancelled";
    return structuredClone(link);
  }

  setLinkOutcome(paymentLinkId: string, amountPaid: number): PaymentLinkRecord {
    const link = this.links.get(paymentLinkId);
    if (!link) throw new Error(`Mock payment link not found: ${paymentLinkId}`);
    link.amountPaid = amountPaid;
    link.status = amountPaid >= link.amount ? "paid" : amountPaid > 0 ? "partially_paid" : "created";
    return structuredClone(link);
  }
}
