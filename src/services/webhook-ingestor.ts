import { createHash } from "node:crypto";
import type { Clock } from "../domain/types.js";
import { verifyWebhookSignature } from "../security/webhook.js";
import type { RecoveryRepository, EnqueueResult } from "../storage/database.js";
import { normalizeRazorpayEvent } from "./razorpay-events.js";

export class WebhookAuthError extends Error {}
export class WebhookInputError extends Error {}

export class WebhookIngestor {
  constructor(
    private readonly repository: RecoveryRepository,
    private readonly webhookSecrets: string[],
    private readonly clock: Clock
  ) {}

  ingest(rawBody: Buffer, signature: string | undefined, providerEventId: string | undefined): EnqueueResult {
    if (!providerEventId) throw new WebhookInputError("Missing x-razorpay-event-id header");
    if (!signature || !verifyWebhookSignature(rawBody, signature, this.webhookSecrets)) {
      this.repository.appendAudit({ kind: "WEBHOOK_SIGNATURE_REJECTED", actor: "webhook", data: { providerEventId }, now: this.clock.now() });
      throw new WebhookAuthError("Invalid Razorpay webhook signature");
    }
    const rawPayload = rawBody.toString("utf8");
    const normalized = normalizeRazorpayEvent(rawPayload, providerEventId);
    const { customerEmail: _email, customerContact: _contact, ...minimized } = normalized;
    return this.repository.enqueueEvent({
      rawPayload: redactSensitivePayload(rawPayload),
      payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      normalized: minimized,
      now: this.clock.now()
    });
  }
}

const sensitiveKeys = new Set([
  "email", "contact", "customer_email", "customer_contact", "vpa", "card", "card_id",
  "token", "account_number", "bank_account", "auth_code"
]);

function redactSensitivePayload(rawPayload: string): string {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) ? "[REDACTED]" : visit(child)
    ]));
  };
  return JSON.stringify(visit(JSON.parse(rawPayload)));
}
