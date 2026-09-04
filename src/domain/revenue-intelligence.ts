export const revenueObjectKinds = [
  "INCIDENT",
  "JOURNEY",
  "SUBSCRIPTION",
  "RECEIVABLE",
  "MANDATE",
  "CONVERSATION",
  "PROMISE"
] as const;

export type RevenueObjectKind = (typeof revenueObjectKinds)[number];

export type RevenueObject<T = Record<string, unknown>> = {
  id: string;
  kind: RevenueObjectKind;
  status: string;
  amount: number;
  currency: string;
  priority: number;
  customerRef: string | null;
  data: T;
  createdAt: number;
  updatedAt: number;
};

export type IncidentData = {
  provider: string;
  rail: string;
  bank: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  failureCount: number;
  baselineFailureRate: number;
  observedFailureRate: number;
  circuitBreaker: boolean;
  startedAt: number;
  resolvedAt: number | null;
  stagedReleasePercent: number;
  preventedRetries: number;
  fingerprint?: string;
  affectedCaseIds?: string[];
  heldActionIds?: string[];
  recentFailureAt?: number[];
  automated?: boolean;
};

export type JourneyData = {
  sessionId: string;
  orderId: string | null;
  stage: "CHECKOUT_OPENED" | "METHOD_SELECTED" | "OTP" | "FAILED" | "ABANDONED" | "PAID";
  paymentMethod: string;
  customerActive: boolean;
  originalCheckoutUrl: string;
  checkoutExpiresAt: number;
  recommendedAction: "OBSERVE_ACTIVE_RETRY" | "REUSE_EXISTING_CHECKOUT" | "CREATE_BOUNDED_LINK" | "STOP_RECOVERED";
  nextActionAt: number | null;
  contactEligible: boolean;
  recoveredAmount: number;
  reason: string;
};

export type SubscriptionData = {
  plan: string;
  invoiceId: string;
  failedAttempts: number;
  providerRetryAt: number | null;
  mandateStatus: string;
  recommendedAction: string;
  nextActionAt: number | null;
  outstandingAmount: number;
};

export type ReceivableData = {
  buyer: string;
  invoiceNumber: string;
  dueAt: number;
  daysOverdue: number;
  blocker: string | null;
  contactChannel: "EMAIL" | "WHATSAPP" | "VOICE";
  promisedAt: number | null;
  recoveredAmount: number;
  nextAction: string;
  contactAttempts?: number;
  lastContactAt?: number | null;
  response?: "PROMISE" | "DISPUTE" | "PAID" | null;
  linkedPromiseId?: string | null;
  lastActivity?: string;
};

export type MandateStep = {
  label: string;
  status: "DONE" | "CURRENT" | "QUEUED" | "BLOCKED";
  scheduledAt: number | null;
};

export type MandateData = {
  rail: string;
  attempt: number;
  maxAttempts: number;
  bankHealthy: boolean;
  duplicateDebitRisk: boolean;
  steps: MandateStep[];
  nextAttemptAt: number | null;
};

export type ConversationMessage = {
  role: "AGENT" | "CUSTOMER";
  text: string;
  at: number;
};

export type ConversationData = {
  channel: "VOICE" | "WHATSAPP" | "EMAIL";
  language: "HINGLISH" | "ENGLISH" | "HINDI";
  consent: boolean;
  sentiment: string;
  intent: string;
  messages: ConversationMessage[];
  linkedReceivableId: string | null;
  linkedPromiseId: string | null;
  nextAction: string;
};

export type PromiseWorkflowStage =
  | "PAUSED_UNTIL_DUE"
  | "DUE_CHECK"
  | "REMINDER_SCHEDULED"
  | "GRACE_PERIOD"
  | "MERCHANT_REVIEW"
  | "CLOSED_PAID"
  | "CLOSED_CANCELLED";

export type PromiseData = {
  dueAt: number;
  channel: string;
  confidence: number;
  linkedReceivableId: string | null;
  reminderAt: number | null;
  keptAt: number | null;
  stoppingRule: string;
  workflowStage?: PromiseWorkflowStage;
  reminderSentAt?: number | null;
  graceExpiresAt?: number | null;
  contactAttempts?: number;
  maxContactAttempts?: number;
  lastActivityAt?: number;
  lastActivity?: string;
  consentVerified?: boolean;
};

export type PortfolioRecommendation = {
  objectId: string;
  kind: RevenueObjectKind;
  customerRef: string | null;
  amount: number;
  action: string;
  successProbability: number;
  naturalRecoveryProbability: number;
  riskPenalty: number;
  interventionCost: number;
  expectedIncrementalValue: number;
  selected: boolean;
  reason: string;
};

export type RevenueMetrics = {
  totalAtRisk: number;
  grossRecovered: number;
  naturalRecovery: number;
  incrementalRecovered: number;
  protectedRevenue: number;
  interventionCost: number;
  netRecoveryRoi: number | null;
  activeIncidents: number;
  retriesPrevented: number;
  openPromises: number;
  promiseKeepRate: number | null;
  contactSuppressed: number;
};

export type RevenueSnapshot = {
  incidents: Array<RevenueObject<IncidentData>>;
  journeys: Array<RevenueObject<JourneyData>>;
  subscriptions: Array<RevenueObject<SubscriptionData>>;
  receivables: Array<RevenueObject<ReceivableData>>;
  mandates: Array<RevenueObject<MandateData>>;
  conversations: Array<RevenueObject<ConversationData>>;
  promises: Array<RevenueObject<PromiseData>>;
  portfolio: PortfolioRecommendation[];
  metrics: RevenueMetrics;
  lastOptimizedAt: number | null;
};
