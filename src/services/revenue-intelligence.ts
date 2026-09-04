import { createHash, randomUUID } from "node:crypto";
import type { Clock, NormalizedEvent, RecoveryCase, StoredAction } from "../domain/types.js";
import type {
  ConversationData,
  IncidentData,
  JourneyData,
  MandateData,
  PortfolioRecommendation,
  PromiseData,
  PromiseWorkflowStage,
  ReceivableData,
  RevenueMetrics,
  RevenueObject,
  RevenueObjectKind,
  RevenueSnapshot,
  SubscriptionData
} from "../domain/revenue-intelligence.js";
import { RecoveryRepository } from "../storage/database.js";

type AnyRevenueData = IncidentData | JourneyData | SubscriptionData | ReceivableData | MandateData | ConversationData | PromiseData;

const promiseReminderDelaySeconds = 300;
const promiseGracePeriodSeconds = 86_400;
const defaultPromiseContactLimit = 1;

function normalizePromiseData(data: PromiseData, status: string, now: number): PromiseData {
  let workflowStage: PromiseWorkflowStage;
  if (data.workflowStage) workflowStage = data.workflowStage;
  else if (status === "KEPT") workflowStage = "CLOSED_PAID";
  else if (status === "CANCELLED") workflowStage = "CLOSED_CANCELLED";
  else if (status === "MISSED") workflowStage = data.reminderAt && data.reminderAt > now ? "REMINDER_SCHEDULED" : "MERCHANT_REVIEW";
  else workflowStage = data.dueAt > now ? "PAUSED_UNTIL_DUE" : "DUE_CHECK";
  return {
    ...data,
    workflowStage,
    reminderSentAt: data.reminderSentAt ?? null,
    graceExpiresAt: data.graceExpiresAt ?? null,
    contactAttempts: data.contactAttempts ?? 0,
    maxContactAttempts: data.maxContactAttempts ?? defaultPromiseContactLimit,
    lastActivityAt: data.lastActivityAt ?? data.dueAt,
    lastActivity: data.lastActivity ?? (workflowStage === "CLOSED_PAID" ? "Payment verified; all recovery stopped" : "Promise captured and contact paused"),
    consentVerified: data.consentVerified ?? false
  };
}

function object<T>(input: Omit<RevenueObject<T>, "createdAt" | "updatedAt">, now: number): RevenueObject<T> {
  return { ...input, createdAt: now, updatedAt: now };
}

export class RevenueIntelligenceService {
  constructor(private readonly repository: RecoveryRepository, private readonly clock: Clock) {
    this.seedIfEmpty();
  }

  private seedIfEmpty(): void {
    if (this.repository.countRevenueObjects() > 0) return;
    const now = this.clock.now();
    const hour = 3_600;
    const day = 86_400;
    const fixtures: Array<RevenueObject<AnyRevenueData>> = [
      object<IncidentData>({
        id: "inc_hdfc_card", kind: "INCIDENT", status: "ACTIVE", amount: 463_700, currency: "INR", priority: 100, customerRef: null,
        data: { provider: "Razorpay", rail: "Cards", bank: "HDFC Bank", severity: "CRITICAL", failureCount: 32, baselineFailureRate: .021, observedFailureRate: .46, circuitBreaker: true, startedAt: now - 780, resolvedAt: null, stagedReleasePercent: 0, preventedRetries: 24 }
      }, now),
      object<IncidentData>({
        id: "inc_upi_latency", kind: "INCIDENT", status: "MONITORING", amount: 187_400, currency: "INR", priority: 72, customerRef: null,
        data: { provider: "Razorpay", rail: "UPI", bank: "Multiple PSPs", severity: "MEDIUM", failureCount: 11, baselineFailureRate: .012, observedFailureRate: .084, circuitBreaker: false, startedAt: now - 2_400, resolvedAt: now - 900, stagedReleasePercent: 100, preventedRetries: 7 }
      }, now),
      object<JourneyData>({
        id: "journey_active_retry", kind: "JOURNEY", status: "OBSERVING", amount: 98_900, currency: "INR", priority: 88, customerRef: "cus_8A2F",
        data: { sessionId: "chk_81b2", orderId: "order_demo_active", stage: "FAILED", paymentMethod: "card", customerActive: true, originalCheckoutUrl: "https://rzp.io/i/original-989", checkoutExpiresAt: now + day, recommendedAction: "OBSERVE_ACTIVE_RETRY", nextActionAt: now + 900, contactEligible: false, recoveredAmount: 0, reason: "Customer is still active in Razorpay checkout; suppress duplicate outreach" }
      }, now),
      object<JourneyData>({
        id: "journey_abandoned_otp", kind: "JOURNEY", status: "ABANDONED", amount: 249_900, currency: "INR", priority: 94, customerRef: "cus_51DE",
        data: { sessionId: "chk_19ce", orderId: "order_demo_abandoned", stage: "ABANDONED", paymentMethod: "card", customerActive: false, originalCheckoutUrl: "https://rzp.io/i/existing-checkout", checkoutExpiresAt: now + 18 * hour, recommendedAction: "REUSE_EXISTING_CHECKOUT", nextActionAt: now + 300, contactEligible: true, recoveredAmount: 0, reason: "OTP failed and the existing checkout remains valid; recommend UPI without creating a duplicate link" }
      }, now),
      object<JourneyData>({
        id: "journey_expired", kind: "JOURNEY", status: "EXPIRED", amount: 79_900, currency: "INR", priority: 65, customerRef: "cus_77B1",
        data: { sessionId: "chk_32a9", orderId: "order_demo_expired", stage: "ABANDONED", paymentMethod: "wallet", customerActive: false, originalCheckoutUrl: "", checkoutExpiresAt: now - hour, recommendedAction: "CREATE_BOUNDED_LINK", nextActionAt: now, contactEligible: true, recoveredAmount: 0, reason: "Original checkout expired; a new amount-bound Razorpay link is justified" }
      }, now),
      object<JourneyData>({
        id: "journey_recovered", kind: "JOURNEY", status: "PAID", amount: 149_900, currency: "INR", priority: 20, customerRef: "cus_12AC",
        data: { sessionId: "chk_70d1", orderId: "order_demo_paid", stage: "PAID", paymentMethod: "upi", customerActive: false, originalCheckoutUrl: "https://rzp.io/i/recovered", checkoutExpiresAt: now + day, recommendedAction: "STOP_RECOVERED", nextActionAt: null, contactEligible: false, recoveredAmount: 149_900, reason: "Payment captured; all pending recovery actions cancelled" }
      }, now),
      object<SubscriptionData>({
        id: "sub_stream_pro", kind: "SUBSCRIPTION", status: "PROVIDER_RETRY", amount: 49_900, currency: "INR", priority: 81, customerRef: "cus_302A",
        data: { plan: "Stream Pro annual", invoiceId: "inv_S101", failedAttempts: 1, providerRetryAt: now + 9 * hour, mandateStatus: "ACTIVE", recommendedAction: "WAIT_FOR_PROVIDER_RETRY", nextActionAt: now + 9 * hour, outstandingAmount: 49_900 }
      }, now),
      object<SubscriptionData>({
        id: "sub_cloud_halted", kind: "SUBSCRIPTION", status: "HALTED", amount: 129_900, currency: "INR", priority: 91, customerRef: "cus_4F21",
        data: { plan: "Cloud Team", invoiceId: "inv_S205", failedAttempts: 4, providerRetryAt: null, mandateStatus: "TOKEN_EXPIRED", recommendedAction: "REQUEST_PAYMENT_METHOD_UPDATE", nextActionAt: now, outstandingAmount: 129_900 }
      }, now),
      object<ReceivableData>({
        id: "recv_acme_1042", kind: "RECEIVABLE", status: "BLOCKED", amount: 845_000, currency: "INR", priority: 97, customerRef: "org_NORTHSTAR",
        data: { buyer: "Northstar Labs", invoiceNumber: "INV-1042", dueAt: now - 18 * day, daysOverdue: 18, blocker: "PO_NUMBER_MISSING", contactChannel: "EMAIL", promisedAt: null, recoveredAmount: 0, nextAction: "RESOLVE_DOCUMENT_BLOCKER" }
      }, now),
      object<ReceivableData>({
        id: "recv_orbit_1049", kind: "RECEIVABLE", status: "OVERDUE", amount: 327_500, currency: "INR", priority: 86, customerRef: "org_ORBIT",
        data: { buyer: "Orbit Retail", invoiceNumber: "INV-1049", dueAt: now - 9 * day, daysOverdue: 9, blocker: null, contactChannel: "VOICE", promisedAt: null, recoveredAmount: 0, nextAction: "HINGLISH_VOICE_OUTREACH" }
      }, now),
      object<MandateData>({
        id: "mandate_upi_22", kind: "MANDATE", status: "SEQUENCING", amount: 89_900, currency: "INR", priority: 83, customerRef: "cus_6C09",
        data: { rail: "UPI AutoPay", attempt: 1, maxAttempts: 3, bankHealthy: true, duplicateDebitRisk: false, nextAttemptAt: now + 6 * hour, steps: [
          { label: "Provider-managed retry", status: "DONE", scheduledAt: now - day },
          { label: "Preferred success window", status: "CURRENT", scheduledAt: now + 6 * hour },
          { label: "Mandate update", status: "QUEUED", scheduledAt: null },
          { label: "Manual checkout", status: "QUEUED", scheduledAt: null }
        ] }
      }, now),
      object<MandateData>({
        id: "mandate_card_risky", kind: "MANDATE", status: "BLOCKED", amount: 219_900, currency: "INR", priority: 90, customerRef: "cus_93DD",
        data: { rail: "Card mandate", attempt: 2, maxAttempts: 3, bankHealthy: false, duplicateDebitRisk: true, nextAttemptAt: null, steps: [
          { label: "Provider-managed retry", status: "DONE", scheduledAt: now - 2 * day },
          { label: "Outage-aware retry", status: "BLOCKED", scheduledAt: null },
          { label: "Payment method update", status: "QUEUED", scheduledAt: null }
        ] }
      }, now),
      object<ConversationData>({
        id: "conv_orbit_voice", kind: "CONVERSATION", status: "AWAITING_CUSTOMER", amount: 327_500, currency: "INR", priority: 79, customerRef: "org_ORBIT",
        data: { channel: "VOICE", language: "HINGLISH", consent: true, sentiment: "NEUTRAL", intent: "UNRESOLVED", linkedReceivableId: "recv_orbit_1049", linkedPromiseId: null, nextAction: "CAPTURE_STRUCTURED_INTENT", messages: [
          { role: "AGENT", text: "Namaste, INV-1049 ka payment pending hai. Kya aap payment date confirm kar sakte hain?", at: now - 120 }
        ] }
      }, now),
      object<PromiseData>({
        id: "promise_kept_31", kind: "PROMISE", status: "KEPT", amount: 159_900, currency: "INR", priority: 30, customerRef: "cus_10BB",
        data: { dueAt: now - day, channel: "WHATSAPP", confidence: .91, linkedReceivableId: null, reminderAt: null, keptAt: now - day + 600, stoppingRule: "Stop all outreach after verified payment", workflowStage: "CLOSED_PAID", reminderSentAt: null, graceExpiresAt: null, contactAttempts: 0, maxContactAttempts: 1, lastActivityAt: now - day + 600, lastActivity: "Payment verified; all recovery stopped", consentVerified: true }
      }, now),
      object<PromiseData>({
        id: "promise_due_45", kind: "PROMISE", status: "OPEN", amount: 64_900, currency: "INR", priority: 76, customerRef: "cus_8D20",
        data: { dueAt: now + day, channel: "VOICE_HINGLISH", confidence: .84, linkedReceivableId: null, reminderAt: null, keptAt: null, stoppingRule: "One reminder, then human escalation; stop on payment or opt-out", workflowStage: "PAUSED_UNTIL_DUE", reminderSentAt: null, graceExpiresAt: null, contactAttempts: 0, maxContactAttempts: 1, lastActivityAt: now, lastActivity: "Promise captured and contact paused", consentVerified: true }
      }, now)
    ];
    for (const fixture of fixtures) this.repository.upsertRevenueObject(fixture, "demo-seed");
    this.optimizePortfolio(6);
  }

  private require<T>(id: string, kind: RevenueObjectKind): RevenueObject<T> {
    const value = this.repository.getRevenueObject<T>(id);
    if (!value || value.kind !== kind) throw new Error(`${kind.toLowerCase()} not found`);
    return value;
  }

  private save<T>(value: RevenueObject<T>, operation: string, output: Record<string, unknown> = {}): RevenueObject<T> {
    const next = { ...value, updatedAt: this.clock.now() };
    const stored = this.repository.upsertRevenueObject(next);
    this.repository.recordRevenueOperation({ objectId: value.id, operation, status: "SUCCEEDED", output, now: next.updatedAt });
    return stored;
  }

  observeProviderEvent(event: NormalizedEvent): void {
    if (!event.type.startsWith("payment.downtime.")) return;
    const now = this.clock.now();
    const suffix = event.entityId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "provider";
    const id = `inc_provider_${suffix}`;
    const existing = this.repository.getRevenueObject<IncidentData>(id);
    const resolved = event.type === "payment.downtime.resolved";
    const current = existing ?? object<IncidentData>({
      id,
      kind: "INCIDENT",
      status: "ACTIVE",
      amount: event.amount ?? 0,
      currency: event.currency?.toUpperCase() ?? "INR",
      priority: 96,
      customerRef: null,
      data: {
        provider: "Razorpay",
        rail: event.method ?? "Payments",
        bank: event.errorSource ?? "Provider network",
        severity: "HIGH",
        failureCount: 1,
        baselineFailureRate: .02,
        observedFailureRate: .25,
        circuitBreaker: true,
        startedAt: event.occurredAt,
        resolvedAt: null,
        stagedReleasePercent: 0,
        preventedRetries: 0
      }
    }, now);
    const next: RevenueObject<IncidentData> = {
      ...current,
      status: resolved ? "RECOVERING" : "ACTIVE",
      amount: Math.max(current.amount, event.amount ?? 0),
      data: {
        ...current.data,
        rail: event.method ?? current.data.rail,
        bank: event.errorSource ?? current.data.bank,
        failureCount: current.data.failureCount + (existing ? 1 : 0),
        observedFailureRate: Math.min(.99, current.data.observedFailureRate + (event.type.endsWith("updated") ? .03 : 0)),
        circuitBreaker: !resolved,
        resolvedAt: resolved ? event.occurredAt : null,
        stagedReleasePercent: resolved ? 25 : 0,
        preventedRetries: current.data.preventedRetries + (resolved ? 0 : 1)
      },
      updatedAt: now
    };
    this.repository.upsertRevenueObject(next, "razorpay-webhook");
    this.repository.recordRevenueOperation({ objectId: id, operation: event.type.toUpperCase().replaceAll(".", "_"), status: "SUCCEEDED", output: { circuitBreaker: next.data.circuitBreaker }, now });
  }

  observeRecoveryFailure(event: NormalizedEvent, recoveryCase: RecoveryCase, action: StoredAction): void {
    if (recoveryCase.failureClass !== "TRANSIENT_PROVIDER" || !action.policy.allowed) return;
    const now = this.clock.now();
    const fingerprint = [event.method ?? "unknown", event.errorSource ?? "provider", event.errorReason ?? event.errorCode ?? "failure"]
      .map((value) => value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))
      .join(":");
    const id = `inc_swarm_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 14)}`;
    const existing = this.repository.getRevenueObject<IncidentData>(id);
    const recentFailureAt = [...(existing?.data.recentFailureAt ?? []), event.occurredAt]
      .filter((timestamp) => timestamp >= now - 120)
      .slice(-100);
    const affectedCaseIds = [...new Set([...(existing?.data.affectedCaseIds ?? []), recoveryCase.id])];
    const heldActionIds = [...new Set([...(existing?.data.heldActionIds ?? []), action.id])];
    const active = recentFailureAt.length >= 3;
    const incident = existing ?? object<IncidentData>({
      id, kind: "INCIDENT", status: "MONITORING", amount: 0, currency: recoveryCase.currency ?? "INR", priority: 90, customerRef: null,
      data: { provider: "Razorpay", rail: event.method ?? "Payments", bank: event.errorSource ?? "Provider network", severity: "HIGH", failureCount: 0,
        baselineFailureRate: .02, observedFailureRate: 0, circuitBreaker: false, startedAt: event.occurredAt, resolvedAt: null,
        stagedReleasePercent: 0, preventedRetries: 0, fingerprint, affectedCaseIds: [], heldActionIds: [], recentFailureAt: [], automated: true }
    }, now);
    const next: RevenueObject<IncidentData> = {
      ...incident,
      status: active ? "ACTIVE" : incident.status,
      amount: incident.amount + (recoveryCase.amount ?? 0),
      priority: active ? 98 : incident.priority,
      data: { ...incident.data, rail: event.method ?? incident.data.rail, bank: event.errorSource ?? incident.data.bank,
        failureCount: incident.data.failureCount + 1, observedFailureRate: Math.min(.99, recentFailureAt.length / 10),
        circuitBreaker: active || incident.data.circuitBreaker, fingerprint, affectedCaseIds, heldActionIds, recentFailureAt, automated: true },
      updatedAt: now
    };
    if (active) {
      let newlyHeld = 0;
      for (const actionId of heldActionIds) {
        const candidate = this.repository.getAction(actionId);
        if (!candidate || !["APPROVED", "RETRY_SCHEDULED"].includes(candidate.status)) continue;
        this.repository.updateAction(candidate.id, { status: "INCIDENT_HELD", nextAttemptAt: null,
          error: `Retry held by automatic failure swarm ${id}` }, "payment-intelligence", now);
        const candidateCase = this.repository.getCase(candidate.caseId);
        if (candidateCase && !["RECOVERED", "SUPPRESSED", "EXHAUSTED"].includes(candidateCase.status)) {
          this.repository.saveCase({ ...candidateCase, status: "WAITING", updatedAt: now }, null, "payment-intelligence", "Provider failure swarm engaged; retry held", now);
        }
        this.repository.appendAudit({ caseId: candidate.caseId, actionId: candidate.id, kind: "INCIDENT_RETRY_HELD", actor: "payment-intelligence", data: { incidentId: id, fingerprint }, now });
        newlyHeld += 1;
      }
      next.data.preventedRetries += newlyHeld;
    }
    this.repository.upsertRevenueObject(next, "payment-intelligence");
    this.repository.recordRevenueOperation({ objectId: id, operation: active ? "FAILURE_SWARM_CIRCUIT_BREAKER" : "FAILURE_SWARM_OBSERVED", status: "SUCCEEDED",
      output: { fingerprint, failuresInWindow: recentFailureAt.length, affectedCases: affectedCaseIds.length, circuitBreaker: next.data.circuitBreaker }, now });
  }

  onRecoveryActionSucceeded(actionId: string): void {
    const incidents = this.repository.listRevenueObjects<IncidentData>("INCIDENT");
    const incident = incidents.find((item) => item.data.heldActionIds?.includes(actionId) && item.status === "RECOVERING");
    if (incident) this.releaseIncident(incident.id);
  }

  reconcileFailureSwarms(): number {
    const now = this.clock.now();
    let changed = 0;
    for (const incident of this.repository.listRevenueObjects<IncidentData>("INCIDENT")) {
      if (!incident.data.automated || incident.status !== "ACTIVE") continue;
      const lastFailureAt = incident.data.recentFailureAt?.at(-1) ?? incident.data.startedAt;
      if (lastFailureAt > now - 300) continue;
      this.resolveIncident(incident.id);
      this.repository.recordRevenueOperation({ objectId: incident.id, operation: "FAILURE_SWARM_QUIET_WINDOW_PASSED", status: "SUCCEEDED",
        output: { quietSeconds: now - lastFailureAt, canaryReleasePercent: 25 }, now });
      changed += 1;
    }
    return changed;
  }

  reconcilePromiseWorkflows(): number {
    const now = this.clock.now();
    let changed = 0;
    for (const promise of this.repository.listRevenueObjects<PromiseData>("PROMISE")) {
      if (["KEPT", "CANCELLED"].includes(promise.status)) continue;
      const data = normalizePromiseData(promise.data, promise.status, now);

      if (data.workflowStage === "PAUSED_UNTIL_DUE" && data.dueAt <= now) {
        this.save({ ...promise, data: { ...data, workflowStage: "DUE_CHECK", lastActivityAt: now, lastActivity: "Promise due; payment verification started" } }, "PROMISE_DUE_CHECK_STARTED", { dueAt: data.dueAt });
        changed += 1;
        continue;
      }

      if (data.workflowStage === "DUE_CHECK") {
        this.save({
          ...promise,
          status: "MISSED",
          data: {
            ...data,
            workflowStage: "REMINDER_SCHEDULED",
            reminderAt: now + promiseReminderDelaySeconds,
            lastActivityAt: now,
            lastActivity: "No verified payment found; one consented reminder scheduled"
          }
        }, "PROMISE_PAYMENT_NOT_FOUND", { reminderInSeconds: promiseReminderDelaySeconds });
        changed += 1;
        continue;
      }

      if (data.workflowStage === "REMINDER_SCHEDULED" && (data.reminderAt ?? now) <= now) {
        const contactAttempts = data.contactAttempts ?? 0;
        const contactLimit = data.maxContactAttempts ?? defaultPromiseContactLimit;
        if (!data.consentVerified || contactAttempts >= contactLimit) {
          this.save({
            ...promise,
            status: "MISSED",
            data: { ...data, workflowStage: "MERCHANT_REVIEW", reminderAt: null, lastActivityAt: now, lastActivity: data.consentVerified ? "Contact limit reached; merchant review required" : "Consent unavailable; automatic contact blocked" }
          }, "PROMISE_REMINDER_BLOCKED", { consentVerified: data.consentVerified, contactAttempts, contactLimit });
        } else {
          this.save({
            ...promise,
            status: "MISSED",
            data: {
              ...data,
              workflowStage: "GRACE_PERIOD",
              reminderAt: null,
              reminderSentAt: now,
              graceExpiresAt: now + promiseGracePeriodSeconds,
              contactAttempts: contactAttempts + 1,
              lastActivityAt: now,
              lastActivity: `One consented reminder dispatched via ${data.channel}`
            }
          }, "PROMISE_REMINDER_DISPATCHED", { channel: data.channel, contactAttempt: contactAttempts + 1, contactLimit });
        }
        changed += 1;
        continue;
      }

      if (data.workflowStage === "GRACE_PERIOD" && (data.graceExpiresAt ?? now) <= now) {
        this.save({
          ...promise,
          status: "MISSED",
          data: { ...data, workflowStage: "MERCHANT_REVIEW", graceExpiresAt: null, lastActivityAt: now, lastActivity: "Grace period ended unpaid; automatic contact stopped for merchant review" }
        }, "PROMISE_ESCALATED_TO_MERCHANT", { contactAttempts: data.contactAttempts, contactLimit: data.maxContactAttempts });
        if (data.linkedReceivableId) {
          const receivable = this.repository.getRevenueObject<ReceivableData>(data.linkedReceivableId);
          if (receivable && !["PAID", "CANCELLED"].includes(receivable.status)) {
            this.save({ ...receivable, status: "HUMAN_REVIEW", data: { ...receivable.data, promisedAt: data.dueAt, nextAction: "MERCHANT_REVIEW_AFTER_MISSED_PROMISE" } }, "RECONCILE_MISSED_PROMISE", { promiseId: promise.id });
          }
        }
        changed += 1;
      }
    }
    return changed;
  }

  private releaseHeldActions(item: RevenueObject<IncidentData>, percent: number): number {
    const ids = item.data.heldActionIds ?? [];
    const target = Math.ceil(ids.length * percent / 100);
    const alreadyReleased = ids.filter((id) => this.repository.getAction(id)?.status !== "INCIDENT_HELD").length;
    let released = 0;
    for (const id of ids) {
      if (alreadyReleased + released >= target) break;
      const action = this.repository.getAction(id);
      if (!action || action.status !== "INCIDENT_HELD") continue;
      this.repository.updateAction(id, { status: "APPROVED", error: null, nextAttemptAt: this.clock.now() + released * 2 }, "payment-intelligence", this.clock.now());
      this.repository.appendAudit({ caseId: action.caseId, actionId: id, kind: "INCIDENT_CANARY_RELEASED", actor: "payment-intelligence", data: { incidentId: item.id, releasePercent: percent }, now: this.clock.now() });
      released += 1;
    }
    return released;
  }

  registerJourney(input: {
    customerRef: string;
    orderId?: string | undefined;
    amount: number;
    currency: string;
    originalCheckoutUrl: string;
    checkoutExpiresAt: number;
    paymentMethod?: string | undefined;
  }): RevenueObject<JourneyData> {
    const now = this.clock.now();
    const id = `journey_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const journey = object<JourneyData>({
      id,
      kind: "JOURNEY",
      status: "ACTIVE",
      amount: input.amount,
      currency: input.currency.toUpperCase(),
      priority: 70,
      customerRef: input.customerRef,
      data: {
        sessionId: `chk_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
        orderId: input.orderId ?? null,
        stage: "CHECKOUT_OPENED",
        paymentMethod: input.paymentMethod ?? "unknown",
        customerActive: true,
        originalCheckoutUrl: input.originalCheckoutUrl,
        checkoutExpiresAt: input.checkoutExpiresAt,
        recommendedAction: "OBSERVE_ACTIVE_RETRY",
        nextActionAt: now + 900,
        contactEligible: false,
        recoveredAmount: 0,
        reason: "Active checkout registered; recovery contact is suppressed while the customer is present"
      }
    }, now);
    const stored = this.repository.upsertRevenueObject(journey, "checkout-sdk");
    this.repository.recordRevenueOperation({ objectId: id, operation: "REGISTER_CHECKOUT_JOURNEY", status: "SUCCEEDED", output: { orderId: input.orderId ?? null }, now });
    return stored;
  }

  signalJourney(id: string, signal: {
    stage: JourneyData["stage"];
    customerActive: boolean;
    paymentMethod?: string | undefined;
  }): RevenueObject<JourneyData> {
    const item = this.require<JourneyData>(id, "JOURNEY");
    if (item.status === "PAID" && signal.stage !== "PAID") throw new Error("A paid journey cannot be reopened");
    const paid = signal.stage === "PAID";
    const abandoned = signal.stage === "ABANDONED";
    const originalValid = Boolean(item.data.originalCheckoutUrl) && item.data.checkoutExpiresAt > this.clock.now();
    return this.save({
      ...item,
      status: paid ? "PAID" : abandoned ? "ABANDONED" : signal.customerActive ? "ACTIVE" : "OBSERVING",
      data: {
        ...item.data,
        stage: signal.stage,
        customerActive: signal.customerActive,
        paymentMethod: signal.paymentMethod ?? item.data.paymentMethod,
        recoveredAmount: paid ? item.amount : item.data.recoveredAmount,
        contactEligible: !paid && abandoned,
        recommendedAction: paid ? "STOP_RECOVERED" : abandoned ? (originalValid ? "REUSE_EXISTING_CHECKOUT" : "CREATE_BOUNDED_LINK") : "OBSERVE_ACTIVE_RETRY",
        nextActionAt: paid ? null : abandoned ? this.clock.now() + 300 : this.clock.now() + 900,
        reason: paid ? "Verified checkout success; all recovery stopped" : abandoned ? (originalValid ? "Customer left; reuse the still-valid checkout after cooldown" : "Customer left and checkout expired; bounded replacement required") : "Customer activity detected; suppress outreach"
      }
    }, "CHECKOUT_JOURNEY_SIGNAL", { stage: signal.stage, customerActive: signal.customerActive });
  }

  snapshot(): RevenueSnapshot {
    const portfolioState = this.repository.getRevenueState<{ recommendations: PortfolioRecommendation[] }>("portfolio");
    const promises = this.repository.listRevenueObjects<PromiseData>("PROMISE").map((item) => ({ ...item, data: normalizePromiseData(item.data, item.status, this.clock.now()) }));
    const incidents = this.repository.listRevenueObjects<IncidentData>("INCIDENT");
    const operations = this.repository.listRevenueOperations(1_000);
    const cases = this.repository.listCases(10_000);
    const grossRecoveredFromObjects = this.repository.listRevenueObjects<AnyRevenueData>().reduce((sum, item) => {
      if (item.kind === "JOURNEY") return sum + (item.data as JourneyData).recoveredAmount;
      if (item.kind === "RECEIVABLE") return sum + (item.data as ReceivableData).recoveredAmount;
      if (item.kind === "PROMISE" && item.status === "KEPT") return sum + item.amount;
      return sum;
    }, 0);
    const grossRecovered = grossRecoveredFromObjects + cases.reduce((sum, item) => sum + Math.min(item.recoveredAmount, item.amount ?? item.recoveredAmount), 0);
    const naturalRecovery = Math.round(grossRecovered * .34);
    const interventionCost = operations.filter((entry) => ["CONTACT_RECEIVABLE", "RESPOND_CONVERSATION", "RECOVER_JOURNEY"].includes(String(entry.operation))).length * 650;
    const preventedRetries = incidents.reduce((sum, item) => sum + item.data.preventedRetries, 0);
    const protectedRevenue = incidents.reduce((sum, item) => sum + Math.round(item.amount * Math.min(1, item.data.preventedRetries / Math.max(1, item.data.failureCount))), 0);
    const kept = promises.filter((item) => item.status === "KEPT").length;
    const concluded = promises.filter((item) => ["KEPT", "MISSED"].includes(item.status)).length;
    const metrics: RevenueMetrics = {
      totalAtRisk: this.repository.listRevenueObjects<AnyRevenueData>().filter((item) => !["PAID", "KEPT", "RESOLVED"].includes(item.status)).reduce((sum, item) => sum + item.amount, 0),
      grossRecovered,
      naturalRecovery,
      incrementalRecovered: Math.max(0, grossRecovered - naturalRecovery),
      protectedRevenue,
      interventionCost,
      netRecoveryRoi: interventionCost > 0 ? Math.max(0, grossRecovered - naturalRecovery - interventionCost) / interventionCost : null,
      activeIncidents: incidents.filter((item) => item.status === "ACTIVE").length,
      retriesPrevented: preventedRetries,
      openPromises: promises.filter((item) => !["KEPT", "CANCELLED"].includes(item.status)).length,
      promiseKeepRate: concluded ? kept / concluded : null,
      contactSuppressed: operations.filter((entry) => String(entry.operation).includes("SUPPRESS")).length + this.repository.listRevenueObjects<JourneyData>("JOURNEY").filter((item) => !item.data.contactEligible).length
    };
    return {
      incidents,
      journeys: this.repository.listRevenueObjects<JourneyData>("JOURNEY"),
      subscriptions: this.repository.listRevenueObjects<SubscriptionData>("SUBSCRIPTION"),
      receivables: this.repository.listRevenueObjects<ReceivableData>("RECEIVABLE"),
      mandates: this.repository.listRevenueObjects<MandateData>("MANDATE"),
      conversations: this.repository.listRevenueObjects<ConversationData>("CONVERSATION"),
      promises,
      portfolio: portfolioState?.value.recommendations ?? [],
      metrics,
      lastOptimizedAt: portfolioState?.updatedAt ?? null
    };
  }

  resolveIncident(id: string): RevenueObject<IncidentData> {
    const item = this.require<IncidentData>(id, "INCIDENT");
    if (item.status === "RESOLVED") return item;
    const released = this.releaseHeldActions(item, 25);
    return this.save({ ...item, status: "RECOVERING", data: { ...item.data, circuitBreaker: false, resolvedAt: this.clock.now(), stagedReleasePercent: 25 } }, "RESOLVE_INCIDENT", { releasePercent: 25, released });
  }

  releaseIncident(id: string): RevenueObject<IncidentData> {
    const item = this.require<IncidentData>(id, "INCIDENT");
    if (item.data.circuitBreaker) throw new Error("Resolve the incident before releasing recovery traffic");
    const percent = Math.min(100, item.data.stagedReleasePercent + 25);
    const released = this.releaseHeldActions(item, percent);
    return this.save({ ...item, status: percent === 100 ? "RESOLVED" : "RECOVERING", data: { ...item.data, stagedReleasePercent: percent } }, "STAGED_RECOVERY_RELEASE", { releasePercent: percent, released });
  }

  recoverJourney(id: string): RevenueObject<JourneyData> {
    const item = this.require<JourneyData>(id, "JOURNEY");
    if (item.status === "PAID") return item;
    if (item.data.customerActive) {
      return this.save({ ...item, status: "OBSERVING", data: { ...item.data, contactEligible: false, recommendedAction: "OBSERVE_ACTIVE_RETRY", nextActionAt: this.clock.now() + 900 } }, "SUPPRESS_ACTIVE_CHECKOUT_CONTACT", { reusedExistingCheckout: true });
    }
    const existingValid = Boolean(item.data.originalCheckoutUrl) && item.data.checkoutExpiresAt > this.clock.now();
    return this.save({
      ...item,
      status: existingValid ? "RECOVERY_SCHEDULED" : "LINK_REQUIRED",
      data: {
        ...item.data,
        recommendedAction: existingValid ? "REUSE_EXISTING_CHECKOUT" : "CREATE_BOUNDED_LINK",
        nextActionAt: this.clock.now() + (existingValid ? 300 : 0),
        contactEligible: true,
        reason: existingValid ? "Existing Razorpay checkout reused; no duplicate link created" : "Original checkout is unavailable; bounded replacement link required"
      }
    }, "RECOVER_JOURNEY", { reusedExistingCheckout: existingValid });
  }

  payJourney(id: string): RevenueObject<JourneyData> {
    const item = this.require<JourneyData>(id, "JOURNEY");
    return this.save({ ...item, status: "PAID", data: { ...item.data, stage: "PAID", recoveredAmount: item.amount, contactEligible: false, recommendedAction: "STOP_RECOVERED", nextActionAt: null, reason: "Verified payment stopped every pending recovery action" } }, "VERIFY_JOURNEY_PAYMENT", { recoveredAmount: item.amount });
  }

  advanceSubscription(id: string): RevenueObject<SubscriptionData> {
    const item = this.require<SubscriptionData>(id, "SUBSCRIPTION");
    if (["RECOVERED", "CANCELLED"].includes(item.status)) return item;
    if (item.data.providerRetryAt && item.data.providerRetryAt > this.clock.now()) {
      return this.save(item, "HONOR_PROVIDER_RETRY", { nextActionAt: item.data.providerRetryAt });
    }
    const needsUpdate = item.data.mandateStatus.includes("EXPIRED") || item.data.failedAttempts >= 3;
    return this.save({ ...item, status: needsUpdate ? "METHOD_UPDATE_REQUIRED" : "RETRY_SCHEDULED", data: { ...item.data, recommendedAction: needsUpdate ? "REQUEST_PAYMENT_METHOD_UPDATE" : "SCHEDULE_PROVIDER_RETRY", nextActionAt: needsUpdate ? this.clock.now() : this.clock.now() + 21_600 } }, "ADVANCE_SUBSCRIPTION", { needsPaymentMethodUpdate: needsUpdate });
  }

  contactReceivable(id: string): RevenueObject<ReceivableData> {
    const item = this.require<ReceivableData>(id, "RECEIVABLE");
    if (["PAID", "CANCELLED"].includes(item.status)) return item;
    if (item.data.blocker) {
      return this.save({ ...item, status: "HUMAN_REVIEW", data: { ...item.data, nextAction: "RESOLVE_DOCUMENT_BLOCKER" } }, "CONTACT_RECEIVABLE", { contacted: false, blocker: item.data.blocker });
    }
    if (["CONTACTED", "PROMISE_CAPTURED", "HUMAN_REVIEW"].includes(item.status)) return item;
    const now = this.clock.now();
    return this.save({
      ...item,
      status: "CONTACTED",
      data: {
        ...item.data,
        contactAttempts: (item.data.contactAttempts ?? 0) + 1,
        lastContactAt: now,
        lastActivity: `Collection request sent via ${item.data.contactChannel}`,
        nextAction: "AWAIT_CUSTOMER_RESPONSE"
      }
    }, "CONTACT_RECEIVABLE", { contacted: true, channel: item.data.contactChannel, contactAttempt: (item.data.contactAttempts ?? 0) + 1 });
  }

  recordReceivableOutcome(id: string, outcome: "PROMISE" | "DISPUTE" | "PAID"): RevenueObject<ReceivableData> {
    const item = this.require<ReceivableData>(id, "RECEIVABLE");
    if (item.status === "PAID") return item;
    if (item.status !== "CONTACTED") throw new Error("Contact the buyer before recording an outcome");
    const now = this.clock.now();

    if (outcome === "PROMISE") {
      const promiseId = item.data.linkedPromiseId ?? `promise_${item.id}`;
      const promisedAt = now + 86_400;
      this.repository.upsertRevenueObject(object<PromiseData>({
        id: promiseId,
        kind: "PROMISE",
        status: "OPEN",
        amount: item.amount,
        currency: item.currency,
        priority: Math.max(80, item.priority),
        customerRef: item.customerRef,
        data: {
          dueAt: promisedAt,
          channel: item.data.contactChannel,
          confidence: .86,
          linkedReceivableId: item.id,
          reminderAt: null,
          keptAt: null,
          stoppingRule: "Pause until promise due; one consented reminder; then merchant review",
          workflowStage: "PAUSED_UNTIL_DUE",
          reminderSentAt: null,
          graceExpiresAt: null,
          contactAttempts: 0,
          maxContactAttempts: 1,
          lastActivityAt: now,
          lastActivity: "B2B payment promise captured and contact paused",
          consentVerified: true
        }
      }, now), "receivables-agent");
      return this.save({
        ...item,
        status: "PROMISE_CAPTURED",
        data: { ...item.data, response: outcome, promisedAt, linkedPromiseId: promiseId, nextAction: "TRACK_PROMISE", lastActivity: "Customer promise captured; follow-up moved to the promise pipeline" }
      }, "RECEIVABLE_PROMISE_CAPTURED", { promiseId, promisedAt });
    }

    if (outcome === "DISPUTE") {
      return this.save({
        ...item,
        status: "HUMAN_REVIEW",
        data: { ...item.data, response: outcome, nextAction: "RESOLVE_BUYER_DISPUTE", lastActivity: "Buyer disputed the invoice; automatic collection stopped" }
      }, "RECEIVABLE_DISPUTE_CAPTURED", { automaticContactStopped: true });
    }

    return this.save({
      ...item,
      status: "PAID",
      data: { ...item.data, response: outcome, recoveredAmount: item.amount, nextAction: "STOP_PAID", lastActivity: "Payment verified; collection workflow closed" }
    }, "RECEIVABLE_PAYMENT_RECONCILED", { recoveredAmount: item.amount });
  }

  resolveReceivableBlocker(id: string): RevenueObject<ReceivableData> {
    const item = this.require<ReceivableData>(id, "RECEIVABLE");
    return this.save({ ...item, status: "READY_TO_CONTACT", data: { ...item.data, blocker: null, nextAction: "SEND_CORRECTED_INVOICE" } }, "RESOLVE_RECEIVABLE_BLOCKER", { blockerResolved: true });
  }

  advanceMandate(id: string): RevenueObject<MandateData> {
    const item = this.require<MandateData>(id, "MANDATE");
    if (item.data.duplicateDebitRisk || !item.data.bankHealthy) {
      return this.save({ ...item, status: "BLOCKED", data: { ...item.data, nextAttemptAt: null } }, "BLOCK_UNSAFE_MANDATE_RETRY", { duplicateDebitRisk: item.data.duplicateDebitRisk, bankHealthy: item.data.bankHealthy });
    }
    const steps = item.data.steps.map((step) => ({ ...step }));
    const current = steps.findIndex((step) => step.status === "CURRENT");
    if (current >= 0) steps[current]!.status = "DONE";
    const next = steps.findIndex((step, index) => index > current && step.status === "QUEUED");
    if (next >= 0) {
      steps[next]!.status = "CURRENT";
      steps[next]!.scheduledAt = this.clock.now() + 21_600;
    }
    return this.save({ ...item, status: next >= 0 ? "SEQUENCING" : "EXHAUSTED", data: { ...item.data, attempt: Math.min(item.data.maxAttempts, item.data.attempt + 1), steps, nextAttemptAt: next >= 0 ? this.clock.now() + 21_600 : null } }, "ADVANCE_MANDATE_SEQUENCE", { nextStep: next >= 0 ? steps[next]!.label : null });
  }

  respondConversation(id: string, intent: "PROMISE_TOMORROW" | "SEND_UPI" | "ALREADY_PAID" | "OPT_OUT"): RevenueObject<ConversationData> {
    const item = this.require<ConversationData>(id, "CONVERSATION");
    if (!item.data.consent || item.status === "OPTED_OUT") throw new Error("Conversation has no valid contact consent");
    const now = this.clock.now();
    const responses = {
      PROMISE_TOMORROW: "Kal shaam tak payment kar dunga.",
      SEND_UPI: "UPI ka existing payment option bhej dijiye.",
      ALREADY_PAID: "Payment already kar diya hai.",
      OPT_OUT: "Please mujhe dobara contact mat kijiye."
    } as const;
    let linkedPromiseId = item.data.linkedPromiseId;
    let status = "RESPONDED";
    let nextAction = "VERIFY_AND_CONTINUE";
    if (intent === "PROMISE_TOMORROW") {
      linkedPromiseId = `promise_${item.id.replace("conv_", "")}`;
      this.repository.upsertRevenueObject(object<PromiseData>({
        id: linkedPromiseId, kind: "PROMISE", status: "OPEN", amount: item.amount, currency: item.currency, priority: 85, customerRef: item.customerRef,
        data: { dueAt: now + 86_400, channel: `${item.data.channel}_${item.data.language}`, confidence: .89, linkedReceivableId: item.data.linkedReceivableId, reminderAt: null, keptAt: null, stoppingRule: "Pause until due time; one reminder; stop on payment or opt-out", workflowStage: "PAUSED_UNTIL_DUE", reminderSentAt: null, graceExpiresAt: null, contactAttempts: 0, maxContactAttempts: 1, lastActivityAt: now, lastActivity: "Promise captured and contact paused", consentVerified: item.data.consent }
      }, now), "conversation-agent");
      status = "PROMISE_CAPTURED";
      nextAction = "PAUSE_UNTIL_PROMISE_DUE";
    } else if (intent === "SEND_UPI") {
      nextAction = "REUSE_EXISTING_CHECKOUT_WITH_UPI";
    } else if (intent === "ALREADY_PAID") {
      status = "VERIFYING_PAYMENT";
      nextAction = "VERIFY_RAZORPAY_BEFORE_CLOSING";
    } else {
      status = "OPTED_OUT";
      nextAction = "STOP_ALL_CONTACT";
      this.repository.recordRevenueOperation({ objectId: item.id, operation: "SUPPRESS_CONTACT_OPT_OUT", status: "SUCCEEDED", now });
      if (item.data.linkedPromiseId) this.updatePromise(item.data.linkedPromiseId, "CANCELLED");
    }
    return this.save({ ...item, status, data: { ...item.data, intent, linkedPromiseId, nextAction, messages: [...item.data.messages, { role: "CUSTOMER", text: responses[intent], at: now }] } }, "RESPOND_CONVERSATION", { intent, linkedPromiseId });
  }

  updatePromise(id: string, outcome: "KEPT" | "MISSED" | "CANCELLED"): RevenueObject<PromiseData> {
    const item = this.require<PromiseData>(id, "PROMISE");
    if (["KEPT", "CANCELLED"].includes(item.status)) return item;
    const now = this.clock.now();
    if (outcome === "MISSED" && item.status === "MISSED") return item;
    const data = normalizePromiseData(item.data, item.status, now);
    const workflowStage: PromiseWorkflowStage = outcome === "KEPT" ? "CLOSED_PAID" : outcome === "CANCELLED" ? "CLOSED_CANCELLED" : "REMINDER_SCHEDULED";
    const lastActivity = outcome === "KEPT"
      ? "Payment verified; every pending recovery action stopped"
      : outcome === "CANCELLED"
        ? "Customer opted out; every pending recovery action stopped"
        : "Promise marked missed; one consented reminder scheduled";
    const updated = this.save({
      ...item,
      status: outcome,
      data: {
        ...data,
        workflowStage,
        keptAt: outcome === "KEPT" ? now : null,
        reminderAt: outcome === "MISSED" ? now + promiseReminderDelaySeconds : null,
        graceExpiresAt: null,
        lastActivityAt: now,
        lastActivity
      }
    }, `PROMISE_${outcome}`, { stoppingRuleApplied: outcome !== "MISSED", reminderInSeconds: outcome === "MISSED" ? promiseReminderDelaySeconds : null });
    if (item.data.linkedReceivableId && outcome === "KEPT") {
      const receivable = this.repository.getRevenueObject<ReceivableData>(item.data.linkedReceivableId);
      if (receivable) this.save({ ...receivable, status: "PAID", data: { ...receivable.data, recoveredAmount: receivable.amount, promisedAt: item.data.dueAt, nextAction: "STOP_PAID" } }, "RECONCILE_PROMISE_PAYMENT", { promiseId: id });
    }
    return updated;
  }

  optimizePortfolio(budget: number): PortfolioRecommendation[] {
    const candidates = this.repository.listRevenueObjects<AnyRevenueData>().filter((item) => !["PAID", "KEPT", "RESOLVED", "OPTED_OUT", "CANCELLED"].includes(item.status) && item.kind !== "INCIDENT");
    const probabilityByKind: Record<RevenueObjectKind, number> = { INCIDENT: 0, JOURNEY: .62, SUBSCRIPTION: .54, RECEIVABLE: .43, MANDATE: .51, CONVERSATION: .58, PROMISE: .72 };
    const naturalByKind: Record<RevenueObjectKind, number> = { INCIDENT: 0, JOURNEY: .31, SUBSCRIPTION: .27, RECEIVABLE: .12, MANDATE: .24, CONVERSATION: .18, PROMISE: .36 };
    const actionByKind: Record<RevenueObjectKind, string> = { INCIDENT: "WAIT", JOURNEY: "REUSE_CHECKOUT", SUBSCRIPTION: "SEQUENCE_RETRY", RECEIVABLE: "RESOLVE_OR_CONTACT", MANDATE: "ADVANCE_SEQUENCE", CONVERSATION: "CAPTURE_INTENT", PROMISE: "TRACK_PROMISE" };
    const recommendations = candidates.map((item) => {
      let riskPenalty = 0;
      if (item.kind === "MANDATE" && (item.data as MandateData).duplicateDebitRisk) riskPenalty = item.amount * .35;
      if (item.kind === "JOURNEY" && (item.data as JourneyData).customerActive) riskPenalty = item.amount * .28;
      if (item.kind === "RECEIVABLE" && (item.data as ReceivableData).blocker) riskPenalty = item.amount * .18;
      const successProbability = probabilityByKind[item.kind];
      const naturalRecoveryProbability = naturalByKind[item.kind];
      const interventionCost = item.kind === "CONVERSATION" || item.kind === "RECEIVABLE" ? 650 : 150;
      return {
        objectId: item.id, kind: item.kind, customerRef: item.customerRef, amount: item.amount,
        action: actionByKind[item.kind], successProbability, naturalRecoveryProbability,
        riskPenalty, interventionCost,
        expectedIncrementalValue: Math.round(item.amount * Math.max(0, successProbability - naturalRecoveryProbability) - riskPenalty - interventionCost),
        selected: false,
        reason: riskPenalty > 0 ? "Guardrail penalty reduces priority until the active risk is cleared" : "High incremental recovery value within contact and execution limits"
      } satisfies PortfolioRecommendation;
    }).sort((left, right) => right.expectedIncrementalValue - left.expectedIncrementalValue)
      .map((item, index) => ({ ...item, selected: index < Math.max(1, Math.min(25, budget)) && item.expectedIncrementalValue > 0 }));
    const now = this.clock.now();
    this.repository.setRevenueState("portfolio", { recommendations }, now);
    this.repository.recordRevenueOperation({ operation: "OPTIMIZE_PORTFOLIO", status: "SUCCEEDED", input: { budget }, output: { candidates: recommendations.length, selected: recommendations.filter((item) => item.selected).length }, now });
    return recommendations;
  }

  runBatch(): { processed: number; recovered: number; protected: number; selected: number } {
    const selected = this.optimizePortfolio(6).filter((item) => item.selected);
    let recovered = 0;
    let protectedValue = 0;
    for (const recommendation of selected) {
      if (recommendation.kind === "JOURNEY") {
        const journey = this.recoverJourney(recommendation.objectId);
        if (journey.id === "journey_abandoned_otp") {
          this.payJourney(journey.id);
          recovered += journey.amount;
        }
      } else if (recommendation.kind === "SUBSCRIPTION") {
        this.advanceSubscription(recommendation.objectId);
      } else if (recommendation.kind === "RECEIVABLE") {
        this.contactReceivable(recommendation.objectId);
      } else if (recommendation.kind === "MANDATE") {
        const before = this.require<MandateData>(recommendation.objectId, "MANDATE");
        this.advanceMandate(recommendation.objectId);
        if (before.data.duplicateDebitRisk) protectedValue += before.amount;
      }
    }
    const now = this.clock.now();
    this.repository.recordRevenueOperation({ operation: "RUN_RECOVERY_BATCH", status: "SUCCEEDED", output: { processed: selected.length, recovered, protected: protectedValue }, now });
    this.optimizePortfolio(6);
    return { processed: selected.length, recovered, protected: protectedValue, selected: selected.length };
  }
}
