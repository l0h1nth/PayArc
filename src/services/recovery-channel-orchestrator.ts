import { createHmac } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Clock, RecoveryCase, StoredAction } from "../domain/types.js";
import type { PaymentProvider } from "../providers/payment-provider.js";
import type { WhatsAppProvider } from "../providers/whatsapp-provider.js";
import type { ChannelDelivery, RecoveryRepository } from "../storage/database.js";

type CustomerResolution = {
  contact: string | null;
  maskedContact: string | null;
  contactSource: "PAYMENT" | "ORDER_PAYMENT" | "INVOICE" | null;
  consentVerified: boolean;
  consentSource: "PAYMENT_NOTES" | "ORDER_NOTES" | "INVOICE_NOTES" | "OPERATOR_ATTESTATION" | null;
};

export type ChannelReadiness = Omit<CustomerResolution, "contact"> & {
  autoSendEnabled: boolean;
  deliveryMode: "CLICK_TO_CHAT" | "CLOUD_API";
  ready: boolean;
  reasons: string[];
};

function enabledNote(notes: Record<string, string> | undefined, key: string): boolean {
  const value = notes?.[key]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "opted_in";
}

function normalizeIndianE164(value: string | null): string | null {
  if (!value) return null;
  const compact = value.trim().replace(/[\s()-]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  const digits = compact.replace(/\D/g, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return `+${digits}`;
  return null;
}

function maskContact(contact: string | null): string | null {
  if (!contact) return null;
  return `${contact.slice(0, Math.min(3, contact.length - 4))}••••${contact.slice(-4)}`;
}

export class RecoveryChannelOrchestrator {
  constructor(
    private readonly repository: RecoveryRepository,
    private readonly paymentProvider: PaymentProvider,
    private readonly whatsappProvider: WhatsAppProvider,
    private readonly config: AppConfig,
    private readonly clock: Clock
  ) {}

  private async resolveCustomer(recoveryCase: RecoveryCase, operatorConsent = false): Promise<CustomerResolution> {
    let contact: string | null = null;
    let contactSource: CustomerResolution["contactSource"] = null;
    let consentVerified = operatorConsent;
    let consentSource: CustomerResolution["consentSource"] = operatorConsent ? "OPERATOR_ATTESTATION" : null;
    const consentKey = this.config.whatsapp.consentNoteKey;

    if (recoveryCase.paymentId) {
      try {
        const payment = await this.paymentProvider.fetchPayment(recoveryCase.paymentId);
        contact = normalizeIndianE164(payment.contact);
        if (contact) contactSource = "PAYMENT";
        if (!consentVerified && enabledNote(payment.notes, consentKey)) {
          consentVerified = true;
          consentSource = "PAYMENT_NOTES";
        }
      } catch {
        // Fall through to the order and invoice lookups. No raw provider error is persisted.
      }
    }

    if (recoveryCase.orderId) {
      try {
        const order = await this.paymentProvider.fetchOrder(recoveryCase.orderId);
        if (!consentVerified && enabledNote(order.notes, consentKey)) {
          consentVerified = true;
          consentSource = "ORDER_NOTES";
        }
      } catch {
        // Older or provider-generated orders may not be directly retrievable.
      }
      if (!contact) {
        try {
          const payments = await this.paymentProvider.fetchPaymentsForOrder(recoveryCase.orderId);
          const matching = payments.find((payment) => normalizeIndianE164(payment.contact));
          contact = normalizeIndianE164(matching?.contact ?? null);
          if (contact) contactSource = "ORDER_PAYMENT";
          if (!consentVerified && enabledNote(matching?.notes, consentKey)) {
            consentVerified = true;
            consentSource = "PAYMENT_NOTES";
          }
        } catch {
          // Invoice lookup below remains available as the final trusted source.
        }
      }
    }

    if ((!contact || !consentVerified) && recoveryCase.subscriptionId) {
      try {
        const invoice = await this.paymentProvider.fetchOutstandingInvoice(recoveryCase.subscriptionId);
        if (!contact) {
          contact = normalizeIndianE164(invoice?.contact ?? null);
          if (contact) contactSource = "INVOICE";
        }
        if (!consentVerified && enabledNote(invoice?.notes, consentKey)) {
          consentVerified = true;
          consentSource = "INVOICE_NOTES";
        }
      } catch {
        // A missing invoice is represented as channel not ready, never as guessed contact data.
      }
    }

    return { contact, maskedContact: maskContact(contact), contactSource, consentVerified, consentSource };
  }

  async readiness(actionId: string): Promise<ChannelReadiness> {
    const action = this.repository.getAction(actionId);
    const recoveryCase = action ? this.repository.getCase(action.caseId) : null;
    if (!action || !recoveryCase) {
      return { maskedContact: null, contactSource: null, consentVerified: false, consentSource: null,
        autoSendEnabled: this.config.whatsapp.autoSendEnabled, deliveryMode: this.whatsappProvider.mode,
        ready: false, reasons: ["Recovery action is unavailable"] };
    }
    const resolution = await this.resolveCustomer(recoveryCase);
    const { contact, ...safeResolution } = resolution;
    const reasons: string[] = [];
    if (!action.providerUrl || action.status !== "SUCCEEDED") reasons.push("A completed recovery path is required");
    if (!contact) reasons.push("No valid customer contact was found on the trusted Razorpay payment or invoice");
    if (!resolution.consentVerified) reasons.push(`Opt-in note '${this.config.whatsapp.consentNoteKey}=true' was not found`);
    if (recoveryCase.optedOut || ["RECOVERED", "SUPPRESSED", "EXHAUSTED"].includes(recoveryCase.status)) reasons.push("A stopping rule prevents contact");
    if (recoveryCase.contactCount >= this.config.policy.maxContactsPerCase) reasons.push("Per-case contact limit reached");
    if (this.whatsappProvider.mode === "CLOUD_API" && !this.config.policy.externalActionsEnabled) reasons.push("External actions are disabled");
    if (contact) {
      const recipientHash = createHmac("sha256", this.config.razorpay.webhookSecrets[0]!).update(contact).digest("hex");
      const recentContacts = this.repository.countSentDeliveriesForRecipient(
        recipientHash,
        this.clock.now() - this.config.policy.customerContactWindowSeconds
      );
      if (recentContacts >= this.config.policy.maxContactsPerCustomer) reasons.push("Customer-wide contact budget reached");
    }
    return { ...safeResolution, autoSendEnabled: this.config.whatsapp.autoSendEnabled,
      deliveryMode: this.whatsappProvider.mode, ready: reasons.length === 0, reasons };
  }

  async deliver(actionId: string, options: { operatorConsent?: boolean; automatic?: boolean } = {}): Promise<{ delivery: ChannelDelivery; deliveryUrl: string | null }> {
    const existing = this.repository.getChannelDelivery(actionId, "WHATSAPP");
    if (existing && existing.status !== "FAILED" && !(existing.status === "SENDING" && existing.updatedAt < this.clock.now() - 300)) {
      return { delivery: existing, deliveryUrl: null };
    }
    const action = this.repository.getAction(actionId);
    if (!action) throw new Error("Action not found");
    const recoveryCase = this.repository.getCase(action.caseId);
    if (!recoveryCase) throw new Error("Recovery case not found");
    if (action.status !== "SUCCEEDED" || !action.providerUrl) throw new Error("A successful recovery path is required before WhatsApp delivery");
    if (recoveryCase.optedOut || ["RECOVERED", "SUPPRESSED", "EXHAUSTED"].includes(recoveryCase.status)) throw new Error("Stopping rule prevents customer contact");
    if (recoveryCase.contactCount >= this.config.policy.maxContactsPerCase) throw new Error("Per-case contact cap reached");
    if (this.whatsappProvider.mode === "CLOUD_API" && !this.config.policy.externalActionsEnabled) throw new Error("External actions are disabled");

    const resolution = await this.resolveCustomer(recoveryCase, options.operatorConsent === true);
    if (!resolution.contact) {
      this.auditSkip(recoveryCase, action, "CONTACT_UNAVAILABLE", options.automatic === true);
      throw new Error("No valid contact was found on the trusted Razorpay payment or invoice");
    }
    if (!resolution.consentVerified) {
      this.auditSkip(recoveryCase, action, "CONSENT_NOT_VERIFIED", options.automatic === true);
      throw new Error(`WhatsApp opt-in is missing. Set order note '${this.config.whatsapp.consentNoteKey}=true' during checkout.`);
    }

    const recipientHash = createHmac("sha256", this.config.razorpay.webhookSecrets[0]!)
      .update(resolution.contact).digest("hex");
    const reservation = this.repository.reserveChannelDelivery({ actionId: action.id, mode: this.whatsappProvider.mode, recipientHash,
      since: this.clock.now() - this.config.policy.customerContactWindowSeconds, limit: this.config.policy.maxContactsPerCustomer, now: this.clock.now() });
    if (!reservation) {
      this.auditSkip(recoveryCase, action, "CUSTOMER_FATIGUE_BUDGET_REACHED", options.automatic === true);
      throw new Error("Customer-wide contact budget reached");
    }
    const session = this.repository.getRecoverySessionByCase(recoveryCase.id);
    const recoveryUrl = session ? `${this.config.publicBaseUrl}/recover/${encodeURIComponent(session.id)}` : action.providerUrl;
    try {
      const result = await this.whatsappProvider.deliver({
        recipient: resolution.contact,
        amountDisplay: `${recoveryCase.currency ?? "INR"} ${((recoveryCase.amount ?? 0) / 100).toLocaleString("en-IN")}`,
        paymentUrl: recoveryUrl,
        caseReference: recoveryCase.id
      });
      const now = this.clock.now();
      const delivery = this.repository.saveChannelDelivery({
        actionId: action.id, channel: "WHATSAPP", mode: result.mode, status: result.status,
        recipientHash, providerReference: result.providerReference, error: null, now
      });
      if (result.status === "SENT") {
        this.repository.saveCase({ ...recoveryCase, contactCount: recoveryCase.contactCount + 1,
          lastContactAt: now, updatedAt: now }, null, "channel-orchestrator", "Consented WhatsApp recovery message sent", now);
      }
      this.repository.appendAudit({ caseId: recoveryCase.id, actionId: action.id,
        kind: result.status === "SENT" ? "WHATSAPP_MESSAGE_SENT" : "WHATSAPP_CHAT_PREPARED",
        actor: options.automatic ? "recovery-autopilot" : "operator",
        data: { deliveryId: delivery.id, mode: result.mode, automatic: options.automatic === true,
          contactSource: resolution.contactSource, consentSource: resolution.consentSource }, now });
      return { delivery, deliveryUrl: result.deliveryUrl };
    } catch (error) {
      const message = error instanceof Error ? error.message : "WhatsApp delivery failed";
      const now = this.clock.now();
      this.repository.saveChannelDelivery({ actionId: action.id, channel: "WHATSAPP", mode: this.whatsappProvider.mode,
        status: "FAILED", recipientHash, providerReference: null, error: message, now });
      this.repository.appendAudit({ caseId: recoveryCase.id, actionId: action.id, kind: "WHATSAPP_MESSAGE_FAILED",
        actor: options.automatic ? "recovery-autopilot" : "operator", data: { mode: this.whatsappProvider.mode }, now });
      throw error;
    }
  }

  async onActionSucceeded(actionId: string): Promise<void> {
    if (!this.config.whatsapp.autoSendEnabled) return;
    try {
      await this.deliver(actionId, { automatic: true });
    } catch {
      // The skip/failure is audited. Payment-path execution must not be rolled back by a channel failure.
    }
  }

  private auditSkip(recoveryCase: RecoveryCase, action: StoredAction, reason: string, automatic: boolean): void {
    this.repository.appendAudit({ caseId: recoveryCase.id, actionId: action.id,
      kind: "WHATSAPP_DELIVERY_SKIPPED", actor: automatic ? "recovery-autopilot" : "operator",
      data: { reason, automatic }, now: this.clock.now() });
  }
}
