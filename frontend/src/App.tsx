import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, ArrowUpRight, BarChart3, Bell, Bot, Cable, Check,
  CheckCircle2, ChevronDown, ChevronRight, Circle, Clock3, Copy, CreditCard,
  BookOpen, Building2, ExternalLink, FileClock, FlaskConical, IndianRupee, LayoutDashboard,
  ListFilter, LockKeyhole, Menu, PanelLeftClose, Pause, Play, Radio, RefreshCw,
  MessageSquareText, Network, Route, Search, Send, Server, ShieldCheck, TestTube2, TrendingUp, WalletCards, Webhook, X, Zap
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer,
  Tooltip, XAxis, YAxis
} from "recharts";
import { api, type RealtimeState, type WhatsAppDelivery } from "./api";
import type {
  Action, AuditEntry, CaseDetail, ChannelReadiness, DemoScenario, EventSummary, Metrics, PublicConfig,
  RazorpayTestLab, RazorpayTestRun, RecoveryCase, ScenarioResult, ScenarioRunSummary, ViewId
} from "./types";
import type { RevenueSnapshot } from "./revenue-types";
import { caseNotificationState, isNotifiableCase, notificationRevisionKey } from "./notifications";
import { ConversationsView, IncidentsView, JourneysView, PortfolioView, ReceivablesView, SubscriptionsView } from "./RevenueViews";

const viewTitles: Record<ViewId, { title: string; subtitle: string }> = {
  overview: { title: "Overview", subtitle: "Revenue recovery control plane" },
  portfolio: { title: "Recovery Autopilot", subtitle: "Portfolio-level incremental revenue optimization" },
  incidents: { title: "Payment Intelligence", subtitle: "Live degradation detection and circuit breakers" },
  journeys: { title: "Checkout Journeys", subtitle: "Active-session observation and abandonment recovery" },
  subscriptions: { title: "Recurring Revenue", subtitle: "Subscription and mandate retry sequencing" },
  receivables: { title: "B2B Receivables", subtitle: "Invoice blockers, outreach, and reconciliation" },
  conversations: { title: "Conversations & Promises", subtitle: "Consent-aware Hinglish recovery and promise tracking" },
  cases: { title: "Recovery Cases", subtitle: "Investigate, approve, and execute bounded interventions" },
  scenarios: { title: "Scenario Lab", subtitle: "Exercise the production recovery pipeline safely" },
  events: { title: "Events & Audit", subtitle: "Signed webhook processing and tamper-evident decisions" },
  analytics: { title: "Analytics", subtitle: "Recovery effectiveness, cohorts, and intervention performance" },
  security: { title: "Security Center", subtitle: "Zero-trust controls and active attack simulations" },
  integrations: { title: "Integrations", subtitle: "Provider, AI, webhook, and runtime configuration" },
  guide: { title: "Operator Guide", subtitle: "Learn every workflow and run the winning demo" }
};

const validViews = new Set<ViewId>(Object.keys(viewTitles) as ViewId[]);

function readRoute(): { view: ViewId; caseId: string | null } {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("view") as ViewId | null;
  return { view: requested && validViews.has(requested) ? requested : "overview", caseId: params.get("case") };
}

function writeRoute(view: ViewId, caseId: string | null, replace = false) {
  const url = new URL(window.location.href);
  view === "overview" ? url.searchParams.delete("view") : url.searchParams.set("view", view);
  caseId ? url.searchParams.set("case", caseId) : url.searchParams.delete("case");
  window.history[replace ? "replaceState" : "pushState"]({}, "", url);
}

const securityKinds = new Set([
  "WEBHOOK_SIGNATURE_REJECTED", "PROMPT_INJECTION_SIGNAL", "DUPLICATE_EVENT_IGNORED",
  "STALE_FAILURE_IGNORED", "OUT_OF_ORDER_EVENT_OBSERVED", "OUTCOME_REFERENCE_MISMATCH"
]);

const supportedEvents = [
  ["payment.failed", "Open or enrich a recovery case"], ["payment.authorized", "Normalize and observe"],
  ["payment.captured", "Close matching recovery"], ["order.paid", "Close matching order recovery"],
  ["payment.downtime.started", "Engage the payment-rail circuit breaker"], ["payment.downtime.updated", "Update live degradation evidence"],
  ["payment.downtime.resolved", "Start a staged recovery release"],
  ["subscription.pending", "Honor provider retry window"], ["subscription.halted", "Begin alternate recovery"],
  ["subscription.charged", "Verify subscription recovery"], ["subscription.activated", "Close subscription case"],
  ["payment_link.paid", "Verify full recovered amount"], ["payment_link.partially_paid", "Track cumulative recovery"],
  ["payment_link.expired", "Exhaust bounded intervention"], ["payment_link.cancelled", "Cancel intervention"]
] as const;

type Snapshot = {
  config: PublicConfig;
  metrics: Metrics;
  cases: RecoveryCase[];
  audit: AuditEntry[];
  events: EventSummary[];
  scenarios: DemoScenario[];
  scenarioRuns: ScenarioRunSummary[];
  razorpayTestLab: RazorpayTestLab;
  revenue: RevenueSnapshot;
};

type RazorpayCheckoutSuccess = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

type RazorpayCheckoutInstance = {
  open(): void;
  on(event: "payment.failed", handler: (response: { error?: { description?: string } }) => void): void;
};

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => RazorpayCheckoutInstance;
  }
}

const notificationStorageKey = "payarc:read-case-notifications";
const maxStoredNotificationKeys = 500;

function readStoredNotificationKeys(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(notificationStorageKey) ?? "[]");
    return new Set(Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").slice(-maxStoredNotificationKeys)
      : []);
  } catch {
    return new Set();
  }
}

async function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Unable to load Razorpay Checkout")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load Razorpay Checkout"));
    document.head.appendChild(script);
  });
  if (!window.Razorpay) throw new Error("Razorpay Checkout did not initialize");
}

function formatMoney(amount: number | null | undefined, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format((amount ?? 0) / 100);
}

function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatDate(seconds: number | null | undefined, withTime = true) {
  if (!seconds) return "—";
  return new Intl.DateTimeFormat("en-IN", withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" }).format(new Date(seconds * 1000));
}

function compactId(value: string | null | undefined, edge = 9) {
  if (!value) return "—";
  return value.length > edge * 2 ? `${value.slice(0, edge)}…${value.slice(-6)}` : value;
}

function humanize(value: string | null | undefined) {
  return value ? value.toLowerCase().split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") : "—";
}

function statusTone(status: string) {
  if (["RECOVERED", "PROCESSED", "SUCCEEDED", "VALID"].includes(status)) return "success";
  if (["HUMAN_REVIEW", "EXHAUSTED", "FAILED", "BROKEN", "BLOCKED", "REJECTED"].includes(status)) return "danger";
  if (["PARTIALLY_RECOVERED", "WAITING", "RETRYING", "PROPOSED"].includes(status)) return "warning";
  return "neutral";
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill ${statusTone(status)}`}><Circle size={7} fill="currentColor" />{humanize(status)}</span>;
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><strong>{title}</strong><span>{detail}</span></div>;
}

function MetricCard({ label, value, hint, icon, tone = "blue" }: { label: string; value: string; hint: string; icon: ReactNode; tone?: string }) {
  return <div className="metric-card panel"><div className={`metric-icon ${tone}`}>{icon}</div><div><span className="metric-label">{label}</span><strong>{value}</strong><small>{hint}</small></div></div>;
}

function MiniAudit({ entries, limit = 8 }: { entries: AuditEntry[]; limit?: number }) {
  if (!entries.length) return <EmptyState icon={<FileClock />} title="No audit activity" detail="Signed events will appear here." />;
  return <div className="audit-list">{entries.slice(0, limit).map((entry) => <div className={`audit-row ${securityKinds.has(entry.kind) ? "security" : ""}`} key={entry.id}>
    <div className="audit-marker">{securityKinds.has(entry.kind) ? <ShieldCheck size={15} /> : <Activity size={15} />}</div>
    <div className="audit-copy"><strong>{humanize(entry.kind)}</strong><span>{entry.actor} · {formatDate(entry.createdAt)}</span></div>
    <code>#{entry.id}</code>
  </div>)}</div>;
}

function CasesTable({ cases, onOpen, compact = false }: { cases: RecoveryCase[]; onOpen: (id: string) => void; compact?: boolean }) {
  if (!cases.length) return <EmptyState icon={<WalletCards />} title="No matching cases" detail="Run a scenario or change your filters." />;
  return <div className="table-scroll"><table className="data-table"><thead><tr>
    <th>Case</th><th>Status</th><th>Failure class</th>{!compact && <th>Cohort</th>}<th>At risk</th><th>Recovered</th><th>Decision</th><th></th>
  </tr></thead><tbody>{cases.map((item) => <tr key={item.id} onClick={() => onOpen(item.id)}>
    <td><div className="primary-cell"><span>{compactId(item.id)}</span><small>{compactId(item.paymentId ?? item.subscriptionId)}</small></div></td>
    <td><StatusPill status={item.status} /></td>
    <td>{humanize(item.failureClass)}</td>
    {!compact && <td><span className={`cohort ${item.cohort.toLowerCase()}`}>{item.cohort}</span></td>}
    <td className="amount">{formatMoney(item.amount, item.currency ?? "INR")}</td>
    <td className="amount recovered">{formatMoney(item.recoveredAmount, item.currency ?? "INR")}</td>
    <td>{humanize(item.recommendedAction)}</td>
    <td><button className="icon-button subtle" aria-label={`Open ${item.id}`}><ChevronRight size={16} /></button></td>
  </tr>)}</tbody></table></div>;
}

function CaseDrawer({ detail, providerMode, whatsappMode, busy, onClose, onAction }: {
  detail: CaseDetail;
  providerMode: PublicConfig["paymentProviderMode"];
  whatsappMode: PublicConfig["whatsappMode"];
  busy: boolean;
  onClose: () => void;
  onAction: (label: string, action: () => Promise<unknown>) => void;
}) {
  const item = detail.case;
  const activeAction = detail.actions[0];
  const latestWhatsApp = detail.deliveries.find((delivery) => delivery.channel === "WHATSAPP");
  const [whatsappOpen, setWhatsAppOpen] = useState(false);
  const [whatsappConsent, setWhatsAppConsent] = useState(false);
  const [whatsappBusy, setWhatsAppBusy] = useState(false);
  const [readinessBusy, setReadinessBusy] = useState(false);
  const [channelReadiness, setChannelReadiness] = useState<ChannelReadiness | null>(detail.channelReadiness);
  const [whatsappResult, setWhatsAppResult] = useState<WhatsAppDelivery | null>(null);
  const [whatsappError, setWhatsAppError] = useState<string | null>(null);
  useEffect(() => {
    setChannelReadiness(detail.channelReadiness);
    setWhatsAppOpen(false);
    setWhatsAppConsent(false);
    setWhatsAppResult(null);
    setWhatsAppError(null);
  }, [detail.case.id, activeAction?.id]);
  const suppressible = !["RECOVERED", "SUPPRESSED", "EXHAUSTED"].includes(item.status);
  const pausable = ["DETECTED", "PLANNED", "WAITING", "HUMAN_REVIEW", "ACTIONED", "PARTIALLY_RECOVERED"].includes(item.status);
  const pathDecision = activeAction?.type === "REUSE_EXISTING_CHECKOUT"
    ? "Reuse the original Razorpay checkout; no duplicate link"
    : activeAction?.type === "WAIT_FOR_PROVIDER_RETRY"
      ? "Observe the provider retry; no customer interruption"
      : activeAction?.type === "SEND_RECOVERY_LINK"
        ? "Bounded replacement only after no reusable checkout was found"
        : activeAction?.type === "SUPPRESS_CONTACT" || activeAction?.type === "ESCALATE_TO_HUMAN"
          ? "No automated customer contact"
          : "Safest eligible path selected from the recovery hierarchy";
  const causalProof = item.cohort === "CONTROL"
    ? "Holdout: measure what recovers naturally without intervention"
    : "Treatment: attribute lift against the deterministic holdout cohort";
  const safetyEnvelope = activeAction?.policy.authoritative.expiresAt
    ? `${formatMoney(activeAction.policy.authoritative.amount, activeAction.policy.authoritative.currency ?? "INR")} verified · expires ${formatDate(activeAction.policy.authoritative.expiresAt)}`
    : "Signed evidence · deterministic policy · stopping rules";
  const prepareWhatsApp = async () => {
    if (!activeAction) return;
    setWhatsAppBusy(true);
    setWhatsAppError(null);
    try { setWhatsAppResult(await api.whatsapp(activeAction.id)); }
    catch (caught) { setWhatsAppError(caught instanceof Error ? caught.message : "WhatsApp delivery failed"); }
    finally { setWhatsAppBusy(false); }
  };
  const toggleWhatsApp = async () => {
    const next = !whatsappOpen;
    setWhatsAppOpen(next);
    if (!next || !activeAction || channelReadiness || readinessBusy) return;
    setReadinessBusy(true);
    setWhatsAppError(null);
    try { setChannelReadiness(await api.channelReadiness(activeAction.id)); }
    catch (caught) { setWhatsAppError(caught instanceof Error ? caught.message : "Unable to resolve the trusted contact"); }
    finally { setReadinessBusy(false); }
  };
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="case-drawer">
      <div className="drawer-head"><div><span className="overline">Recovery case</span><h2>{compactId(item.id, 12)}</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
      <div className="drawer-summary"><StatusPill status={item.status} /><div><strong>{formatMoney(item.amount, item.currency ?? "INR")}</strong><span>at risk</span></div><div><strong className="green-text">{formatMoney(item.recoveredAmount, item.currency ?? "INR")}</strong><span>recovered</span></div></div>

      <section className="drawer-section"><h3>Failure evidence</h3><div className="fact-grid">
        <div><span>Classification</span><strong>{humanize(item.failureClass)}</strong></div><div><span>Reason</span><strong>{humanize(item.errorReason)}</strong></div>
        <div><span>Source</span><strong>{humanize(item.errorSource)}</strong></div><div><span>Entity</span><strong>{humanize(item.entityType)}</strong></div>
        <div><span>Cohort</span><strong>{item.cohort}</strong></div><div><span>Last event</span><strong>{formatDate(item.latestEventAt)}</strong></div>
      </div></section>

      <section className="drawer-section"><div className="section-row"><div><span className="innovation-label">PayArc innovation</span><h3>Recovery Decision Passport</h3></div>{activeAction && <StatusPill status={activeAction.status} />}</div>
        {activeAction ? <><div className="decision-passport"><div><TrendingUp/><span>Causal proof</span><strong>{causalProof}</strong></div><div><Route/><span>Path conservation</span><strong>{pathDecision}</strong></div><div><ShieldCheck/><span>Safety envelope</span><strong>{safetyEnvelope}</strong></div></div><div className="decision-card"><div className="decision-title"><Bot size={18} /><strong>{humanize(activeAction.type)}</strong><span>{Math.round(activeAction.decision.confidence * 100)}% confidence</span></div><p>{activeAction.decision.reason}</p><div className="policy-line"><ShieldCheck size={15} /><span>{activeAction.policy.allowed ? "Deterministic policy checks passed" : activeAction.policy.reasons.join("; ")}</span></div>{activeAction.error && <div className="action-error"><AlertTriangle size={15}/><span>{activeAction.error}</span></div>}{activeAction.providerUrl && <div className="provider-link"><a href={activeAction.providerUrl} target="_blank" rel="noreferrer">Open Razorpay Payment Link <ExternalLink size={13} /></a><button className="secondary-button" onClick={() => void navigator.clipboard.writeText(activeAction.providerUrl!)}><Copy size={13}/>Copy link</button></div>}</div></> : <EmptyState icon={<Bot />} title="No intervention" detail="This case has no active action." />}
        <div className="action-grid">
          {activeAction?.status === "PROPOSED" && <button disabled={busy} onClick={() => onAction("Action approved", () => api.approve(activeAction.id))}><Check size={16} />Approve</button>}
          {activeAction?.status === "APPROVED" && <button disabled={busy} onClick={() => onAction("Action executed", () => api.execute(activeAction.id))}><Zap size={16} />Execute</button>}
          {activeAction?.status === "FAILED" && <button disabled={busy} onClick={() => onAction("Execution retried", () => api.execute(activeAction.id))}><RefreshCw size={16} />Retry execution</button>}
          {activeAction?.status === "SUCCEEDED" && activeAction.providerReference && providerMode === "mock" && <><button disabled={busy} onClick={() => onAction("Full payment verified", () => api.pay(activeAction.id))}><CreditCard size={16} />Pay in full</button><button className="secondary-button" disabled={busy} onClick={() => onAction("Partial payment verified", () => api.pay(activeAction.id, Math.max(1, Math.floor((item.amount ?? 100) * .25))))}><IndianRupee size={16} />Pay 25%</button></>}
          {activeAction?.status === "SUCCEEDED" && activeAction.providerReference && providerMode === "razorpay" && <span className="awaiting-outcome"><Radio size={16}/>Awaiting signed Razorpay payment webhook</span>}
          {activeAction?.status === "SUCCEEDED" && activeAction.providerUrl && suppressible && !latestWhatsApp && <button className="whatsapp-button" disabled={busy} onClick={() => void toggleWhatsApp()}><Send size={16}/>WhatsApp delivery</button>}
          {pausable && <button className="secondary-button" disabled={busy} onClick={() => onAction("Case paused for 24 hours", () => api.pause(item.id, Math.floor(Date.now() / 1000) + 86_400))}><Pause size={16} />Pause 24h</button>}
          {suppressible && <button className="danger-button" disabled={busy} onClick={() => onAction("Customer contact suppressed", () => api.suppress(item.id))}><X size={16} />Suppress</button>}
        </div>
        {latestWhatsApp && <div className={`channel-proof ${latestWhatsApp.status.toLowerCase()}`}><Send size={15}/><div><strong>WhatsApp {humanize(latestWhatsApp.status)}</strong><span>{humanize(latestWhatsApp.mode)} · {formatDate(latestWhatsApp.updatedAt)}</span></div>{latestWhatsApp.providerReference && <code>{compactId(latestWhatsApp.providerReference)}</code>}</div>}
        {whatsappOpen && <div className="whatsapp-composer"><div><strong>Trusted Razorpay contact</strong><span>PayArc resolves the number only when needed and stores only a keyed hash.</span></div>{readinessBusy ? <div className="readiness-loading"><RefreshCw className="spin" size={16}/><span>Checking contact and opt-in with Razorpay…</span></div> : <><div className="channel-readiness"><div><span>Contact</span><strong>{channelReadiness?.maskedContact ?? "Not available"}</strong></div><div><span>Source</span><strong>{humanize(channelReadiness?.contactSource)}</strong></div><div><span>Opt-in proof</span><strong>{channelReadiness?.consentVerified ? humanize(channelReadiness.consentSource) : "Not found"}</strong></div></div>{channelReadiness?.reasons.map((reason) => <div className="readiness-reason" key={reason}><AlertTriangle size={13}/>{reason}</div>)}{!channelReadiness?.consentVerified && <label className="consent-check"><input type="checkbox" checked={whatsappConsent} onChange={(event) => setWhatsAppConsent(event.target.checked)}/><span>I verified the customer explicitly opted in. Use this only when checkout did not write the consent note.</span></label>}<button disabled={whatsappBusy || !channelReadiness?.maskedContact || !(channelReadiness.consentVerified || whatsappConsent)} onClick={() => void prepareWhatsApp()}><Send size={15}/>{whatsappBusy ? "Resolving and sending…" : whatsappMode === "cloud_api" ? "Send approved template" : "Prepare verified WhatsApp message"}</button></>}{whatsappError && <div className="action-error"><AlertTriangle size={15}/><span>{whatsappError}</span></div>}{whatsappResult?.deliveryUrl && <a className="open-whatsapp" href={whatsappResult.deliveryUrl} target="_blank" rel="noreferrer">Open prepared WhatsApp message <ExternalLink size={14}/></a>}{whatsappResult?.delivery.status === "SENT" && <div className="whatsapp-sent"><CheckCircle2 size={15}/>Message accepted by WhatsApp · {compactId(whatsappResult.delivery.providerReference)}</div>}</div>}
      </section>

      <section className="drawer-section"><h3>Audit timeline</h3><MiniAudit entries={[...detail.audit].reverse()} limit={20} /></section>
    </aside>
  </div>;
}

function Overview({ data, onView, onOpenCase }: { data: Snapshot; onView: (view: ViewId) => void; onOpenCase: (id: string) => void }) {
  const openCases = data.cases.filter((item) => !["RECOVERED", "SUPPRESSED"].includes(item.status));
  const actionCases = openCases.filter((item) => ["ACTION_REQUIRED", "HUMAN_REVIEW", "PARTIALLY_RECOVERED"].includes(item.status));
  const recoveredCases = data.cases.filter((item) => item.status === "RECOVERED").length;
  return <>
    <div className="merchant-page-head"><div><h2>Revenue recovery</h2><p>PayArc monitors failed payments and handles eligible recovery automatically. You only review exceptions.</p></div><div className={`autopilot-state ${data.config.autoActionsEnabled ? "on" : "off"}`}><i/><div><strong>{data.config.autoActionsEnabled ? "Autopilot active" : "Manual approval mode"}</strong><span>{data.config.autoActionsEnabled ? "Low-risk actions execute automatically" : "Every action waits for an operator"}</span></div></div></div>
    <div className="metric-grid four merchant-metrics">
      <MetricCard label="Revenue at risk" value={formatMoney(data.revenue.metrics.totalAtRisk)} hint="Across active obligations" icon={<IndianRupee />} tone="blue" />
      <MetricCard label="Recovered" value={formatMoney(data.revenue.metrics.grossRecovered)} hint={`${formatMoney(data.revenue.metrics.incrementalRecovered)} incremental`} icon={<TrendingUp />} tone="green" />
      <MetricCard label="Recovered cases" value={String(recoveredCases)} hint="Verified by signed payment events" icon={<CheckCircle2 />} tone="violet" />
      <MetricCard label="Needs attention" value={String(actionCases.length)} hint="Only exceptions reach the merchant" icon={<AlertTriangle />} tone={actionCases.length ? "amber" : "green"} />
    </div>
    <section className="panel automation-strip"><div><Radio/><span>Events</span><strong>Live</strong></div><ChevronRight/><div><Bot/><span>Decisions</span><strong>{data.config.autoActionsEnabled ? "Automatic" : "Approval gated"}</strong></div><ChevronRight/><div><Zap/><span>Capacity</span><strong>{data.config.workerConcurrency} workers · {data.config.workerBatchSize}/batch</strong></div><ChevronRight/><div><Send/><span>WhatsApp</span><strong>{data.config.whatsappMode === "cloud_api" && data.config.whatsappAutoSendEnabled ? "Auto-send" : data.config.whatsappAutoSendEnabled ? "Auto-prepare" : "Manual fallback"}</strong></div><button onClick={() => onView("integrations")}>View controls</button></section>
    <div className="merchant-overview-grid">
      <section className="panel recent-recoveries"><div className="panel-heading"><div><span className="overline">Latest activity</span><h3>Recent recovery cases</h3></div><button className="text-button" onClick={() => onView("cases")}>View all <ChevronRight size={15}/></button></div><CasesTable cases={data.cases.slice(0, 8)} onOpen={onOpenCase} compact /></section>
      <section className="panel action-centre"><div className="panel-heading"><div><span className="overline">Exceptions only</span><h3>Needs your attention</h3></div><span className="count-badge">{actionCases.length}</span></div>{actionCases.slice(0, 6).map((item) => <button className="queue-row" onClick={() => onOpenCase(item.id)} key={item.id}><div className={`queue-icon ${item.status === "HUMAN_REVIEW" ? "red" : "blue"}`}>{item.status === "HUMAN_REVIEW" ? <ShieldCheck size={17}/> : <Zap size={17}/>}</div><div><strong>{humanize(item.status)}</strong><span>{formatMoney(item.amount)} · {humanize(item.failureClass)}</span></div><ChevronRight size={16}/></button>)}{!actionCases.length && <EmptyState icon={<CheckCircle2 />} title="Nothing to review" detail="PayArc is handling eligible recovery automatically." />}</section>
    </div>
  </>;
}

function CasesView({ cases, onOpen }: { cases: RecoveryCase[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("ALL");
  const filters = ["ALL", "ACTION_REQUIRED", "HUMAN_REVIEW", "WAITING", "PARTIALLY_RECOVERED", "RECOVERED"];
  const filtered = cases.filter((item) => (filter === "ALL" || item.status === filter) && [item.id, item.paymentId, item.subscriptionId, item.failureClass, item.recommendedAction].some((value) => value?.toLowerCase().includes(query.toLowerCase())));
  return <section className="panel page-panel cases-panel"><div className="table-toolbar"><div className="segmented">{filters.map((item) => <button className={filter === item ? "active" : ""} onClick={() => setFilter(item)} key={item}>{humanize(item)}<span>{item === "ALL" ? cases.length : cases.filter((entry) => entry.status === item).length}</span></button>)}</div><label className="field-search"><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search case, payment, or failure"/></label></div><div className="table-meta"><span>{filtered.length} cases</span><span>Amounts shown in currency units</span></div><CasesTable cases={filtered} onOpen={onOpen}/></section>;
}

function ScenariosView({ scenarios, history, testLab, runningId, realTestBusy, onRun, onInspect, onLaunchReal, onOpenCheckout, onOpenCase }: {
  scenarios: DemoScenario[];
  history: ScenarioRunSummary[];
  testLab: RazorpayTestLab;
  runningId: string | null;
  realTestBusy: boolean;
  onRun: (scenario: DemoScenario) => void;
  onInspect: (runId: string) => void;
  onLaunchReal: (amount: number) => void;
  onOpenCheckout: (run: RazorpayTestRun) => void;
  onOpenCase: (caseId: string) => void;
}) {
  const [category, setCategory] = useState("All");
  const [amountRupees, setAmountRupees] = useState("989");
  const categories = ["All", ...new Set(scenarios.map((item) => item.category))];
  const filtered = category === "All" ? scenarios : scenarios.filter((item) => item.category === category);
  const amountPaise = Math.round(Number(amountRupees) * 100);
  return <>
    <section className={`real-test-lab panel ${testLab.available ? "connected" : "unavailable"}`}>
      <div className="real-test-main"><div className="real-test-heading"><div className="integration-logo razorpay-mark"><CreditCard/></div><div><span className="overline">Genuine provider proof</span><h2>Razorpay Test Mode Checkout</h2><p>Create a real Razorpay Order, choose <strong>Failure</strong> in hosted Checkout, and watch the signed webhook create a merchant Recovery Case automatically.</p></div><StatusPill status={testLab.available ? "CONNECTED" : "NOT_CONNECTED"}/></div>
        {testLab.available ? <><div className="real-test-form"><label><span>Test amount</span><div><IndianRupee size={16}/><input inputMode="decimal" min="1" max="100000" value={amountRupees} onChange={(event) => setAmountRupees(event.target.value)} aria-label="Test amount in rupees"/></div></label><button disabled={realTestBusy || !Number.isFinite(amountPaise) || amountPaise < 100} onClick={() => onLaunchReal(amountPaise)}>{realTestBusy ? <><RefreshCw className="spin"/>Creating order…</> : <><ExternalLink/>Launch real test checkout</>}</button></div><div className="real-test-flow"><div><i>1</i><span><strong>Secure Order</strong>Server creates an exact-value Test Order.</span></div><ChevronRight/><div><i>2</i><span><strong>Select Failure</strong>Razorpay produces a real failed attempt.</span></div><ChevronRight/><div><i>3</i><span><strong>Signed webhook</strong>PayArc verifies and processes the event.</span></div><ChevronRight/><div><i>4</i><span><strong>Recovery Case</strong>The case appears in the merchant queue.</span></div></div></> : <div className="real-test-unavailable"><AlertTriangle/><div><strong>Razorpay Test Mode is not connected</strong><span>{testLab.reason}</span></div></div>}
      </div>
      <aside className="real-test-runs"><div className="section-row"><div><span className="overline">Provider-backed runs</span><h3>Recent checkout proofs</h3></div><span className="count-badge">{testLab.runs.length}</span></div>{testLab.runs.length ? <div>{testLab.runs.slice(0, 6).map((run) => <article key={run.id}><div className="run-status"><StatusPill status={run.caseStatus ?? run.status}/><time>{formatDate(run.createdAt)}</time></div><strong>{formatMoney(run.amount, run.currency)}</strong><code>{compactId(run.providerOrderId, 10)}</code><div className="run-actions">{run.caseId ? <button className="primary-link" onClick={() => onOpenCase(run.caseId!)}><WalletCards/>Open Recovery Case</button> : run.status === "FAILURE_RECEIVED" ? <span className="processing-note"><RefreshCw className="spin"/>Building case from webhook…</span> : run.status !== "PAYMENT_SUCCEEDED" ? <button onClick={() => onOpenCheckout(run)}><ExternalLink/>Open Checkout</button> : <span className="complete-note"><CheckCircle2/>Payment verified</span>}</div></article>)}</div> : <div className="real-test-empty"><Webhook/><span>No real checkout run yet.</span></div>}</aside>
    </section>
    <div className="lab-banner panel"><div className="lab-icon"><TestTube2 /></div><div><span className="overline">Controlled simulation suite</span><h3>Exercise conditions providers cannot expose on demand</h3><p>Outages, replay attacks, forged signatures and lifecycle edge cases stay in a separate ledger. They prove resilience without being presented as real Razorpay transactions.</p></div><div className="lab-stats"><strong>{scenarios.length}</strong><span>deterministic flows</span></div></div>
    <div className="category-tabs">{categories.map((item) => <button className={category === item ? "active" : ""} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div>
    <div className="scenario-list panel">{filtered.map((scenario) => <article className="scenario-row" key={scenario.id}><div className={`scenario-icon accent-${scenario.accent}`}>{scenario.category === "Resilience & security" ? <ShieldCheck/> : scenario.category === "Subscriptions" ? <RefreshCw/> : scenario.category === "Recovery lifecycle" ? <TrendingUp/> : <CreditCard/>}</div><div className="scenario-copy"><strong>{scenario.title}</strong><span>{scenario.description}</span></div><div className="scenario-events"><span>Event flow</span><div>{scenario.events.map((event, index) => <code key={`${event}-${index}`}>{event}</code>)}</div></div><div className="scenario-expect"><span>Expected</span><strong>{scenario.expected}</strong></div><button disabled={Boolean(runningId)} onClick={() => onRun(scenario)}>{runningId === scenario.id ? <><RefreshCw className="spin" size={15}/>Running…</> : <><Play size={15}/>Run</>}</button></article>)}</div>
    {!scenarios.length && <div className="panel"><EmptyState icon={<FlaskConical/>} title="Scenario Lab unavailable" detail="Scenario fixtures are disabled in production."/></div>}
    <section className="panel scenario-history"><div className="panel-heading"><div><span className="overline">Sandbox ledger</span><h3>Scenario run history</h3><p>Inspectable traces remain isolated from merchant cases and analytics.</p></div><span className="count-badge">{history.length}</span></div>{history.length ? <div className="scenario-history-list">{history.map((run) => <button onClick={() => onInspect(run.runId)} key={run.runId}><i className={`accent-${run.accent}`}/><div className="history-main"><strong>{run.title}</strong><span>{run.observed}</span></div><div><span>Outcome</span><StatusPill status={run.outcome}/></div><div><span>Evidence</span><strong>{run.eventCount} events · {run.auditProofCount} proofs</strong></div><time>{formatDate(run.ranAt)}</time><ChevronRight size={17}/></button>)}</div> : <EmptyState icon={<FileClock/>} title="No sandbox runs yet" detail="Run any scenario above; its complete trace will appear here."/>}</section>
  </>;
}

function ScenarioTraceDrawer({ run, onClose }: { run: ScenarioResult; onClose: () => void }) {
  const outcome = run.case?.status ?? (run.security.signatureRejected ? "REJECTED" : "NO_CASE");
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="case-drawer scenario-trace-drawer">
      <div className="drawer-head"><div><span className="overline">Isolated sandbox trace</span><h2>{run.scenario.title}</h2></div><button className="icon-button" onClick={onClose}><X size={19}/></button></div>
      <div className="trace-summary"><div><StatusPill status={outcome}/><span>{run.observed}</span></div><time>{formatDate(run.ranAt)}</time></div>
      <div className="trace-metrics"><div><span>Signed events</span><strong>{run.eventTrace.length}</strong></div><div><span>Worker passes</span><strong>{run.workerRuns.length}</strong></div><div><span>Actions</span><strong>{run.actions.length}</strong></div><div><span>Audit proofs</span><strong>{run.recentAudit.length}</strong></div></div>

      <section className="drawer-section"><div className="section-row"><div><span className="innovation-label">Ingress boundary</span><h3>Signed event trace</h3></div><span className="sandbox-chip">Sandbox only</span></div>{run.eventTrace.length ? <div className="trace-events">{run.eventTrace.map((event, index) => <div key={event.id}><i>{index + 1}</i><div><strong>{event.type}</strong><span>{humanize(event.entityType)} · {compactId(event.entityId)}</span></div><StatusPill status={event.status}/><code>{event.payloadHash.slice(0, 10)}…</code></div>)}</div> : <div className="trace-empty"><ShieldCheck/><div><strong>No event was persisted</strong><span>The forged signature was rejected before ingestion, which is the expected security outcome.</span></div></div>}</section>

      <section className="drawer-section"><div className="section-row"><div><span className="innovation-label">Decision boundary</span><h3>Policy and actions</h3></div></div>{run.case && <div className="trace-case"><div><span>Sandbox case</span><strong>{compactId(run.case.id, 12)}</strong></div><div><span>Failure class</span><strong>{humanize(run.case.failureClass)}</strong></div><div><span>At risk</span><strong>{formatMoney(run.case.amount, run.case.currency ?? "INR")}</strong></div><div><span>Recovered</span><strong className="green-text">{formatMoney(run.case.recoveredAmount, run.case.currency ?? "INR")}</strong></div></div>}{run.actions.length ? <div className="trace-actions">{run.actions.map((action) => <article key={action.id}><div><Bot size={17}/><strong>{humanize(action.type)}</strong><StatusPill status={action.status}/></div><p>{action.decision.reason}</p><footer><span>{Math.round(action.decision.confidence * 100)}% confidence</span><span>{action.policy.allowed ? "Policy allowed" : action.policy.reasons.join("; ")}</span></footer></article>)}</div> : <div className="trace-empty"><ShieldCheck/><div><strong>No action created</strong><span>The scenario stopped safely before an intervention was authorized.</span></div></div>}</section>

      {Object.keys(run.security).length > 0 && <section className="drawer-section"><div className="section-row"><div><span className="innovation-label">Security assertions</span><h3>Verified controls</h3></div></div><div className="trace-security">{Object.entries(run.security).map(([key, value]) => <div key={key}><span>{humanize(key)}</span><strong>{typeof value === "boolean" ? value ? "Passed" : "Failed" : String(value)}</strong></div>)}</div></section>}

      <section className="drawer-section"><div className="section-row"><div><span className="innovation-label">Tamper-evident evidence</span><h3>Audit timeline</h3></div></div><MiniAudit entries={run.recentAudit} limit={40}/></section>
    </aside>
  </div>;
}

function EventsView({ events, audit }: { events: EventSummary[]; audit: AuditEntry[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const filtered = events.filter((event) => (status === "ALL" || event.status === status) && [event.type, event.providerEventId, event.entityId].some((value) => value.toLowerCase().includes(query.toLowerCase())));
  return <div className="events-layout"><section className="panel page-panel"><div className="panel-heading"><div><span className="overline">Webhook inbox</span><h3>Provider events</h3></div><div className="inline-filters"><label className="field-search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search events"/></label><select value={status} onChange={(e) => setStatus(e.target.value)}><option>ALL</option><option>PROCESSED</option><option>IGNORED</option><option>PENDING</option><option>FAILED</option></select></div></div>{filtered.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Provider event</th><th>Type</th><th>Entity</th><th>Status</th><th>Occurred</th><th>Payload proof</th></tr></thead><tbody>{filtered.map((event) => <tr key={event.id}><td><div className="primary-cell"><span>{compactId(event.providerEventId, 11)}</span><small>Internal #{event.id}</small></div></td><td><code className="event-code">{event.type}</code></td><td><div className="primary-cell"><span>{humanize(event.entityType)}</span><small>{compactId(event.entityId)}</small></div></td><td><StatusPill status={event.status}/></td><td>{formatDate(event.occurredAt)}</td><td><code>{event.payloadHash.slice(0, 12)}…</code></td></tr>)}</tbody></table></div> : <EmptyState icon={<Webhook/>} title="No matching events" detail="Change the filters or run a scenario."/>}</section><aside className="panel audit-panel"><div className="panel-heading"><div><span className="overline">Append-only ledger</span><h3>Audit stream</h3></div><span className="live-indicator"><i/>Live</span></div><MiniAudit entries={audit} limit={40}/></aside></div>;
}

function AnalyticsView({ metrics }: { metrics: Metrics }) {
  const failureData = Object.entries(metrics.byFailureClass).map(([name, item]) => ({ name: humanize(name), cases: item.cases, recovered: item.recoveredAmount / 100, eligible: item.eligibleAmount / 100 }));
  const interventionData = Object.entries(metrics.byIntervention).map(([name, item]) => ({ name: humanize(name), rate: (item.recoveryRate ?? 0) * 100, cases: item.cases }));
  return <><div className="metric-grid four"><MetricCard label="Treatment recovery" value={formatPercent(metrics.treatment.recoveryRate)} hint={`${metrics.treatment.cases} treatment cases`} icon={<TrendingUp/>} tone="green"/><MetricCard label="Control recovery" value={formatPercent(metrics.control.recoveryRate)} hint={`${metrics.control.cases} holdout cases`} icon={<ListFilter/>} tone="blue"/><MetricCard label="Absolute uplift" value={metrics.absoluteRecoveryUplift === null ? "Collecting" : `${(metrics.absoluteRecoveryUplift * 100).toFixed(1)} pp`} hint="Treatment minus control" icon={<ArrowUpRight/>} tone="violet"/><MetricCard label="Average recovery" value={metrics.averageRecoverySeconds === null ? "—" : `${Math.round(metrics.averageRecoverySeconds / 60)} min`} hint="Detection to verified outcome" icon={<Clock3/>} tone="amber"/></div><div className="analytics-grid"><section className="panel chart-panel"><div className="panel-heading"><div><span className="overline">Failure economics</span><h3>Eligible vs recovered revenue</h3></div></div><div className="bar-chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={failureData} layout="vertical" margin={{ left: 18 }}><CartesianGrid horizontal={false} stroke="#edf0f6"/><XAxis type="number" tickFormatter={(value) => `₹${Math.round(Number(value) / 1000)}k`} axisLine={false} tickLine={false}/><YAxis type="category" dataKey="name" width={145} fontSize={11} axisLine={false} tickLine={false}/><Tooltip formatter={(value) => formatMoney(Number(value) * 100)}/><Bar dataKey="eligible" fill="#dce5fa" radius={[0,4,4,0]}/><Bar dataKey="recovered" fill="#10a66a" radius={[0,4,4,0]}/></BarChart></ResponsiveContainer></div></section><section className="panel"><div className="panel-heading"><div><span className="overline">Intervention quality</span><h3>Recovery by decision</h3></div></div><div className="performance-list">{interventionData.map((item) => <div key={item.name}><div><strong>{item.name}</strong><span>{item.cases} cases · {item.rate.toFixed(1)}%</span></div><div className="progress"><i style={{ width: `${Math.max(2, item.rate)}%` }}/></div></div>)}{!interventionData.length && <EmptyState icon={<BarChart3/>} title="No intervention data" detail="Run recovery scenarios to populate analytics."/>}</div></section></div><section className="panel cohort-panel"><div><span className="overline">Experiment integrity</span><h3>Deterministic holdout cohorts</h3><p>Cases are assigned by stable hash, allowing PayArc to measure incremental revenue instead of claiming natural recoveries.</p></div><div className="cohort-comparison"><div><span>Treatment</span><strong>{formatMoney(metrics.treatment.recoveredAmount)}</strong><small>of {formatMoney(metrics.treatment.eligibleAmount)}</small></div><div><span>Control</span><strong>{formatMoney(metrics.control.recoveredAmount)}</strong><small>of {formatMoney(metrics.control.eligibleAmount)}</small></div></div></section></>;
}

function SecurityView({ metrics, audit, scenarios, runningId, onRun, onVerify }: { metrics: Metrics; audit: AuditEntry[]; scenarios: DemoScenario[]; runningId: string | null; onRun: (scenario: DemoScenario) => void; onVerify: () => void }) {
  const ops = metrics.operations;
  const attackScenarios = scenarios.filter((item) => ["prompt-injection", "forged-signature", "duplicate-replay", "stale-failure"].includes(item.id));
  const cards = [["Forged signatures", ops.WEBHOOK_SIGNATURE_REJECTED ?? 0, "Rejected before parsing", <LockKeyhole/>], ["Replay attempts", ops.DUPLICATE_EVENT_IGNORED ?? 0, "Deduplicated atomically", <RefreshCw/>], ["Prompt injections", ops.PROMPT_INJECTION_SIGNAL ?? 0, "Quarantined as telemetry", <Bot/>], ["Stale failures", ops.STALE_FAILURE_IGNORED ?? 0, "Source of truth protected", <FileClock/>]] as const;
  return <><div className={`security-hero ${metrics.audit.valid ? "safe" : "unsafe"}`}><div className="security-shield"><ShieldCheck/></div><div><span className="overline">System integrity</span><h2>{metrics.audit.valid ? "All zero-trust controls operational" : "Audit integrity violation detected"}</h2><p>{metrics.audit.checked} hash-chained records verified. Financial parameters remain outside the AI trust boundary.</p></div><button onClick={onVerify}><RefreshCw size={16}/>Verify chain now</button></div><div className="security-stat-grid">{cards.map(([title, value, detail, icon]) => <div className="panel security-stat" key={title}><div>{icon}</div><strong>{value}</strong><span>{title}</span><small>{detail}</small></div>)}</div><div className="security-layout"><section className="panel"><div className="panel-heading"><div><span className="overline">Adversarial testing</span><h3>Attack simulation suite</h3></div></div><div className="attack-list">{attackScenarios.map((scenario) => <div className="attack-row" key={scenario.id}><div className="attack-icon"><ShieldCheck/></div><div><strong>{scenario.title}</strong><span>{scenario.description}</span></div><button disabled={Boolean(runningId)} onClick={() => onRun(scenario)}>{runningId === scenario.id ? <RefreshCw className="spin"/> : <Play/>}Run</button></div>)}{!attackScenarios.length && <EmptyState icon={<ShieldCheck/>} title="Attack suite unavailable" detail="Enable safe mock mode to run adversarial fixtures."/>}</div></section><section className="panel"><div className="panel-heading"><div><span className="overline">Security telemetry</span><h3>Recent control decisions</h3></div></div><MiniAudit entries={audit.filter((item) => securityKinds.has(item.kind))} limit={20}/></section></div></>;
}

function IntegrationsView({ config }: { config: PublicConfig }) {
  const [copied, setCopied] = useState(false);
  const webhookUrl = `${window.location.origin}/webhooks/razorpay`;
  const copy = async () => { await navigator.clipboard.writeText(webhookUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1500); };
  return <><div className="integration-grid"><section className="panel integration-card"><div className="integration-logo razorpay-mark"><CreditCard/></div><div><span className="overline">Payment provider</span><h3>Razorpay {config.paymentProviderMode === "razorpay" ? "Test Mode" : "Mock Adapter"}</h3><p>{config.paymentProviderMode === "razorpay" ? "Connected to Razorpay test APIs. Live credentials are rejected by configuration." : "Safe local provider with Razorpay-compatible payment and Payment Link contracts."}</p></div><StatusPill status={config.paymentProviderMode === "razorpay" ? "CONNECTED" : "SANDBOX"}/></section><section className="panel integration-card"><div className="integration-logo ai-mark"><Bot/></div><div><span className="overline">Decision provider</span><h3>{config.aiProvider === "openai" ? "OpenAI structured decisions" : "Deterministic engine"}</h3><p>Only minimized failure features cross the boundary; deterministic policy owns amounts and execution.</p></div><StatusPill status={config.aiProvider === "openai" ? "CONNECTED" : "LOCAL"}/></section><section className="panel integration-card"><div className="integration-logo whatsapp-mark"><Send/></div><div><span className="overline">Recovery channel</span><h3>{config.whatsappMode === "cloud_api" ? "WhatsApp Cloud API" : "WhatsApp Click-to-Chat"}</h3><p>{config.whatsappMode === "cloud_api" ? "Resolves the trusted Razorpay contact and auto-sends an approved template when the order contains opt-in proof." : "Resolves the Razorpay contact and prepares the consented message automatically; Cloud API is required for unattended sending."}</p></div><StatusPill status={config.whatsappMode === "cloud_api" && config.whatsappAutoSendEnabled ? "AUTO_SEND" : config.whatsappAutoSendEnabled ? "AUTO_PREPARE" : "MANUAL"}/></section></div><div className="integration-layout"><section className="panel settings-panel"><div className="panel-heading"><div><span className="overline">Webhook endpoint</span><h3>Signed event ingress</h3></div></div><p>Configure this route in the Razorpay Test Mode dashboard using a public HTTPS host and a separate webhook secret.</p><div className="copy-field"><code>{webhookUrl}</code><button onClick={copy}>{copied ? <Check size={15}/> : <Copy size={15}/>}{copied ? "Copied" : "Copy"}</button></div><div className="check-list"><div><CheckCircle2/><span>Raw-body HMAC-SHA256 verification</span></div><div><CheckCircle2/><span>Current and previous secret rotation</span></div><div><CheckCircle2/><span>Atomic provider-event deduplication</span></div><div><CheckCircle2/><span>PII-redacted persistence</span></div></div></section><section className="panel settings-panel"><div className="panel-heading"><div><span className="overline">Runtime guardrails</span><h3>Execution policy</h3></div></div><div className="setting-list"><div><span>External actions</span><StatusPill status={config.externalActionsEnabled ? "ENABLED" : "DISABLED"}/></div><div><span>Low-risk autopilot</span><StatusPill status={config.autoActionsEnabled ? "ENABLED" : "APPROVAL_REQUIRED"}/></div><div><span>WhatsApp automation</span><StatusPill status={config.whatsappAutoSendEnabled ? "ENABLED" : "DISABLED"}/></div><div><span>Worker capacity</span><strong>{config.workerConcurrency} concurrent · {config.workerBatchSize}/batch</strong></div><div><span>Global kill switch</span><StatusPill status={config.globalKillSwitch ? "ENABLED" : "DISABLED"}/></div><div><span>Maximum automatic value</span><strong>{formatMoney(config.maxAutoAmountPaise)}</strong></div><div><span>Control cohort</span><strong>{config.controlCohortPercent}%</strong></div><div><span>Allowed currencies</span><strong>{config.allowedCurrencies.join(", ")}</strong></div></div></section></div><section className="panel events-matrix"><div className="panel-heading"><div><span className="overline">Event coverage</span><h3>Subscribed Razorpay lifecycle</h3></div><span className="count-badge">{supportedEvents.length}</span></div><div className="event-matrix-grid">{supportedEvents.map(([event, behavior]) => <div key={event}><Webhook size={16}/><div><code>{event}</code><span>{behavior}</span></div><CheckCircle2 size={16}/></div>)}</div></section></>;
}

function GuideView({ onView }: { onView: (view: ViewId) => void }) {
  const pages: Array<{ view: ViewId; title: string; purpose: string; action: string }> = [
    { view: "overview", title: "Overview", purpose: "See at-risk, incremental recovered, protected revenue, promises, and audit health.", action: "Monitor the whole portfolio" },
    { view: "portfolio", title: "Recovery Autopilot", purpose: "Rank obligations by expected incremental value after natural recovery and risk costs.", action: "Optimize, review selection, run bounded batch" },
    { view: "incidents", title: "Payment Intelligence", purpose: "Detect provider degradation and stop a retry storm across every affected case.", action: "Resolve evidence, then release traffic in stages" },
    { view: "journeys", title: "Checkout Journeys", purpose: "Distinguish an active customer from a real abandonment and preserve valid checkout paths.", action: "Observe, reuse checkout, or prepare a last-resort path" },
    { view: "subscriptions", title: "Recurring Revenue", purpose: "Respect Razorpay retries and sequence mandate attempts without duplicate-debit risk.", action: "Advance only the next safe step" },
    { view: "receivables", title: "B2B Receivables", purpose: "Resolve invoice blockers before chasing the payer.", action: "Fix blocker, contact, reconcile" },
    { view: "conversations", title: "Promises & Voice", purpose: "Turn Hinglish responses into promises, already-paid claims, UPI preference, or opt-out.", action: "Capture intent and enforce stopping rules" },
    { view: "cases", title: "Recovery Cases", purpose: "Inspect evidence and the Recovery Decision Passport for one obligation.", action: "Approve, execute, share, pause, or suppress" },
    { view: "events", title: "Events & Audit", purpose: "Trace signed Razorpay events through the tamper-evident ledger.", action: "Prove every state transition" },
    { view: "analytics", title: "Analytics", purpose: "Compare treatment with holdout so natural recovery is not falsely claimed.", action: "Measure causal uplift" },
    { view: "security", title: "Security Center", purpose: "Test forged signatures, replay, prompt injection, and audit tampering.", action: "Demonstrate fail-closed controls" },
    { view: "integrations", title: "Integrations", purpose: "Verify Razorpay, webhook, AI, WhatsApp, and execution settings.", action: "Check runtime readiness" }
  ];
  return <div className="guide-page"><section className="guide-hero panel"><div><span className="overline">Start here</span><h2>PayArc in one sentence</h2><p>It watches every revenue obligation, chooses the least disruptive safe intervention, delivers it through a consented channel, stops when it should, and proves how much money the intervention—not chance—recovered.</p></div><button onClick={() => onView("cases")}><WalletCards/>Open a recovery case</button></section><section className="panel demo-playbook"><div className="panel-heading"><div><span className="overline">Judge demo</span><h3>Seven-minute winning flow</h3></div></div><div className="demo-steps">{[
    ["1", "Fail ₹989", "Complete a failed Razorpay Test Mode attempt; the signed webhook creates a case."],
    ["2", "Watch live sync", "Keep Recovery Cases open. The case appears and changes without refreshing."],
    ["3", "Inspect the passport", "Explain causal proof, path conservation, and the exact safety envelope."],
    ["4", "Execute the safe path", "Approve only if required. Execute creates or reuses one bounded Razorpay path."],
    ["5", "Share with consent", "Prepare the WhatsApp message; the number is not stored in plaintext."],
    ["6", "Pay", "Complete Test Mode payment from Razorpay. The signed paid webhook closes the case live."],
    ["7", "Prove the result", "Show recovered amount, treatment-vs-holdout uplift, and the hash-chained audit."],
  ].map(([step, title, text]) => <div key={step}><i>{step}</i><div><strong>{title}</strong><span>{text}</span></div></div>)}</div></section><section className="panel feature-manual"><div className="panel-heading"><div><span className="overline">Feature manual</span><h3>What every page does</h3></div></div><div className="guide-grid">{pages.map((page) => <button key={page.view} onClick={() => onView(page.view)}><div><strong>{page.title}</strong><span>{page.purpose}</span><small>{page.action}</small></div><ChevronRight/></button>)}</div></section></div>;
}

export function App() {
  const [view, setView] = useState<ViewId>(() => readRoute().view);
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedCase, setSelectedCase] = useState<CaseDetail | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [realTestBusy, setRealTestBusy] = useState(false);
  const [scenarioResult, setScenarioResult] = useState<ScenarioResult | null>(null);
  const [scenarioTrace, setScenarioTrace] = useState<ScenarioResult | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "danger" } | null>(null);
  const [operatorToken, setOperatorToken] = useState("");
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("connecting");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [readNotificationKeys, setReadNotificationKeys] = useState<Set<string>>(readStoredNotificationKeys);

  useEffect(() => {
    try {
      window.localStorage.setItem(notificationStorageKey, JSON.stringify([...readNotificationKeys].slice(-maxStoredNotificationKeys)));
    } catch {
      // The dashboard remains usable when storage is disabled or full.
    }
  }, [readNotificationKeys]);

  const notify = useCallback((message: string, tone: "success" | "danger" = "success") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 3500);
  }, []);

  const switchView = useCallback((next: ViewId) => {
    setView(next);
    setSelectedCase(null);
    setMobileNav(false);
    setNotificationsOpen(false);
    setAccountOpen(false);
    writeRoute(next, null);
  }, []);

  const reload = useCallback(async (silent = false) => {
    silent ? setRefreshing(true) : setLoading(true);
    try {
      const config = await api.config();
      const [metrics, cases, audit, events, revenue, razorpayTestLab] = await Promise.all([api.metrics(), api.cases(), api.audit(), api.events(), api.revenue(), api.razorpayTestRuns()]);
      let scenarios: DemoScenario[] = [];
      let scenarioRuns: ScenarioRunSummary[] = [];
      if (config.nodeEnv !== "production") {
        const [catalog, history] = await Promise.all([api.scenarios(), api.scenarioRuns()]);
        scenarios = catalog.scenarios;
        scenarioRuns = history.runs;
      }
      setData({ config, metrics, cases, audit, events, scenarios, scenarioRuns, razorpayTestLab, revenue });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load dashboard");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const markNotificationRead = useCallback((item: RecoveryCase) => {
    if (!isNotifiableCase(item)) return;
    const key = notificationRevisionKey(item);
    setReadNotificationKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      while (next.size > maxStoredNotificationKeys) {
        const oldest = next.values().next().value;
        if (typeof oldest !== "string") break;
        next.delete(oldest);
      }
      return next;
    });
  }, []);

  const openCase = useCallback(async (id: string, updateUrl = true) => {
    const summary = data?.cases.find((item) => item.id === id);
    try {
      const detail = await api.caseDetail(id);
      setSelectedCase(detail);
      if (summary) markNotificationRead(summary);
      if (updateUrl) writeRoute(view, id);
    } catch (caught) { notify(caught instanceof Error ? caught.message : "Unable to open case", "danger"); }
  }, [data?.cases, markNotificationRead, notify, view]);

  const closeCase = useCallback(() => {
    setSelectedCase(null);
    writeRoute(view, null);
  }, [view]);

  useEffect(() => {
    const route = readRoute();
    if (data && route.caseId && selectedCase?.case.id !== route.caseId) void openCase(route.caseId, false);
  }, [data, openCase, selectedCase?.case.id]);

  useEffect(() => {
    const onPopState = () => {
      const route = readRoute();
      setView(route.view);
      route.caseId ? void openCase(route.caseId, false) : setSelectedCase(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openCase]);

  useEffect(() => {
    if (!data || error) return;
    let syncing = false;
    let queued = false;
    const synchronize = async () => {
      if (syncing) { queued = true; return; }
      syncing = true;
      try {
        do {
          queued = false;
          await reload(true);
          const caseId = readRoute().caseId;
          if (caseId) setSelectedCase(await api.caseDetail(caseId));
          setLastSyncedAt(Date.now());
        } while (queued);
      } finally { syncing = false; }
    };
    return api.subscribeRealtime(() => void synchronize(), setRealtimeState);
  }, [Boolean(data), error, reload]);

  const refreshSelected = useCallback(async () => {
    if (selectedCase) setSelectedCase(await api.caseDetail(selectedCase.case.id));
  }, [selectedCase]);

  const caseAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setDrawerBusy(true);
    try { await action(); await reload(true); await refreshSelected(); notify(label); }
    catch (caught) { notify(caught instanceof Error ? caught.message : "Operation failed", "danger"); }
    finally { setDrawerBusy(false); }
  }, [notify, refreshSelected, reload]);

  const revenueAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setDrawerBusy(true);
    try { await action(); await reload(true); notify(label); }
    catch (caught) { notify(caught instanceof Error ? caught.message : "Operation failed", "danger"); }
    finally { setDrawerBusy(false); }
  }, [notify, reload]);

  const runScenario = useCallback(async (scenario: DemoScenario) => {
    setRunningId(scenario.id);
    try { const result = await api.runScenario(scenario.id); setScenarioResult(result); notify(`${scenario.title}: ${result.observed}`); await reload(true); }
    catch (caught) { notify(caught instanceof Error ? caught.message : "Scenario failed", "danger"); }
    finally { setRunningId(null); }
  }, [notify, reload]);

  const inspectScenarioRun = useCallback(async (runId: string) => {
    try { setScenarioTrace(await api.scenarioRun(runId)); }
    catch (caught) { notify(caught instanceof Error ? caught.message : "Unable to load scenario trace", "danger"); }
  }, [notify]);

  const openRazorpayTestCheckout = useCallback(async (run: RazorpayTestRun, keyOverride?: string) => {
    const keyId = keyOverride ?? data?.razorpayTestLab.checkoutKeyId;
    if (!keyId) { notify("Razorpay Test Mode checkout key is unavailable", "danger"); return; }
    try {
      await loadRazorpayCheckout();
      const Checkout = window.Razorpay;
      if (!Checkout) throw new Error("Razorpay Checkout did not initialize");
      const checkout = new Checkout({
        key: keyId,
        amount: run.amount,
        currency: run.currency,
        name: "PayArc Test Merchant",
        description: run.description,
        order_id: run.providerOrderId,
        prefill: { name: "Test Customer", email: "customer@example.test", contact: "+919000090000" },
        notes: { payarc_test_run: run.id },
        theme: { color: "#2368e8" },
        retry: { enabled: true, max_count: 3 },
        modal: { ondismiss: () => void reload(true) },
        handler: async (response: RazorpayCheckoutSuccess) => {
          try {
            await api.verifyRazorpayTestRun(run.id, response.razorpay_payment_id, response.razorpay_order_id, response.razorpay_signature);
            notify("Razorpay payment signature and provider state verified. Successful payments do not create recovery cases.");
            await reload(true);
          } catch (caught) {
            notify(caught instanceof Error ? caught.message : "Unable to verify Razorpay payment", "danger");
          }
        }
      });
      checkout.on("payment.failed", (response) => {
        notify(response.error?.description ? `Razorpay failure received: ${response.error.description}. Waiting for the signed webhook.` : "Razorpay failure received. Waiting for the signed webhook.");
        window.setTimeout(() => void reload(true), 1_200);
      });
      checkout.open();
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to open Razorpay Checkout", "danger");
    }
  }, [data?.razorpayTestLab.checkoutKeyId, notify, reload]);

  const launchRazorpayTest = useCallback(async (amount: number) => {
    setRealTestBusy(true);
    try {
      const created = await api.createRazorpayTestRun(amount, "PayArc signed failure-to-recovery proof");
      await reload(true);
      await openRazorpayTestCheckout(created.run, created.checkoutKeyId);
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : "Unable to create Razorpay Test Run", "danger");
    } finally {
      setRealTestBusy(false);
    }
  }, [notify, openRazorpayTestCheckout, reload]);

  const verifyAudit = useCallback(async () => {
    try { const result = await api.verifyAudit(); notify(result.valid ? `Audit chain valid: ${result.checked} records` : `Audit chain broken at record ${result.brokenAt}`, result.valid ? "success" : "danger"); await reload(true); }
    catch (caught) { notify(caught instanceof Error ? caught.message : "Verification failed", "danger"); }
  }, [notify, reload]);

  const notifications = useMemo(
    () => caseNotificationState(data?.cases ?? [], readNotificationKeys),
    [data?.cases, readNotificationKeys]
  );
  const notificationCases = notifications.actionable;
  const unreadNotificationCases = notifications.unread;
  const unreadNotificationIds = useMemo(
    () => new Set(unreadNotificationCases.map((item) => item.id)),
    [unreadNotificationCases]
  );
  const markAllNotificationsRead = useCallback(() => {
    setReadNotificationKeys((current) => {
      const next = new Set(current);
      for (const item of notifications.open) next.add(notificationRevisionKey(item));
      return next;
    });
  }, [notifications.open]);
  const searchResults = useMemo(() => {
    if (!data || query.trim().length < 2) return [];
    const normalized = query.toLowerCase();
    return [
      ...data.cases.filter((item) => [item.id, item.paymentId, item.failureClass].some((value) => value?.toLowerCase().includes(normalized))).slice(0, 4).map((item) => ({ type: "Case", label: compactId(item.id), detail: humanize(item.status), action: () => { setQuery(""); void openCase(item.id); } })),
      ...data.scenarios.filter((item) => [item.title, item.category, item.expected].some((value) => value.toLowerCase().includes(normalized))).slice(0, 4).map((item) => ({ type: "Scenario", label: item.title, detail: item.category, action: () => { setQuery(""); switchView("scenarios"); } })),
      ...data.events.filter((item) => [item.type, item.providerEventId].some((value) => value.toLowerCase().includes(normalized))).slice(0, 3).map((item) => ({ type: "Event", label: item.type, detail: compactId(item.providerEventId), action: () => { setQuery(""); switchView("events"); } }))
    ].slice(0, 8);
  }, [data, openCase, query, switchView]);

  const navGroups = [
    { label: "Revenue Autopilot", items: [["overview", "Overview", <LayoutDashboard/>], ["portfolio", "Portfolio optimizer", <TrendingUp/>], ["incidents", "Payment intelligence", <Network/>], ["journeys", "Checkout journeys", <Route/>], ["subscriptions", "Recurring revenue", <RefreshCw/>], ["receivables", "B2B receivables", <Building2/>], ["conversations", "Promises & voice", <MessageSquareText/>]] },
    { label: "Operations", items: [["cases", "Recovery cases", <WalletCards/>], ["scenarios", "Scenario Lab", <FlaskConical/>], ["events", "Events & audit", <Radio/>], ["analytics", "Analytics", <BarChart3/>]] },
    { label: "Controls", items: [["security", "Security Center", <ShieldCheck/>], ["integrations", "Integrations", <Cable/>], ["guide", "Operator Guide", <BookOpen/>]] }
  ] as Array<{ label: string; items: Array<[ViewId, string, ReactNode]> }>;

  const authenticate = () => {
    if (!operatorToken.trim()) return;
    window.sessionStorage.setItem("payArcOperatorToken", operatorToken.trim());
    setOperatorToken("");
    void reload();
  };

  let content: ReactNode = null;
  if (data) {
    if (view === "overview") content = <Overview data={data} onView={switchView} onOpenCase={openCase}/>;
    if (view === "portfolio") content = <PortfolioView revenue={data.revenue} busy={drawerBusy} mutate={revenueAction}/>;
    if (view === "incidents") content = <IncidentsView items={data.revenue.incidents} busy={drawerBusy} mutate={revenueAction}/>;
    if (view === "journeys") content = <JourneysView items={data.revenue.journeys} busy={drawerBusy} mutate={revenueAction}/>;
    if (view === "subscriptions") content = <SubscriptionsView subscriptions={data.revenue.subscriptions} mandates={data.revenue.mandates} busy={drawerBusy} mutate={revenueAction}/>;
    if (view === "receivables") content = <ReceivablesView items={data.revenue.receivables} busy={drawerBusy} mutate={revenueAction}/>;
    if (view === "conversations") content = <ConversationsView conversations={data.revenue.conversations} promises={data.revenue.promises} busy={drawerBusy} mutate={revenueAction}/>;
    if (view === "cases") content = <CasesView cases={data.cases} onOpen={openCase}/>;
    if (view === "scenarios") content = <ScenariosView scenarios={data.scenarios} history={data.scenarioRuns} testLab={data.razorpayTestLab} runningId={runningId} realTestBusy={realTestBusy} onRun={runScenario} onInspect={inspectScenarioRun} onLaunchReal={launchRazorpayTest} onOpenCheckout={openRazorpayTestCheckout} onOpenCase={openCase}/>;
    if (view === "events") content = <EventsView events={data.events} audit={data.audit}/>;
    if (view === "analytics") content = <AnalyticsView metrics={data.metrics}/>;
    if (view === "security") content = <SecurityView metrics={data.metrics} audit={data.audit} scenarios={data.scenarios} runningId={runningId} onRun={runScenario} onVerify={verifyAudit}/>;
    if (view === "integrations") content = <IntegrationsView config={data.config}/>;
    if (view === "guide") content = <GuideView onView={switchView}/>;
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}><div className="brand"><div className="brand-mark"><ShieldCheck/></div><div><strong>PayArc</strong><span>Revenue Control Plane</span></div><button className="mobile-close" onClick={() => setMobileNav(false)}><PanelLeftClose/></button></div><nav>{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map(([id, label, icon]) => <button className={view === id ? "active" : ""} onClick={() => switchView(id)} key={id}>{icon}<span>{label}</span>{id === "cases" && notificationCases.length > 0 && <b>{notificationCases.length}</b>}</button>)}</div>)}</nav><div className="sidebar-foot"><div className="health-row"><i className={error ? "down" : ""}/><div><strong>{error ? "Connection issue" : "All systems operational"}</strong><span>{data?.config.paymentProviderMode === "razorpay" ? "Razorpay Test Mode" : "Safe mock provider"}</span></div></div><div className="trust-copy"><LockKeyhole size={13}/> Zero-trust execution boundary</div></div></aside>
    {mobileNav && <div className="mobile-overlay" onClick={() => setMobileNav(false)}/>}
    <div className="main-shell">
      <header className="topbar">
        <div className="topbar-title">
          <button className="menu-button" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu/></button>
          <div><h1>{viewTitles[view].title}</h1><span>{viewTitles[view].subtitle}</span></div>
        </div>
        <div className="topbar-search">
          <div className="global-search">
            <Search size={17}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search cases, payments, events…"/>
            {query && <button aria-label="Clear search" onClick={() => setQuery("")}><X size={14}/></button>}
            {query.trim().length >= 2 && <div className="search-results">{searchResults.map((result, index) => <button onClick={result.action} key={`${result.type}-${index}`}><span>{result.type}</span><div><strong>{result.label}</strong><small>{result.detail}</small></div><ChevronRight size={15}/></button>)}{!searchResults.length && <div className="search-empty">No matching records</div>}</div>}
          </div>
        </div>
        <div className="topbar-tools">
          <div className="topbar-status">
            <span className={`sync-badge ${realtimeState}`} title={lastSyncedAt ? `Last synchronized ${new Date(lastSyncedAt).toLocaleTimeString()}` : "Connecting to live updates"}><i/>{realtimeState === "live" ? "Live" : realtimeState === "reconnecting" ? "Retrying" : "Connecting"}</span>
            <span className={`env-badge ${data?.config.paymentProviderMode === "razorpay" ? "live" : "mock"}`}><i/>{data?.config.paymentProviderMode === "razorpay" ? "Test Mode" : "Mock Mode"}</span>
          </div>
          <div className="topbar-controls">
            <button className="icon-button" title="Open operator guide" onClick={() => switchView("guide")}><BookOpen size={18}/></button>
            <button className="icon-button" title="Refresh dashboard" onClick={() => void reload(true)} disabled={refreshing}><RefreshCw size={18} className={refreshing ? "spin" : ""}/></button>
            <div className="popover-wrap"><button className="icon-button" aria-label={`${unreadNotificationCases.length} unread notifications`} onClick={() => { setNotificationsOpen(!notificationsOpen); setAccountOpen(false); }}><Bell size={18}/>{unreadNotificationCases.length > 0 && <b className="notification-dot">{unreadNotificationCases.length}</b>}</button>{notificationsOpen && <div className="popover notifications"><div className="popover-head"><div><strong>Action centre</strong><span>{unreadNotificationCases.length} unread · {notificationCases.length} requiring action</span></div>{unreadNotificationCases.length > 0 && <button className="mark-read-button" onClick={markAllNotificationsRead}><Check size={14}/>Mark all read</button>}</div>{notifications.ordered.slice(0, 6).map((item) => <button className={unreadNotificationIds.has(item.id) ? "unread" : ""} key={item.id} onClick={() => { void openCase(item.id); setNotificationsOpen(false); }}><AlertTriangle size={16}/><div><strong>{humanize(item.status)}</strong><span>{formatMoney(item.amount)} · {humanize(item.failureClass)}</span></div></button>)}{!notifications.open.length && <EmptyState icon={<CheckCircle2/>} title="You're all caught up" detail="No recovery alerts."/>}</div>}</div>
            <div className="popover-wrap account-wrap"><button className="account-button" onClick={() => { setAccountOpen(!accountOpen); setNotificationsOpen(false); }}><div>M</div><span><strong>Merchant</strong><small>Merchant owner</small></span><ChevronDown size={14}/></button>{accountOpen && <div className="popover account-menu"><div><strong>Merchant</strong><span>merchant@payarc.test</span></div><button onClick={() => switchView("integrations")}><Server size={16}/>Runtime settings</button><button onClick={() => switchView("security")}><ShieldCheck size={16}/>Security controls</button></div>}</div>
          </div>
        </div>
      </header>
      <main className="content">{loading ? <div className="loading-screen"><div className="loader"/><strong>Loading recovery control plane</strong><span>Verifying APIs and audit state…</span></div> : error ? error === "Operator authentication required" ? <div className="auth-screen panel"><div className="auth-mark"><LockKeyhole/></div><span className="overline">Protected operator API</span><h2>Authenticate to PayArc</h2><p>Enter the operator token configured for this environment. It remains in this browser tab only.</p><label><span>Operator token</span><input type="password" value={operatorToken} onChange={(event) => setOperatorToken(event.target.value)} onKeyDown={(event) => event.key === "Enter" && authenticate()} autoComplete="current-password" placeholder="Bearer token"/></label><button disabled={!operatorToken.trim()} onClick={authenticate}><LockKeyhole/>Connect securely</button></div> : <div className="error-screen panel"><AlertTriangle/><h2>Dashboard connection failed</h2><p>{error}</p><button onClick={() => void reload()}><RefreshCw/>Retry connection</button></div> : content}</main>
    </div>
    {selectedCase && data && <CaseDrawer detail={selectedCase} providerMode={data.config.paymentProviderMode} whatsappMode={data.config.whatsappMode} busy={drawerBusy} onClose={closeCase} onAction={caseAction}/>}
    {scenarioTrace && <ScenarioTraceDrawer run={scenarioTrace} onClose={() => setScenarioTrace(null)}/>}
    {scenarioResult && <div className="result-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setScenarioResult(null)}><div className="result-modal panel"><button className="icon-button result-close" onClick={() => setScenarioResult(null)}><X/></button><div className="result-success"><CheckCircle2/></div><span className="overline">Scenario completed in isolated sandbox</span><h2>{scenarioResult.scenario.title}</h2><p>{scenarioResult.observed}</p><div className="result-comparison"><div><span>Expected</span><strong>{scenarioResult.scenario.expected}</strong></div><ChevronRight/><div><span>Observed state</span><strong>{scenarioResult.case ? humanize(scenarioResult.case.status) : "Safely rejected"}</strong></div></div><div className="scenario-proof-grid"><div><span>Persisted events</span><strong>{scenarioResult.eventTrace.length}</strong></div><div><span>Worker runs</span><strong>{scenarioResult.workerRuns.length}</strong></div><div><span>Actions</span><strong>{scenarioResult.actions.length}</strong></div><div><span>Audit proofs</span><strong>{scenarioResult.recentAudit.length}</strong></div></div>{Object.keys(scenarioResult.security).length > 0 && <div className="security-proof">{Object.entries(scenarioResult.security).map(([key, value]) => <div key={key}><span>{humanize(key)}</span><strong>{String(value)}</strong></div>)}</div>}<div className="result-actions"><button onClick={() => { setScenarioTrace(scenarioResult); setScenarioResult(null); }}><ListFilter/>Inspect trace</button><button className="secondary-button" onClick={() => { setScenarioResult(null); switchView("scenarios"); }}><FlaskConical/>Run another scenario</button></div></div></div>}
    {toast && <div className={`toast ${toast.tone}`}>{toast.tone === "success" ? <CheckCircle2/> : <AlertTriangle/>}<span>{toast.message}</span><button onClick={() => setToast(null)}><X/></button></div>}
  </div>;
}
