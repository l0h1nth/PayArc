export type RevenueObject<T> = {
  id: string;
  kind: string;
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
  provider: string; rail: string; bank: string; severity: string; failureCount: number;
  baselineFailureRate: number; observedFailureRate: number; circuitBreaker: boolean;
  startedAt: number; resolvedAt: number | null; stagedReleasePercent: number; preventedRetries: number;
  fingerprint?: string; affectedCaseIds?: string[]; heldActionIds?: string[]; recentFailureAt?: number[]; automated?: boolean;
};

export type JourneyData = {
  sessionId: string; orderId: string | null; stage: string; paymentMethod: string; customerActive: boolean;
  originalCheckoutUrl: string; checkoutExpiresAt: number; recommendedAction: string;
  nextActionAt: number | null; contactEligible: boolean; recoveredAmount: number; reason: string;
};

export type SubscriptionData = {
  plan: string; invoiceId: string; failedAttempts: number; providerRetryAt: number | null;
  mandateStatus: string; recommendedAction: string; nextActionAt: number | null; outstandingAmount: number;
};

export type ReceivableData = {
  buyer: string; invoiceNumber: string; dueAt: number; daysOverdue: number; blocker: string | null;
  contactChannel: string; promisedAt: number | null; recoveredAmount: number; nextAction: string;
};

export type MandateStep = { label: string; status: string; scheduledAt: number | null };
export type MandateData = {
  rail: string; attempt: number; maxAttempts: number; bankHealthy: boolean;
  duplicateDebitRisk: boolean; steps: MandateStep[]; nextAttemptAt: number | null;
};

export type ConversationData = {
  channel: string; language: string; consent: boolean; sentiment: string; intent: string;
  messages: Array<{ role: "AGENT" | "CUSTOMER"; text: string; at: number }>;
  linkedReceivableId: string | null; linkedPromiseId: string | null; nextAction: string;
};

export type PromiseData = {
  dueAt: number; channel: string; confidence: number; linkedReceivableId: string | null;
  reminderAt: number | null; keptAt: number | null; stoppingRule: string;
};

export type PortfolioRecommendation = {
  objectId: string; kind: string; customerRef: string | null; amount: number; action: string;
  successProbability: number; naturalRecoveryProbability: number; riskPenalty: number;
  interventionCost: number; expectedIncrementalValue: number; selected: boolean; reason: string;
};

export type RevenueMetrics = {
  totalAtRisk: number; grossRecovered: number; naturalRecovery: number; incrementalRecovered: number;
  protectedRevenue: number; interventionCost: number; netRecoveryRoi: number | null;
  activeIncidents: number; retriesPrevented: number; openPromises: number;
  promiseKeepRate: number | null; contactSuppressed: number;
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
