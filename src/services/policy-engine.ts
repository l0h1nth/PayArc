import type { AppConfig } from "../config.js";
import { isTerminal } from "../domain/state-machine.js";
import type { PolicyDecision, RecoveryCase, RecoveryDecision } from "../domain/types.js";

const contactActions = new Set(["REUSE_EXISTING_CHECKOUT", "SEND_RECOVERY_LINK", "REQUEST_PAYMENT_METHOD_UPDATE"]);

export class PolicyEngine {
  constructor(private readonly config: AppConfig["policy"]) {}

  evaluate(recoveryCase: RecoveryCase, decision: RecoveryDecision, now: number): PolicyDecision {
    const reasons: string[] = [];
    let allowed = true;
    let requiresApproval = decision.requiresHumanApproval || !this.config.autoActionsEnabled;

    if (this.config.globalKillSwitch) {
      allowed = false;
      reasons.push("Global action kill switch is enabled");
    }
    if (isTerminal(recoveryCase.status)) {
      allowed = false;
      reasons.push(`Case is terminal (${recoveryCase.status})`);
    }
    if (recoveryCase.cohort === "CONTROL" && decision.action !== "WAIT_FOR_PROVIDER_RETRY" && decision.action !== "ESCALATE_TO_HUMAN") {
      allowed = false;
      reasons.push("Control cohort cannot receive automated intervention");
    }
    if (recoveryCase.optedOut && contactActions.has(decision.action)) {
      allowed = false;
      reasons.push("Customer opted out");
    }
    if (recoveryCase.pausedUntil !== null && recoveryCase.pausedUntil > now && contactActions.has(decision.action)) {
      allowed = false;
      reasons.push("Recovery is paused until promise-to-pay date");
    }
    if (contactActions.has(decision.action)) {
      if (recoveryCase.contactCount >= this.config.maxContactsPerCase) {
        allowed = false;
        reasons.push("Per-case contact cap reached");
      }
      if (recoveryCase.lastContactAt !== null && now - recoveryCase.lastContactAt < this.config.contactCooldownSeconds) {
        allowed = false;
        reasons.push("Contact cooldown is active");
      }
    }
    if (decision.action === "SEND_RECOVERY_LINK") {
      if (recoveryCase.amount === null || recoveryCase.amount <= 0) {
        allowed = false;
        reasons.push("A verified positive outstanding amount is required");
      }
      if (!recoveryCase.currency || !this.config.allowedCurrencies.has(recoveryCase.currency)) {
        allowed = false;
        reasons.push("Currency is not allowed for automated recovery");
      }
      if (recoveryCase.amount !== null && recoveryCase.amount > this.config.maxAutoAmountPaise) {
        requiresApproval = true;
        reasons.push("Amount exceeds automatic-action threshold");
      }
    }
    if (recoveryCase.failureClass === "MERCHANT_CONFIGURATION" || recoveryCase.failureClass === "RISK_OR_COMPLIANCE") {
      if (contactActions.has(decision.action)) {
        allowed = false;
        reasons.push("Failure class cannot trigger customer contact");
      }
    }
    if (decision.confidence < 0.65 && decision.action !== "ESCALATE_TO_HUMAN") {
      requiresApproval = true;
      reasons.push("Decision confidence is below automatic-action threshold");
    }
    if (allowed && reasons.length === 0) reasons.push("All deterministic policy checks passed");

    return {
      allowed,
      requiresApproval,
      reasons,
      authoritative: {
        amount: recoveryCase.amount,
        currency: recoveryCase.currency,
        customerEmail: recoveryCase.customerEmail,
        customerContact: recoveryCase.customerContact,
        expiresAt: decision.action === "SEND_RECOVERY_LINK" ? now + this.config.paymentLinkTtlSeconds : null
      }
    };
  }
}
