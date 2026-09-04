import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { isTerminal } from "../domain/state-machine.js";
import type {
  Clock,
  Cohort,
  DecisionInput,
  NormalizedEvent,
  RecoveryCase,
  RecoveryDecision,
  RecoveryStatus,
  StoredAction
} from "../domain/types.js";
import type { DecisionProvider } from "../providers/decision-provider.js";
import type { PaymentProvider } from "../providers/payment-provider.js";
import { ProviderError } from "../providers/payment-provider.js";
import type { RecoveryRepository, StoredEvent } from "../storage/database.js";
import { classifyFailure } from "./failure-classifier.js";
import { PolicyEngine } from "./policy-engine.js";
import { isSupportedRazorpayEvent } from "./razorpay-events.js";

const failureEvents = new Set(["payment.failed", "subscription.pending", "subscription.halted"]);
const successEvents = new Set(["payment.captured", "order.paid", "subscription.charged", "subscription.activated", "payment_link.paid", "payment_link.partially_paid"]);
const linkClosureEvents = new Set(["payment_link.expired", "payment_link.cancelled"]);

function cohortFor(key: string, controlPercent: number): Cohort {
  const bucket = Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 100;
  return bucket < controlPercent ? "CONTROL" : "TREATMENT";
}

function sourceKey(event: NormalizedEvent): string {
  if (event.invoiceId) return `invoice:${event.invoiceId}`;
  if (event.paymentId) return `payment:${event.paymentId}`;
  if (event.subscriptionId) return `subscription:${event.subscriptionId}:${event.cycleAnchor ?? "current"}`;
  if (event.orderId) return `order:${event.orderId}`;
  return `${event.entityType}:${event.entityId}`;
}

function targetStatus(decision: RecoveryDecision): RecoveryStatus {
  switch (decision.action) {
    case "WAIT_FOR_PROVIDER_RETRY": return "WAITING";
    case "ESCALATE_TO_HUMAN": return "HUMAN_REVIEW";
    case "SUPPRESS_CONTACT": return "SUPPRESSED";
    case "SEND_RECOVERY_LINK":
    case "REUSE_EXISTING_CHECKOUT":
    case "REQUEST_PAYMENT_METHOD_UPDATE":
      return "ACTION_REQUIRED";
  }
}

function idempotencyKey(recoveryCase: RecoveryCase, decision: RecoveryDecision): string {
  return createHash("sha256")
    .update(`${recoveryCase.id}|${decision.action}|${recoveryCase.interventionCount}`)
    .digest("hex");
}

function addCounterfactual(decision: RecoveryDecision, recoveryCase: RecoveryCase): RecoveryDecision {
  const probabilities: Record<RecoveryCase["failureClass"], [number, number, string, string]> = {
    TRANSIENT_PROVIDER: [.62, .35, "IMMEDIATE_SAME_RAIL_RETRY", "Waiting for provider health avoids a retry storm while preserving likely recovery"],
    CUSTOMER_ACTIONABLE: [.58, .24, "DO_NOTHING", "A bounded alternate path has higher expected recovery than passive abandonment"],
    PAYMENT_METHOD_INVALID: [.53, .18, "RETRY_INVALID_METHOD", "Requesting a valid method avoids repeating a structurally impossible charge"],
    MERCHANT_CONFIGURATION: [.12, .10, "CONTACT_CUSTOMER", "Merchant-side faults should be fixed before disturbing the customer"],
    RISK_OR_COMPLIANCE: [.08, .07, "AUTOMATED_RETRY", "Compliance evidence requires human review; automated collection is unsafe"],
    UNKNOWN: [.20, .16, "AGGRESSIVE_OUTREACH", "Uncertain evidence is deliberately routed to a conservative path"]
  };
  const [interventionRecoveryProbability, naturalRecoveryProbability, rejectedAction, reason] = probabilities[recoveryCase.failureClass];
  return { ...decision, counterfactual: { rejectedAction, interventionRecoveryProbability, naturalRecoveryProbability,
    expectedIncrementalValue: Math.max(0, Math.round((recoveryCase.amount ?? 0) * (interventionRecoveryProbability - naturalRecoveryProbability))),
    reason, estimated: true } };
}

export class RecoveryEngine {
  private readonly policy: PolicyEngine;

  constructor(
    private readonly repository: RecoveryRepository,
    private readonly provider: PaymentProvider,
    private readonly decisionProvider: DecisionProvider,
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly actionCoordinator?: {
      onFailureObserved?(event: NormalizedEvent, recoveryCase: RecoveryCase, action: StoredAction): void;
      onActionSucceeded(actionId: string): Promise<void>;
    }
  ) {
    this.policy = new PolicyEngine(config.policy);
  }

  async processPending(limit = 20): Promise<{ claimed: number; completed: number; ignored: number; failed: number }> {
    const jobs = this.repository.claimJobs(this.clock.now(), limit);
    let completed = 0;
    let ignored = 0;
    let failed = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        if (!job) return;
        const stored = this.repository.getEvent(job.eventId);
        if (!stored) {
          this.repository.failJob(job.id, job.eventId, "Event record missing", this.clock.now(), false);
          failed += 1;
          continue;
        }
        try {
          const outcome = await this.processEvent(stored);
          if (outcome === "ignored") {
            this.repository.ignoreJob(job.id, job.eventId, "Event does not require a recovery mutation", this.clock.now());
            ignored += 1;
          } else {
            this.repository.completeJob(job.id, job.eventId, this.clock.now());
            completed += 1;
          }
        } catch (error) {
          const retryable = error instanceof ProviderError ? error.retryable : false;
          this.repository.failJob(job.id, job.eventId, error instanceof Error ? error.message : "Unknown worker failure", this.clock.now(), retryable);
          failed += 1;
        }
      }
    };
    const concurrency = Math.min(this.config.worker.concurrency, jobs.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (this.config.policy.autoActionsEnabled) {
      const dueActions = this.repository.listDueAutomatedActions(this.clock.now(), limit);
      await Promise.all(dueActions.map((action) => this.executeAction(action.id)));
    }
    return { claimed: jobs.length, completed, ignored, failed };
  }

  private async processEvent(stored: StoredEvent): Promise<"processed" | "ignored"> {
    const event = stored.normalized;
    if (!isSupportedRazorpayEvent(event.type)) return "ignored";
    if (successEvents.has(event.type)) return this.processSuccess(stored);
    if (linkClosureEvents.has(event.type)) return this.processLinkClosure(stored);
    if (!failureEvents.has(event.type)) return "ignored";

    const enriched = await this.enrichFailure(event);
    if (enriched.status === "captured" || enriched.status === "paid") {
      this.repository.appendAudit({ eventId: stored.id, kind: "STALE_FAILURE_IGNORED", actor: "recovery-engine", data: { reason: "Provider source of truth is already successful", paymentId: enriched.paymentId ?? null }, now: this.clock.now() });
      return "processed";
    }
    const key = sourceKey(enriched);
    let recoveryCase = this.repository.findCaseBySourceKey(key);
    const now = this.clock.now();

    if (recoveryCase && isTerminal(recoveryCase.status)) {
      this.repository.appendAudit({ caseId: recoveryCase.id, eventId: stored.id, kind: "STALE_FAILURE_IGNORED", actor: "recovery-engine", data: { eventType: event.type, eventAt: event.occurredAt }, now });
      return "processed";
    }
    if (recoveryCase && (recoveryCase.status === "ACTIONED" || recoveryCase.status === "PARTIALLY_RECOVERED")) {
      this.repository.appendAudit({ caseId: recoveryCase.id, eventId: stored.id, kind: "FAILURE_OBSERVED_DURING_ACTIVE_RECOVERY", actor: "recovery-engine", data: { eventType: event.type }, now });
      return "processed";
    }

    const failureClass = classifyFailure(enriched);
    if (!recoveryCase) {
      const base: Omit<RecoveryCase, "id"> = {
        sourceKey: key,
        entityType: enriched.entityType,
        entityId: enriched.entityId,
        paymentId: enriched.paymentId ?? null,
        subscriptionId: enriched.subscriptionId ?? null,
        orderId: enriched.orderId ?? null,
        invoiceId: enriched.invoiceId ?? null,
        amount: enriched.amount ?? null,
        currency: enriched.currency?.toUpperCase() ?? null,
        // PII is deliberately not persisted. Production messaging should resolve a scoped customer
        // reference from a dedicated CRM/notification boundary at action time.
        customerEmail: null,
        customerContact: null,
        status: "DETECTED",
        failureClass,
        errorCode: enriched.errorCode ?? null,
        errorReason: enriched.errorReason ?? null,
        errorSource: enriched.errorSource ?? null,
        errorStep: enriched.errorStep ?? null,
        recommendedAction: null,
        recommendationReason: null,
        cohort: cohortFor(key, this.config.policy.controlCohortPercent),
        contactCount: 0,
        interventionCount: 0,
        recoveredAmount: 0,
        optedOut: false,
        pausedUntil: null,
        latestEventAt: enriched.occurredAt,
        lastContactAt: null,
        createdAt: now,
        updatedAt: now
      };
      recoveryCase = this.repository.createCase(base, stored.id, now);
    } else if (enriched.occurredAt < recoveryCase.latestEventAt) {
      this.repository.appendAudit({ caseId: recoveryCase.id, eventId: stored.id, kind: "OUT_OF_ORDER_EVENT_OBSERVED", actor: "recovery-engine", data: { eventType: event.type, eventAt: event.occurredAt, latestEventAt: recoveryCase.latestEventAt }, now });
      return "processed";
    } else {
      recoveryCase = this.repository.saveCase({
        ...recoveryCase,
        paymentId: enriched.paymentId ?? recoveryCase.paymentId,
        subscriptionId: enriched.subscriptionId ?? recoveryCase.subscriptionId,
        orderId: enriched.orderId ?? recoveryCase.orderId,
        invoiceId: enriched.invoiceId ?? recoveryCase.invoiceId,
        amount: enriched.amount ?? recoveryCase.amount,
        currency: enriched.currency?.toUpperCase() ?? recoveryCase.currency,
        customerEmail: recoveryCase.customerEmail,
        customerContact: recoveryCase.customerContact,
        failureClass,
        errorCode: enriched.errorCode ?? recoveryCase.errorCode,
        errorReason: enriched.errorReason ?? recoveryCase.errorReason,
        errorSource: enriched.errorSource ?? recoveryCase.errorSource,
        errorStep: enriched.errorStep ?? recoveryCase.errorStep,
        latestEventAt: enriched.occurredAt,
        updatedAt: now
      }, stored.id, "recovery-engine", "Newer failure evidence merged", now);
    }

    if (enriched.untrustedTextSignals.length > 0) {
      this.repository.appendAudit({ caseId: recoveryCase.id, eventId: stored.id, kind: "PROMPT_INJECTION_SIGNAL", actor: "security-monitor", data: { signalCount: enriched.untrustedTextSignals.length }, now });
    }

    let decision = await this.decisionProvider.decide(this.decisionInput(recoveryCase, enriched));
    const checkoutJourney = enriched.orderId ? this.repository.findJourneyByOrderId(enriched.orderId) : null;
    if (checkoutJourney && checkoutJourney.status !== "PAID") {
      if (checkoutJourney.data.customerActive) {
        decision = {
          action: "WAIT_FOR_PROVIDER_RETRY",
          confidence: .99,
          reason: "The customer is still active in the original Razorpay checkout; observe the retry and suppress duplicate outreach",
          delaySeconds: 900,
          requiresHumanApproval: false,
          provider: "deterministic"
        };
      } else if (checkoutJourney.data.originalCheckoutUrl && checkoutJourney.data.checkoutExpiresAt > now) {
        decision = {
          action: "REUSE_EXISTING_CHECKOUT",
          confidence: .97,
          reason: "The original Razorpay checkout is still valid; reuse it instead of creating a duplicate Payment Link",
          delaySeconds: 300,
          requiresHumanApproval: false,
          provider: "deterministic"
        };
      }
    }
    decision = addCounterfactual(decision, recoveryCase);
    const policy = this.policy.evaluate(recoveryCase, decision, now);
    const scheduled = policy.allowed && !policy.requiresApproval && this.config.policy.autoActionsEnabled && decision.delaySeconds > 0;
    const nextStatus = policy.allowed ? scheduled ? "WAITING" : targetStatus(decision) : "HUMAN_REVIEW";
    recoveryCase = this.repository.saveCase({
      ...recoveryCase,
      status: nextStatus,
      recommendedAction: decision.action,
      recommendationReason: decision.reason,
      updatedAt: now
    }, stored.id, "decision-engine", policy.allowed ? decision.reason : policy.reasons.join("; "), now);

    const actionStatus: StoredAction["status"] = !policy.allowed
      ? "BLOCKED"
      : policy.requiresApproval
        ? "PROPOSED"
        : "APPROVED";
    const action = this.repository.createAction({
      caseId: recoveryCase.id,
      type: decision.action,
      status: actionStatus,
      idempotencyKey: idempotencyKey(recoveryCase, decision),
      decision,
      policy,
      maxAttempts: this.config.worker.actionRetryMaxAttempts,
      nextAttemptAt: actionStatus === "APPROVED" ? now + decision.delaySeconds : null,
      now
    });
    if (policy.allowed && ["SEND_RECOVERY_LINK", "REUSE_EXISTING_CHECKOUT"].includes(action.type)) {
      this.repository.ensureRecoverySession(
        recoveryCase.id,
        policy.authoritative.expiresAt ?? now + this.config.policy.paymentLinkTtlSeconds,
        now
      );
    }
    this.actionCoordinator?.onFailureObserved?.(enriched, recoveryCase, action);
    const coordinatedAction = this.repository.getAction(action.id)!;

    if (scheduled && coordinatedAction.status === "APPROVED") {
      this.repository.appendAudit({ caseId: recoveryCase.id, actionId: action.id, kind: "ACTION_SCHEDULED",
        actor: "recovery-autopilot", data: { executeAt: now + decision.delaySeconds, delaySeconds: decision.delaySeconds }, now });
    }

    if (coordinatedAction.status === "APPROVED" && this.config.policy.autoActionsEnabled && decision.delaySeconds === 0) {
      await this.executeAction(coordinatedAction.id);
    }
    return "processed";
  }

  private async enrichFailure(event: NormalizedEvent): Promise<NormalizedEvent> {
    let enriched = { ...event };
    if (event.paymentId) {
      try {
        const payment = await this.provider.fetchPayment(event.paymentId);
        if (event.amount !== undefined && (payment.amount !== event.amount || payment.currency !== event.currency?.toUpperCase())) {
          throw new Error("Signed event and provider payment facts contradict each other");
        }
        const trustedFields: Partial<NormalizedEvent> = {
          ...enriched,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status
        };
        const optionalValues = {
          orderId: payment.orderId ?? enriched.orderId,
          invoiceId: payment.invoiceId ?? enriched.invoiceId,
          method: payment.method ?? enriched.method,
          errorCode: payment.errorCode ?? enriched.errorCode,
          errorReason: payment.errorReason ?? enriched.errorReason,
          errorSource: payment.errorSource ?? enriched.errorSource,
          errorStep: payment.errorStep ?? enriched.errorStep
        };
        for (const [key, value] of Object.entries(optionalValues)) {
          if (value !== undefined) (trustedFields as Record<string, unknown>)[key] = value;
        }
        enriched = trustedFields as NormalizedEvent;
      } catch (error) {
        if (this.provider.mode === "razorpay") throw error;
      }
    }
    if ((enriched.amount === undefined || enriched.currency === undefined) && enriched.subscriptionId) {
      const invoice = await this.provider.fetchOutstandingInvoice(enriched.subscriptionId);
      if (invoice) {
        const invoiceFields: Partial<NormalizedEvent> = {
          ...enriched,
          amount: invoice.amountDue,
          currency: invoice.currency,
          invoiceId: invoice.id
        };
        const optionalValues = {
          paymentId: invoice.paymentId ?? enriched.paymentId,
          orderId: invoice.orderId ?? enriched.orderId,
        };
        for (const [key, value] of Object.entries(optionalValues)) {
          if (value !== undefined) (invoiceFields as Record<string, unknown>)[key] = value;
        }
        enriched = invoiceFields as NormalizedEvent;
      }
    }
    return enriched;
  }

  private decisionInput(recoveryCase: RecoveryCase, event: NormalizedEvent): DecisionInput {
    return {
      eventType: event.type,
      entityType: event.entityType,
      amount: recoveryCase.amount,
      currency: recoveryCase.currency,
      paymentMethod: event.method ?? null,
      failureClass: recoveryCase.failureClass,
      errorCode: recoveryCase.errorCode,
      errorReason: recoveryCase.errorReason,
      errorSource: recoveryCase.errorSource,
      errorStep: recoveryCase.errorStep,
      subscriptionState: event.entityType === "subscription" ? event.status ?? null : null,
      previousInterventions: recoveryCase.interventionCount,
      previousContacts: recoveryCase.contactCount,
      isControl: recoveryCase.cohort === "CONTROL"
    };
  }

  private async processSuccess(stored: StoredEvent): Promise<"processed" | "ignored"> {
    const event = stored.normalized;
    const now = this.clock.now();
    let recoveryCase: RecoveryCase | null = null;
    let expectedAmount: number | null = null;

    if (event.paymentLinkId) {
      const action = this.repository.findActionByProviderReference(event.paymentLinkId);
      if (!action) return "ignored";
      recoveryCase = this.repository.getCase(action.caseId);
      expectedAmount = action.policy.authoritative.amount;
      if (event.referenceId && event.referenceId !== action.idempotencyKey.slice(0, 40)) {
        // Actual reference IDs are stored as the action idempotency prefix.
        this.repository.appendAudit({ caseId: action.caseId, eventId: stored.id, actionId: action.id, kind: "OUTCOME_REFERENCE_MISMATCH", actor: "outcome-verifier", data: {}, now });
        if (recoveryCase && !isTerminal(recoveryCase.status)) {
          this.repository.saveCase({ ...recoveryCase, status: "HUMAN_REVIEW", updatedAt: now }, stored.id, "outcome-verifier", "Payment Link reference mismatch", now);
        }
        return "processed";
      }
    } else {
      recoveryCase = this.repository.findCaseForEvent(event);
      expectedAmount = recoveryCase?.amount ?? null;
    }
    if (!recoveryCase) return "ignored";
    if (recoveryCase.status === "SUPPRESSED") return "processed";

    const amountPaid = event.amountPaid ?? event.amount ?? expectedAmount ?? 0;
    if (expectedAmount !== null && event.amount !== undefined && event.amount !== expectedAmount) {
      this.repository.saveCase({ ...recoveryCase, status: "HUMAN_REVIEW", updatedAt: now }, stored.id, "outcome-verifier", "Outcome amount mismatch", now);
      return "processed";
    }
    if (recoveryCase.currency && event.currency && recoveryCase.currency !== event.currency.toUpperCase()) {
      this.repository.saveCase({ ...recoveryCase, status: "HUMAN_REVIEW", updatedAt: now }, stored.id, "outcome-verifier", "Outcome currency mismatch", now);
      return "processed";
    }
    const recoveredAmount = Math.max(recoveryCase.recoveredAmount, Math.min(amountPaid, expectedAmount ?? amountPaid));
    const fullyRecovered = expectedAmount !== null ? recoveredAmount >= expectedAmount : event.type !== "payment_link.partially_paid";
    const saved = this.repository.saveCase({
      ...recoveryCase,
      status: fullyRecovered ? "RECOVERED" : "PARTIALLY_RECOVERED",
      recoveredAmount,
      latestEventAt: Math.max(recoveryCase.latestEventAt, event.occurredAt),
      updatedAt: now
    }, stored.id, "outcome-verifier", fullyRecovered ? "Verified payment outcome" : "Verified partial payment", now);
    const session = this.repository.getRecoverySessionByCase(saved.id);
    if (session && fullyRecovered) this.repository.updateRecoverySession(session.id, { status: "PAID" }, "outcome-verifier", now);
    return "processed";
  }

  private async processLinkClosure(stored: StoredEvent): Promise<"processed" | "ignored"> {
    const event = stored.normalized;
    if (!event.paymentLinkId) return "ignored";
    const action = this.repository.findActionByProviderReference(event.paymentLinkId);
    if (!action) return "ignored";
    const recoveryCase = this.repository.getCase(action.caseId);
    if (!recoveryCase || isTerminal(recoveryCase.status)) return "processed";
    const now = this.clock.now();
    this.repository.updateAction(action.id, {
      status: event.type === "payment_link.cancelled" ? "CANCELLED" : action.status,
      error: event.type === "payment_link.expired" ? "Payment Link expired without full recovery" : "Payment Link cancelled"
    }, "outcome-verifier", now);
    this.repository.saveCase({ ...recoveryCase, status: "EXHAUSTED", latestEventAt: Math.max(recoveryCase.latestEventAt, event.occurredAt), updatedAt: now }, stored.id, "outcome-verifier", event.type, now);
    const session = this.repository.getRecoverySessionByCase(recoveryCase.id);
    if (session) this.repository.updateRecoverySession(session.id, { status: event.type === "payment_link.expired" ? "EXPIRED" : "CLOSED" }, "outcome-verifier", now);
    return "processed";
  }

  approveAction(actionId: string): StoredAction {
    const action = this.repository.getAction(actionId);
    if (!action) throw new Error("Action not found");
    if (action.status !== "PROPOSED") throw new Error(`Action cannot be approved from ${action.status}`);
    const recoveryCase = this.repository.getCase(action.caseId);
    if (!recoveryCase) throw new Error("Recovery case not found");
    const freshPolicy = this.policy.evaluate(recoveryCase, action.decision, this.clock.now());
    if (!freshPolicy.allowed) {
      return this.repository.updateAction(action.id, { status: "BLOCKED", error: freshPolicy.reasons.join("; ") }, "operator", this.clock.now());
    }
    const now = this.clock.now();
    return this.repository.updateAction(action.id, {
      status: "APPROVED",
      error: null,
      nextAttemptAt: this.config.policy.autoActionsEnabled ? now + action.decision.delaySeconds : null
    }, "operator", now);
  }

  async executeAction(actionId: string): Promise<StoredAction> {
    let action = this.repository.getAction(actionId);
    if (!action) throw new Error("Action not found");
    if (action.status === "SUCCEEDED") return action;
    if (action.status !== "APPROVED" && action.status !== "RETRY_SCHEDULED" && action.status !== "EXECUTING" && action.status !== "FAILED") throw new Error(`Action cannot execute from ${action.status}`);
    let recoveryCase = this.repository.getCase(action.caseId);
    if (!recoveryCase) throw new Error("Recovery case not found");
    const now = this.clock.now();
    const freshPolicy = this.policy.evaluate(recoveryCase, action.decision, now);
    if (!freshPolicy.allowed) return this.repository.updateAction(action.id, { status: "BLOCKED", error: freshPolicy.reasons.join("; "), nextAttemptAt: null }, "execution-policy", now);
    if (this.provider.mode === "razorpay" && !this.config.policy.externalActionsEnabled) {
      return this.repository.updateAction(action.id, { status: "BLOCKED", error: "External actions are disabled", nextAttemptAt: null }, "execution-policy", now);
    }

    action = this.repository.updateAction(action.id, {
      status: "EXECUTING",
      error: null,
      attemptCount: action.attemptCount + 1,
      nextAttemptAt: null,
      lastAttemptAt: now
    }, "executor", now);
    try {
      switch (action.type) {
        case "WAIT_FOR_PROVIDER_RETRY":
          recoveryCase = this.repository.saveCase({ ...recoveryCase, status: "WAITING", updatedAt: now }, null, "executor", "Provider retry observation window started", now);
          break;
        case "ESCALATE_TO_HUMAN":
          recoveryCase = this.repository.saveCase({ ...recoveryCase, status: "HUMAN_REVIEW", updatedAt: now }, null, "executor", "Escalated for operator review", now);
          break;
        case "SUPPRESS_CONTACT":
          recoveryCase = this.repository.saveCase({ ...recoveryCase, status: "SUPPRESSED", optedOut: true, updatedAt: now }, null, "executor", "Contact suppressed", now);
          break;
        case "REQUEST_PAYMENT_METHOD_UPDATE":
          recoveryCase = this.repository.saveCase({
            ...recoveryCase,
            status: "ACTIONED",
            contactCount: recoveryCase.contactCount + 1,
            interventionCount: recoveryCase.interventionCount + 1,
            lastContactAt: now,
            updatedAt: now
          }, null, "executor", "Payment-method update request placed in sandbox outbox", now);
          break;
        case "REUSE_EXISTING_CHECKOUT": {
          const journey = recoveryCase.orderId ? this.repository.findJourneyByOrderId(recoveryCase.orderId) : null;
          if (!journey?.data.originalCheckoutUrl || journey.data.checkoutExpiresAt <= now) {
            throw new Error("The original checkout is missing or expired; rescore before creating a bounded replacement");
          }
          const url = new URL(journey.data.originalCheckoutUrl);
          if (url.protocol !== "https:" || !(url.hostname === "rzp.io" || url.hostname === "razorpay.com" || url.hostname.endsWith(".razorpay.com"))) {
            throw new Error("Existing checkout URL is not an approved Razorpay host");
          }
          action = this.repository.updateAction(action.id, { status: "EXECUTING", providerUrl: url.toString(), error: null }, "checkout-orchestrator", now);
          const session = this.repository.getRecoverySessionByCase(recoveryCase.id);
          if (session) this.repository.updateRecoverySession(session.id, { status: "READY", destinationUrl: url.toString() }, "checkout-orchestrator", now);
          recoveryCase = this.repository.saveCase({
            ...recoveryCase,
            status: "ACTIONED",
            interventionCount: recoveryCase.interventionCount + 1,
            updatedAt: now
          }, null, "executor", "Existing Razorpay checkout reused", now);
          break;
        }
        case "SEND_RECOVERY_LINK": {
          const authoritative = freshPolicy.authoritative;
          if (!authoritative.amount || !authoritative.currency || !authoritative.expiresAt) throw new Error("Missing authoritative Payment Link parameters");
          const referenceId = action.idempotencyKey.slice(0, 40);
          let link = await this.provider.findPaymentLinkByReference(referenceId);
          if (link && (link.amount !== authoritative.amount || link.currency !== authoritative.currency)) {
            throw new Error("Existing provider reference has contradictory financial parameters");
          }
          link ??= await this.provider.createPaymentLink({
            amount: authoritative.amount,
            currency: authoritative.currency,
            referenceId,
            description: `Recovery for ${recoveryCase.sourceKey}`.slice(0, 200),
            expireBy: authoritative.expiresAt,
            customerEmail: authoritative.customerEmail,
            customerContact: authoritative.customerContact,
            notes: { recovery_case: recoveryCase.id, action: action.id }
          });
          action = this.repository.updateAction(action.id, { status: "EXECUTING", providerReference: link.id, providerUrl: link.shortUrl, error: null }, "razorpay-adapter", now);
          const session = this.repository.getRecoverySessionByCase(recoveryCase.id);
          if (session) this.repository.updateRecoverySession(session.id, { status: "READY", destinationUrl: link.shortUrl, expiresAt: link.expireBy }, "razorpay-adapter", now);
          recoveryCase = this.repository.saveCase({
            ...recoveryCase,
            status: "ACTIONED",
            interventionCount: recoveryCase.interventionCount + 1,
            updatedAt: now
          }, null, "executor", "Bounded recovery link created", now);
          break;
        }
      }
      const succeeded = this.repository.updateAction(action.id, { status: "SUCCEEDED", error: null, nextAttemptAt: null }, "executor", this.clock.now());
      await this.actionCoordinator?.onActionSucceeded(succeeded.id);
      return succeeded;
    } catch (error) {
      const failedAt = this.clock.now();
      const message = error instanceof Error ? error.message : "Execution failed";
      const retryable = error instanceof ProviderError && error.retryable;
      if (retryable && this.config.policy.autoActionsEnabled && action.attemptCount < action.maxAttempts) {
        const retryDelay = Math.min(
          this.config.worker.actionRetryMaxSeconds,
          this.config.worker.actionRetryBaseSeconds * 2 ** Math.max(0, action.attemptCount - 1)
        );
        const nextAttemptAt = failedAt + retryDelay;
        const scheduled = this.repository.updateAction(action.id, {
          status: "RETRY_SCHEDULED",
          error: message,
          nextAttemptAt
        }, "recovery-autopilot", failedAt);
        if (!isTerminal(recoveryCase.status)) {
          recoveryCase = this.repository.saveCase({ ...recoveryCase, status: "WAITING", updatedAt: failedAt }, null,
            "recovery-autopilot", `Retry ${action.attemptCount + 1} scheduled after a transient provider failure`, failedAt);
        }
        this.repository.appendAudit({ caseId: recoveryCase.id, actionId: action.id, kind: "ACTION_RETRY_SCHEDULED",
          actor: "recovery-autopilot", data: { attempt: action.attemptCount, maxAttempts: action.maxAttempts, retryDelay, nextAttemptAt }, now: failedAt });
        return scheduled;
      }
      const failed = this.repository.updateAction(action.id, { status: "FAILED", error: message, nextAttemptAt: null }, "executor", failedAt);
      if (!isTerminal(recoveryCase.status)) {
        this.repository.saveCase({ ...recoveryCase, status: "HUMAN_REVIEW", updatedAt: failedAt }, null,
          "recovery-autopilot", retryable ? "Automatic retry budget exhausted" : "Execution failed with a non-retryable error", failedAt);
      }
      return failed;
    }
  }

  suppressCase(caseId: string, actor = "operator", reason = "Operator suppressed all contact"): RecoveryCase {
    const recoveryCase = this.repository.getCase(caseId);
    if (!recoveryCase) throw new Error("Case not found");
    const now = this.clock.now();
    const saved = this.repository.saveCase({ ...recoveryCase, status: "SUPPRESSED", optedOut: true, updatedAt: now }, null, actor, reason, now);
    const session = this.repository.getRecoverySessionByCase(caseId);
    if (session) this.repository.updateRecoverySession(session.id, { status: "CLOSED" }, actor, now);
    return saved;
  }

  pauseCase(caseId: string, until: number, actor = "operator", reason = "Promise-to-pay pause"): RecoveryCase {
    const recoveryCase = this.repository.getCase(caseId);
    if (!recoveryCase) throw new Error("Case not found");
    if (until <= this.clock.now()) throw new Error("Pause date must be in the future");
    return this.repository.saveCase({ ...recoveryCase, pausedUntil: until, status: "WAITING", updatedAt: this.clock.now() }, null, actor, reason, this.clock.now());
  }

  async applyCustomerIntent(caseId: string, intent: "OPT_OUT" | "PROMISE_TOMORROW" | "SEND_UPI" | "ALREADY_PAID"): Promise<{ intent: string; outcome: string }> {
    const recoveryCase = this.repository.getCase(caseId);
    if (!recoveryCase) throw new Error("Case not found");
    const now = this.clock.now();
    if (intent === "OPT_OUT") {
      this.suppressCase(caseId, "whatsapp-intent-agent", "Customer opted out through signed WhatsApp reply");
      this.repository.appendAudit({ caseId, kind: "CUSTOMER_OPT_OUT_APPLIED", actor: "whatsapp-intent-agent", data: { intent }, now });
      return { intent, outcome: "All outreach stopped" };
    }
    if (intent === "PROMISE_TOMORROW") {
      this.pauseCase(caseId, now + 86_400, "whatsapp-intent-agent", "Customer promised payment tomorrow through signed WhatsApp reply");
      this.repository.appendAudit({ caseId, kind: "PROMISE_TO_PAY_CAPTURED", actor: "whatsapp-intent-agent", data: { intent, dueAt: now + 86_400 }, now });
      return { intent, outcome: "Recovery paused until promise due" };
    }
    if (intent === "SEND_UPI") {
      const session = this.repository.getRecoverySessionByCase(caseId);
      if (session) this.repository.updateRecoverySession(session.id, { preferredMethod: "UPI" }, "whatsapp-intent-agent", now);
      this.repository.appendAudit({ caseId, kind: "PAYMENT_PREFERENCE_CAPTURED", actor: "whatsapp-intent-agent", data: { preference: "UPI" }, now });
      return { intent, outcome: session ? "Smart session updated with UPI preference" : "UPI preference recorded" };
    }

    let verifiedAmount = 0;
    const latestAction = this.repository.listActions(caseId)[0];
    try {
      if (latestAction?.providerReference) {
        const link = await this.provider.fetchPaymentLink(latestAction.providerReference);
        if (link.status === "paid") verifiedAmount = link.amountPaid;
      }
      if (!verifiedAmount && recoveryCase.paymentId) {
        const payment = await this.provider.fetchPayment(recoveryCase.paymentId);
        if (payment.status === "captured") verifiedAmount = payment.amount;
      }
    } catch {
      // Provider availability cannot turn a customer claim into verified revenue.
    }
    if (verifiedAmount > 0) {
      const recoveredAmount = Math.min(verifiedAmount, recoveryCase.amount ?? verifiedAmount);
      this.repository.saveCase({ ...recoveryCase, status: "RECOVERED", recoveredAmount, pausedUntil: null, updatedAt: now }, null,
        "whatsapp-intent-agent", "Customer already-paid claim verified with Razorpay", now);
      const session = this.repository.getRecoverySessionByCase(caseId);
      if (session) this.repository.updateRecoverySession(session.id, { status: "PAID" }, "whatsapp-intent-agent", now);
      this.repository.appendAudit({ caseId, kind: "ALREADY_PAID_VERIFIED", actor: "whatsapp-intent-agent", data: { intent, recoveredAmount }, now });
      return { intent, outcome: "Razorpay verified payment; recovery stopped" };
    }
    this.repository.appendAudit({ caseId, kind: "ALREADY_PAID_UNVERIFIED", actor: "whatsapp-intent-agent", data: { intent }, now });
    return { intent, outcome: "Claim recorded; Razorpay has not confirmed payment yet" };
  }
}
