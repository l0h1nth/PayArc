import type { CheckoutOrderRecord, CreateCheckoutOrderInput, CreatePaymentLinkInput, InvoiceRecord, OrderRecord, PaymentLinkRecord, PaymentRecord } from "../domain/types.js";

export class ProviderError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly retryable = false) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface PaymentProvider {
  readonly mode: "mock" | "razorpay";
  fetchPayment(paymentId: string): Promise<PaymentRecord>;
  createCheckoutOrder(input: CreateCheckoutOrderInput): Promise<CheckoutOrderRecord>;
  fetchOrder(orderId: string): Promise<OrderRecord>;
  fetchPaymentsForOrder(orderId: string): Promise<PaymentRecord[]>;
  fetchOutstandingInvoice(subscriptionId: string): Promise<InvoiceRecord | null>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkRecord>;
  findPaymentLinkByReference(referenceId: string): Promise<PaymentLinkRecord | null>;
  fetchPaymentLink(paymentLinkId: string): Promise<PaymentLinkRecord>;
  cancelPaymentLink(paymentLinkId: string): Promise<PaymentLinkRecord>;
}
