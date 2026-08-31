export type ViewId = "overview" | "portfolio" | "incidents" | "journeys" | "subscriptions" | "receivables" | "conversations" | "cases" | "scenarios" | "events" | "analytics" | "security" | "integrations" | "guide";

export type PublicConfig = {
  nodeEnv: string;
  paymentProviderMode: "mock" | "razorpay";
  autoActionsEnabled: boolean;
  externalActionsEnabled: boolean;
  globalKillSwitch: boolean;
  maxAutoAmountPaise: number;
  maxContactsPerCase: number;
  contactCooldownSeconds: number;
  controlCohortPercent: number;
  allowedCurrencies: string[];
  aiProvider: string;
  whatsappMode: "click_to_chat" | "cloud_api";
  whatsappAutoSendEnabled: boolean;
  workerBatchSize: number;
  workerConcurrency: number;
};

export type CohortMetric = {
  cases: number;
  eligibleAmount: number;
  recoveredAmount: number;
  recoveryRate: number | null;
};

export type Metrics = {
  totalCases: number;
  totalAtRisk: number;
  totalRecovered: number;
  byStatus: Record<string, number>;
  treatment: CohortMetric;
  control: CohortMetric;
  absoluteRecoveryUplift: number | null;
  averageRecoverySeconds: number | null;
  byFailureClass: Record<string, CohortMetric>;
  byIntervention: Record<string, CohortMetric>;
  operations: Record<string, number>;
  audit: { valid: boolean; checked: number; brokenAt: number | null };
};

export type RecoveryCase = {
  id: string;
  sourceKey: string;
  entityType: string;
  entityId: string;
  paymentId: string | null;
  subscriptionId: string | null;
  orderId: string | null;
  invoiceId: string | null;
  amount: number | null;
  currency: string | null;
  status: string;
  failureClass: string;
  errorCode: string | null;
  errorReason: string | null;
  errorSource: string | null;
  errorStep: string | null;
  recommendedAction: string | null;
  recommendationReason: string | null;
  cohort: "TREATMENT" | "CONTROL";
  contactCount: number;
  interventionCount: number;
  recoveredAmount: number;
  optedOut: boolean;
  pausedUntil: number | null;
  latestEventAt: number;
  createdAt: number;
  updatedAt: number;
};

export type Decision = {
  action: string;
  confidence: number;
  reason: string;
  delaySeconds: number;
  requiresHumanApproval: boolean;
  provider: string;
};

export type Action = {
  id: string;
  caseId: string;
  type: string;
  status: string;
  decision: Decision;
  policy: {
    allowed: boolean;
    requiresApproval: boolean;
    reasons: string[];
    authoritative: { amount: number | null; currency: string | null; expiresAt: number | null };
  };
  providerReference: string | null;
  providerUrl: string | null;
  error: string | null;
};

export type AuditEntry = {
  id: number;
  caseId: string | null;
  eventId: number | null;
  actionId: string | null;
  kind: string;
  actor: string;
  data: Record<string, unknown>;
  recordHash: string;
  createdAt: number;
};

export type EventSummary = {
  id: number;
  providerEventId: string;
  type: string;
  entityId: string;
  entityType: string;
  status: string;
  occurredAt: number;
  processedAt: number | null;
  payloadHash: string;
  error: string | null;
};

export type DemoScenario = {
  id: string;
  category: string;
  title: string;
  description: string;
  expected: string;
  events: string[];
  accent: string;
};

export type ScenarioResult = {
  runId: string;
  ranAt: number;
  scenario: DemoScenario;
  observed: string;
  case: RecoveryCase | null;
  actions: Action[];
  security: Record<string, boolean | number | string>;
  workerRuns: Array<{ claimed: number; completed: number; ignored: number; failed: number }>;
  recentAudit: AuditEntry[];
  eventTrace: EventSummary[];
};

export type ScenarioRunSummary = {
  runId: string;
  ranAt: number;
  scenarioId: string;
  title: string;
  accent: string;
  observed: string;
  outcome: string;
  caseId: string | null;
  eventCount: number;
  workerRunCount: number;
  actionCount: number;
  auditProofCount: number;
};

export type RazorpayTestRun = {
  id: string;
  providerOrderId: string;
  amount: number;
  currency: string;
  description: string;
  status: "CHECKOUT_READY" | "FAILURE_RECEIVED" | "PAYMENT_AUTHORIZED" | "PAYMENT_SUCCEEDED";
  paymentId: string | null;
  caseId: string | null;
  caseStatus: RecoveryCase["status"] | null;
  createdAt: number;
  updatedAt: number;
};

export type RazorpayTestLab = {
  available: boolean;
  reason: string | null;
  checkoutKeyId: string | null;
  runs: RazorpayTestRun[];
};

export type ChannelReadiness = {
    maskedContact: string | null;
    contactSource: "PAYMENT" | "ORDER_PAYMENT" | "INVOICE" | null;
    consentVerified: boolean;
    consentSource: "PAYMENT_NOTES" | "ORDER_NOTES" | "INVOICE_NOTES" | "OPERATOR_ATTESTATION" | null;
    autoSendEnabled: boolean;
    deliveryMode: "CLICK_TO_CHAT" | "CLOUD_API";
    ready: boolean;
    reasons: string[];
};

export type CaseDetail = {
  case: RecoveryCase;
  actions: Action[];
  deliveries: Array<{
    id: string;
    actionId: string;
    channel: "WHATSAPP";
    mode: "CLICK_TO_CHAT" | "CLOUD_API";
    status: "PREPARED" | "SENT" | "FAILED";
    providerReference: string | null;
    error: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
  channelReadiness: ChannelReadiness | null;
  audit: AuditEntry[];
};
