import { createHash } from "node:crypto";
import { z } from "zod";
import type { NormalizedEvent } from "../domain/types.js";
import { collectStrings, findUntrustedTextSignals } from "../security/untrusted-content.js";

const eventEnvelope = z.object({
  event: z.string().min(1),
  created_at: z.number().int().nonnegative().optional(),
  account_id: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({})
}).passthrough();

const supportedEvents = new Set([
  "payment.failed",
  "payment.authorized",
  "payment.captured",
  "payment.downtime.started",
  "payment.downtime.updated",
  "payment.downtime.resolved",
  "order.paid",
  "subscription.pending",
  "subscription.halted",
  "subscription.charged",
  "subscription.activated",
  "payment_link.paid",
  "payment_link.partially_paid",
  "payment_link.expired",
  "payment_link.cancelled"
]);

function entity(payload: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const container = payload[key];
  if (!container || typeof container !== "object") return null;
  const inner = (container as Record<string, unknown>).entity;
  return inner && typeof inner === "object" ? inner as Record<string, unknown> : null;
}

function str(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function customer(record: Record<string, unknown> | null, key: "email" | "contact"): string | undefined {
  const direct = str(record, key);
  if (direct) return direct;
  const details = record?.customer_details;
  if (!details || typeof details !== "object") return undefined;
  return str(details as Record<string, unknown>, key) ?? str(details as Record<string, unknown>, `customer_${key}`);
}

export function isSupportedRazorpayEvent(type: string): boolean {
  return supportedEvents.has(type);
}

export function normalizeRazorpayEvent(rawBody: string, providerEventId: string): NormalizedEvent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new Error("Webhook body is not valid JSON");
  }
  const envelope = eventEnvelope.parse(decoded);
  const payment = entity(envelope.payload, "payment");
  const subscription = entity(envelope.payload, "subscription");
  const paymentLink = entity(envelope.payload, "payment_link");
  const downtime = entity(envelope.payload, "payment_downtime") ?? entity(envelope.payload, "downtime");
  const order = entity(envelope.payload, "order");

  const primary = downtime ?? paymentLink ?? subscription ?? payment ?? order;
  const entityType: NormalizedEvent["entityType"] = downtime
    ? "payment_downtime"
    : paymentLink
    ? "payment_link"
    : subscription
      ? "subscription"
      : payment
        ? "payment"
        : "unknown";
  const entityId = str(primary, "id") ?? `unknown_${createHash("sha256").update(rawBody).digest("hex").slice(0, 16)}`;

  const untrustedValues = [
    ...collectStrings(payment?.notes),
    ...collectStrings(subscription?.notes),
    ...collectStrings(paymentLink?.notes),
    str(payment, "description"),
    str(paymentLink, "description")
  ];

  return {
    providerEventId,
    type: envelope.event,
    occurredAt: envelope.created_at ?? Math.floor(Date.now() / 1000),
    ...(envelope.account_id ? { accountId: envelope.account_id } : {}),
    entityType,
    entityId,
    ...(str(payment, "id") ? { paymentId: str(payment, "id")! } : {}),
    ...(str(subscription, "id") ? { subscriptionId: str(subscription, "id")! } : {}),
    ...(str(payment, "order_id") ?? str(order, "id") ? { orderId: (str(payment, "order_id") ?? str(order, "id"))! } : {}),
    ...(str(payment, "invoice_id") ? { invoiceId: str(payment, "invoice_id")! } : {}),
    ...(str(paymentLink, "id") ? { paymentLinkId: str(paymentLink, "id")! } : {}),
    ...(num(subscription, "current_start") !== undefined ? { cycleAnchor: num(subscription, "current_start")! } : {}),
    ...((num(paymentLink, "amount") ?? num(payment, "amount")) !== undefined ? { amount: (num(paymentLink, "amount") ?? num(payment, "amount"))! } : {}),
    ...(num(paymentLink, "amount_paid") !== undefined ? { amountPaid: num(paymentLink, "amount_paid")! } : {}),
    ...(str(paymentLink, "currency") ?? str(payment, "currency") ? { currency: (str(paymentLink, "currency") ?? str(payment, "currency"))! } : {}),
    ...(str(downtime, "status") ?? str(paymentLink, "status") ?? str(subscription, "status") ?? str(payment, "status") ? { status: (str(downtime, "status") ?? str(paymentLink, "status") ?? str(subscription, "status") ?? str(payment, "status"))! } : {}),
    ...(str(downtime, "method") ?? str(downtime, "instrument") ?? str(payment, "method") ? { method: (str(downtime, "method") ?? str(downtime, "instrument") ?? str(payment, "method"))! } : {}),
    ...(customer(paymentLink, "email") ?? customer(payment, "email") ? { customerEmail: (customer(paymentLink, "email") ?? customer(payment, "email"))! } : {}),
    ...(customer(paymentLink, "contact") ?? customer(payment, "contact") ? { customerContact: (customer(paymentLink, "contact") ?? customer(payment, "contact"))! } : {}),
    ...(str(payment, "error_code") ? { errorCode: str(payment, "error_code")! } : {}),
    ...(str(payment, "error_description") ? { errorDescription: str(payment, "error_description")! } : {}),
    ...(str(downtime, "bank") ?? str(downtime, "source") ?? str(payment, "error_source") ? { errorSource: (str(downtime, "bank") ?? str(downtime, "source") ?? str(payment, "error_source"))! } : {}),
    ...(str(payment, "error_step") ? { errorStep: str(payment, "error_step")! } : {}),
    ...(str(payment, "error_reason") ? { errorReason: str(payment, "error_reason")! } : {}),
    ...(str(paymentLink, "reference_id") ? { referenceId: str(paymentLink, "reference_id")! } : {}),
    untrustedTextSignals: findUntrustedTextSignals(untrustedValues)
  };
}
