export const recoveryStatuses = [
  "DETECTED",
  "PLANNED",
  "WAITING",
  "ACTION_REQUIRED",
  "HUMAN_REVIEW",
  "ACTIONED",
  "PARTIALLY_RECOVERED",
  "RECOVERED",
  "SUPPRESSED",
  "EXHAUSTED"
] as const;

export type RecoveryStatus = (typeof recoveryStatuses)[number];

export const failureClasses = [
  "TRANSIENT_PROVIDER",
  "CUSTOMER_ACTIONABLE",
  "PAYMENT_METHOD_INVALID",
  "MERCHANT_CONFIGURATION",
  "RISK_OR_COMPLIANCE",
  "UNKNOWN"
] as const;

export type FailureClass = (typeof failureClasses)[number];

export const actionTypes = [
  "WAIT_FOR_PROVIDER_RETRY",
  "REUSE_EXISTING_CHECKOUT",
  "SEND_RECOVERY_LINK",
  "REQUEST_PAYMENT_METHOD_UPDATE",
  "ESCALATE_TO_HUMAN",
  "SUPPRESS_CONTACT"
] as const;

export type ActionType = (typeof actionTypes)[number];
export type Cohort = "TREATMENT" | "CONTROL";

export type NormalizedEvent = {
  providerEventId: string;
  type: string;
  occurredAt: number;
  accountId?: string;
  entityType: "payment" | "subscription" | "payment_link" | "payment_downtime" | "unknown";
  entityId: string;
  paymentId?: string;
  subscriptionId?: string;
  orderId?: string;
  invoiceId?: string;
  paymentLinkId?: string;
  cycleAnchor?: number;
  amount?: number;
  amountPaid?: number;
  currency?: string;
  status?: string;
  method?: string;
  customerEmail?: string;
  customerContact?: string;
  errorCode?: string;
  errorDescription?: string;
  errorSource?: string;
  errorStep?: string;
  errorReason?: string;
  referenceId?: string;
  untrustedTextSignals: string[];
};

export type RecoveryCase = {
  id: string;
  sourceKey: string;
  entityType: NormalizedEvent["entityType"];
  entityId: string;
  paymentId: string | null;
  subscriptionId: string | null;
  orderId: string | null;
  invoiceId: string | null;
  amount: number | null;
  currency: string | null;
  customerEmail: string | null;
  customerContact: string | null;
  status: RecoveryStatus;
  failureClass: FailureClass;
  errorCode: string | null;
  errorReason: string | null;
  errorSource: string | null;
  errorStep: string | null;
  recommendedAction: ActionType | null;
  recommendationReason: string | null;
  cohort: Cohort;
  contactCount: number;
  interventionCount: number;
  recoveredAmount: number;
  optedOut: boolean;
  pausedUntil: number | null;
  latestEventAt: number;
  lastContactAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type DecisionInput = {
  eventType: string;
  entityType: NormalizedEvent["entityType"];
  amount: number | null;
  currency: string | null;
  paymentMethod: string | null;
  failureClass: FailureClass;
  errorCode: string | null;
  errorReason: string | null;
  errorSource: string | null;
  errorStep: string | null;
  subscriptionState: string | null;
  previousInterventions: number;
  previousContacts: number;
  isControl: boolean;
};

export type RecoveryDecision = {
  action: ActionType;
  confidence: number;
  reason: string;
  delaySeconds: number;
  requiresHumanApproval: boolean;
  provider: "deterministic" | "groq" | "openai";
  counterfactual?: {
    rejectedAction: string;
    interventionRecoveryProbability: number;
    naturalRecoveryProbability: number;
    expectedIncrementalValue: number;
    reason: string;
    estimated: true;
  };
};

export type PolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
  authoritative: {
    amount: number | null;
    currency: string | null;
    customerEmail: string | null;
    customerContact: string | null;
    expiresAt: number | null;
  };
};

export type PaymentRecord = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  orderId: string | null;
  invoiceId: string | null;
  method: string | null;
  email: string | null;
  contact: string | null;
  errorCode: string | null;
  errorReason: string | null;
  errorSource: string | null;
  errorStep: string | null;
  notes?: Record<string, string>;
};

export type OrderRecord = {
  id: string;
  notes: Record<string, string>;
};

export type CreateCheckoutOrderInput = {
  amount: number;
  currency: string;
  receipt: string;
  notes: Record<string, string>;
};

export type CheckoutOrderRecord = {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: "created" | "attempted" | "paid";
};

export type InvoiceRecord = {
  id: string;
  subscriptionId: string;
  paymentId: string | null;
  orderId: string | null;
  status: string;
  amount: number;
  amountPaid: number;
  amountDue: number;
  currency: string;
  shortUrl: string | null;
  email: string | null;
  contact: string | null;
  issuedAt: number | null;
  notes?: Record<string, string>;
};

export type PaymentLinkRecord = {
  id: string;
  referenceId: string;
  amount: number;
  amountPaid: number;
  currency: string;
  status: "created" | "partially_paid" | "expired" | "cancelled" | "paid";
  shortUrl: string;
  expireBy: number;
};

export type CreatePaymentLinkInput = {
  amount: number;
  currency: string;
  referenceId: string;
  description: string;
  expireBy: number;
  customerEmail: string | null;
  customerContact: string | null;
  notes: Record<string, string>;
};

export type StoredAction = {
  id: string;
  caseId: string;
  type: ActionType;
  status: "PROPOSED" | "APPROVED" | "RETRY_SCHEDULED" | "INCIDENT_HELD" | "EXECUTING" | "SUCCEEDED" | "BLOCKED" | "FAILED" | "CANCELLED";
  idempotencyKey: string;
  decision: RecoveryDecision;
  policy: PolicyDecision;
  providerReference: string | null;
  providerUrl: string | null;
  error: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type RecoverySession = {
  id: string;
  caseId: string;
  status: "WAITING" | "READY" | "PAID" | "CLOSED" | "EXPIRED";
  destinationUrl: string | null;
  preferredMethod: "AUTO" | "UPI";
  expiresAt: number;
  openCount: number;
  lastOpenedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };
