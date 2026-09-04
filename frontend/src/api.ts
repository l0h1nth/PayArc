import type { Action, AuditEntry, CaseDetail, ChannelReadiness, DemoScenario, EventSummary, Metrics, PublicConfig, RazorpayTestLab, RazorpayTestRun, RecoveryCase, ScenarioResult, ScenarioRunSummary } from "./types";
import type { RevenueObject, RevenueSnapshot } from "./revenue-types";

export type RealtimeState = "connecting" | "live" | "reconnecting" | "offline";

export type WhatsAppDelivery = {
  delivery: {
    id: string;
    mode: "CLICK_TO_CHAT" | "CLOUD_API";
    status: "PREPARED" | "SENT" | "FAILED";
    providerReference: string | null;
    error: string | null;
  };
  deliveryUrl: string | null;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const operatorToken = window.sessionStorage.getItem("payArcOperatorToken");
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(operatorToken ? { authorization: `Bearer ${operatorToken}` } : {}),
      ...options.headers
    }
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = { error: "The server returned a non-JSON response" };
  }
  if (!response.ok) {
    const error = body as { error?: string };
    throw new Error(error.error ?? `Request failed (${response.status})`);
  }
  return body as T;
}

export const api = {
  config: () => request<PublicConfig>("/api/config"),
  metrics: () => request<Metrics>("/api/metrics"),
  revenue: () => request<RevenueSnapshot>("/api/revenue/snapshot"),
  cases: () => request<RecoveryCase[]>("/api/cases"),
  caseDetail: (id: string) => request<CaseDetail>(`/api/cases/${id}`),
  channelReadiness: (id: string) => request<ChannelReadiness>(`/api/actions/${id}/channel-readiness`),
  actions: () => request<Action[]>("/api/actions"),
  events: () => request<EventSummary[]>("/api/events?limit=250"),
  audit: () => request<AuditEntry[]>("/api/audit/recent?limit=100"),
  verifyAudit: () => request<Metrics["audit"]>("/api/audit/verify"),
  scenarios: () => request<{ count: number; scenarios: DemoScenario[] }>("/api/demo/scenarios"),
  scenarioRuns: () => request<{ count: number; runs: ScenarioRunSummary[] }>("/api/demo/runs"),
  scenarioRun: (id: string) => request<ScenarioResult>(`/api/demo/runs/${id}`),
  runScenario: (id: string) => request<ScenarioResult>(`/api/demo/scenarios/${id}/run`, { method: "POST", body: "{}" }),
  razorpayTestRuns: () => request<RazorpayTestLab>("/api/razorpay-test/runs"),
  createRazorpayTestRun: (amount: number, description: string) => request<{ run: RazorpayTestRun; checkoutKeyId: string }>("/api/razorpay-test/runs", {
    method: "POST", body: JSON.stringify({ amount, currency: "INR", description })
  }),
  verifyRazorpayTestRun: (runId: string, paymentId: string, orderId: string, signature: string) => request<RazorpayTestRun>(`/api/razorpay-test/runs/${runId}/verify`, {
    method: "POST", body: JSON.stringify({ paymentId, orderId, signature })
  }),
  runWorker: () => request<{ claimed: number; completed: number; ignored: number; failed: number; swarmsAdvanced: number; promisesAdvanced: number }>("/api/worker/run", { method: "POST" }),
  approve: (id: string) => request<Action>(`/api/actions/${id}/approve`, { method: "POST" }),
  execute: (id: string) => request<Action>(`/api/actions/${id}/execute`, { method: "POST" }),
  whatsapp: (id: string) => request<WhatsAppDelivery>(`/api/actions/${id}/whatsapp`, {
    method: "POST", body: JSON.stringify({ consentConfirmed: true })
  }),
  resolveIncident: (id: string) => request<RevenueObject<never>>(`/api/revenue/incidents/${id}/resolve`, { method: "POST" }),
  releaseIncident: (id: string) => request<RevenueObject<never>>(`/api/revenue/incidents/${id}/release`, { method: "POST" }),
  recoverJourney: (id: string) => request<RevenueObject<never>>(`/api/revenue/journeys/${id}/recover`, { method: "POST" }),
  signalJourney: (id: string, stage: string, customerActive: boolean) => request<RevenueObject<never>>(`/api/revenue/journeys/${id}/signal`, { method: "POST", body: JSON.stringify({ stage, customerActive }) }),
  payJourney: (id: string) => request<RevenueObject<never>>(`/api/revenue/journeys/${id}/pay`, { method: "POST" }),
  advanceSubscription: (id: string) => request<RevenueObject<never>>(`/api/revenue/subscriptions/${id}/advance`, { method: "POST" }),
  contactReceivable: (id: string) => request<RevenueObject<never>>(`/api/revenue/receivables/${id}/contact`, { method: "POST" }),
  resolveReceivableBlocker: (id: string) => request<RevenueObject<never>>(`/api/revenue/receivables/${id}/resolve-blocker`, { method: "POST" }),
  advanceMandate: (id: string) => request<RevenueObject<never>>(`/api/revenue/mandates/${id}/advance`, { method: "POST" }),
  respondConversation: (id: string, intent: string) => request<RevenueObject<never>>(`/api/revenue/conversations/${id}/respond`, { method: "POST", body: JSON.stringify({ intent }) }),
  updatePromise: (id: string, outcome: string) => request<RevenueObject<never>>(`/api/revenue/promises/${id}/outcome`, { method: "POST", body: JSON.stringify({ outcome }) }),
  optimizePortfolio: (budget: number) => request<{ recommendations: RevenueSnapshot["portfolio"] }>("/api/revenue/portfolio/optimize", { method: "POST", body: JSON.stringify({ budget }) }),
  runRevenueBatch: () => request<{ processed: number; recovered: number; protected: number; selected: number }>("/api/revenue/batch/run", { method: "POST" }),
  suppress: (id: string) => request<RecoveryCase>(`/api/cases/${id}/suppress`, { method: "POST" }),
  pause: (id: string, until: number) => request<RecoveryCase>(`/api/cases/${id}/pause`, { method: "POST", body: JSON.stringify({ until }) }),
  pay: (actionId: string, amountPaid?: number) => request<{ case: RecoveryCase }>(`/api/demo/actions/${actionId}/pay`, {
    method: "POST",
    body: JSON.stringify(amountPaid ? { amountPaid } : {})
  }),
  subscribeRealtime: (onSync: () => void, onState: (state: RealtimeState) => void) => {
    let stopped = false;
    let retryTimer = 0;
    let controller: AbortController | null = null;
    const connect = async () => {
      if (stopped) return;
      onState("connecting");
      controller = new AbortController();
      const operatorToken = window.sessionStorage.getItem("payArcOperatorToken");
      try {
        const response = await fetch("/api/realtime", {
          headers: operatorToken ? { authorization: `Bearer ${operatorToken}` } : {},
          signal: controller.signal
        });
        if (!response.ok || !response.body) throw new Error(`Realtime connection failed (${response.status})`);
        onState("live");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            if (frame.split("\n").some((line) => line.trim() === "event: sync")) onSync();
          }
        }
      } catch {
        if (stopped) return;
      }
      if (!stopped) {
        onState("reconnecting");
        retryTimer = window.setTimeout(() => void connect(), 1_500);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(retryTimer);
      onState("offline");
    };
  }
};
