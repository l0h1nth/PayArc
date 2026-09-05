import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Ban, Bot, Building2, CalendarClock, Check,
  CheckCircle2, CircleDollarSign, Clock3, CreditCard, Gauge, IndianRupee,
  Languages, Link2, MessageSquareText, Network, PhoneCall, Play, RefreshCw,
  Route, ShieldAlert, ShieldCheck, Sparkles, TrendingUp, UserCheck, WalletCards,
  Zap
} from "lucide-react";
import type {
  ConversationData, IncidentData, JourneyData, MandateData, PromiseData, PromiseWorkflowStage,
  ReceivableData, RevenueObject, RevenueSnapshot, SubscriptionData
} from "./revenue-types";
import type { RecoveryCase } from "./types";

type Mutate = (label: string, task: () => Promise<unknown>) => Promise<void>;

function money(value: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(value / 100);
}

function percent(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function date(value: number | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value * 1000));
}

function words(value: string | null | undefined) {
  return value ? value.toLowerCase().split("_").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ") : "—";
}

function Pill({ value, tone }: { value: string; tone?: string }) {
  const resolved = tone ?? (["ACTIVE", "BLOCKED", "MISSED", "HALTED"].includes(value) ? "red" : ["PAID", "KEPT", "RESOLVED", "SUCCEEDED"].includes(value) ? "green" : "blue");
  return <span className={`revenue-pill ${resolved}`}>{words(value)}</span>;
}

function PageIntro({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <section className="revenue-intro panel"><div><span className="overline">{eyebrow}</span><h2>{title}</h2><p>{detail}</p></div>{action}</section>;
}

function RevenueMetric({ icon, label, value, detail, tone = "blue" }: { icon: ReactNode; label: string; value: string; detail: string; tone?: string }) {
  return <div className="revenue-metric panel"><div className={`revenue-metric-icon ${tone}`}>{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function PortfolioView({ revenue, busy, mutate }: { revenue: RevenueSnapshot; busy: boolean; mutate: Mutate }) {
  const [budget, setBudget] = useState(6);
  const selected = revenue.portfolio.filter((item) => item.selected);
  return <div className="revenue-page">
    <PageIntro eyebrow="Revenue Digital Twin" title="Portfolio recovery optimizer" detail="Rank every recoverable obligation by incremental value—not gross payment value—while pricing in natural recovery, customer fatigue, compliance, and duplicate-debit risk." action={<div className="intro-actions"><label className="budget-field"><span>Daily action budget</span><input aria-label="Daily action budget" type="number" min={1} max={25} value={budget} onChange={(event) => setBudget(Math.max(1, Math.min(25, Number(event.target.value) || 1)))}/></label><button disabled={busy} onClick={() => void mutate("Portfolio re-optimized", () => import("./api").then(({ api }) => api.optimizePortfolio(budget)))}><RefreshCw/>Optimize</button><button className="primary-strong" disabled={busy || !selected.length} onClick={() => void mutate("Recovery batch executed", () => import("./api").then(({ api }) => api.runRevenueBatch()))}><Play/>Run selected batch</button></div>}/>
    <div className="revenue-metric-grid">
      <RevenueMetric icon={<WalletCards/>} label="Revenue at risk" value={money(revenue.metrics.totalAtRisk)} detail="Across the unified obligation graph"/>
      <RevenueMetric icon={<TrendingUp/>} label="Incremental recovered" value={money(revenue.metrics.incrementalRecovered)} detail={`${money(revenue.metrics.grossRecovered)} gross minus natural recovery`} tone="green"/>
      <RevenueMetric icon={<ShieldCheck/>} label="Protected revenue" value={money(revenue.metrics.protectedRevenue)} detail={`${revenue.metrics.retriesPrevented} unsafe retries prevented`} tone="violet"/>
      <RevenueMetric icon={<Gauge/>} label="Net recovery ROI" value={revenue.metrics.netRecoveryRoi === null ? "No spend" : `${revenue.metrics.netRecoveryRoi.toFixed(1)}×`} detail={`${money(revenue.metrics.interventionCost)} intervention cost`} tone="orange"/>
    </div>
    <section className="panel portfolio-panel">
      <div className="panel-heading"><div><span className="overline">Next-best actions</span><h3>{selected.length} interventions selected</h3></div><span className="last-run">Optimized {date(revenue.lastOptimizedAt)}</span></div>
      <div className="responsive-table"><table><thead><tr><th>Priority</th><th>Revenue object</th><th>Next action</th><th>Gross</th><th>Natural</th><th>Incremental value</th><th>Decision</th></tr></thead><tbody>{revenue.portfolio.map((item, index) => <tr key={item.objectId} className={item.selected ? "selected" : ""}><td><span className="rank">{index + 1}</span></td><td><strong>{words(item.kind)}</strong><small>{item.customerRef ?? item.objectId}</small></td><td>{words(item.action)}</td><td>{money(item.amount)}</td><td>{percent(item.naturalRecoveryProbability)}</td><td className="positive">{money(item.expectedIncrementalValue)}</td><td>{item.selected ? <Pill value="SELECTED" tone="green"/> : <Pill value="DEFERRED"/>}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}

export function IncidentsView({ items, busy, mutate }: { items: Array<RevenueObject<IncidentData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="Payment degradation intelligence" title="Live payment incident radar" detail="Correlate failure bursts across banks and rails, stop harmful retries, and release recovery traffic gradually after provider health returns."/>
    <div className="incident-grid">{items.map((item) => <article className={`incident-card panel ${item.data.severity.toLowerCase()}`} key={item.id}>
      <div className="card-top"><div className="object-icon"><Activity/></div><div><span>{item.data.provider} · {item.data.rail}</span><h3>{item.data.bank}</h3></div><Pill value={item.status}/></div>
      <div className="failure-rate"><div><span>Observed failure</span><strong>{percent(item.data.observedFailureRate)}</strong></div><ArrowRight/><div><span>Baseline</span><strong>{percent(item.data.baselineFailureRate)}</strong></div></div>
      <div className="incident-facts"><div><span>{item.data.automated ? "Cases clustered" : "Failures"}</span><strong>{item.data.automated ? item.data.affectedCaseIds?.length ?? 0 : item.data.failureCount}</strong></div><div><span>At risk</span><strong>{money(item.amount)}</strong></div><div><span>Retries stopped</span><strong>{item.data.preventedRetries}</strong></div></div>
      <div className={`breaker ${item.data.circuitBreaker ? "on" : "off"}`}><ShieldAlert/><div><strong>Circuit breaker {item.data.circuitBreaker ? "engaged" : "released"}</strong><span>{item.data.circuitBreaker ? "Recovery traffic is paused" : `${item.data.stagedReleasePercent}% traffic released`}</span></div></div>
      <div className="card-actions">{item.data.circuitBreaker ? <button disabled={busy} onClick={() => void mutate("Incident marked healthy; 25% staged release started", () => import("./api").then(({ api }) => api.resolveIncident(item.id)))}><CheckCircle2/>Resolve incident</button> : item.data.stagedReleasePercent < 100 ? <button disabled={busy} onClick={() => void mutate("Recovery traffic released another 25%", () => import("./api").then(({ api }) => api.releaseIncident(item.id)))}><TrendingUp/>Release next 25%</button> : <span className="complete-note"><Check/>Fully recovered</span>}</div>
    </article>)}</div>
  </div>;
}

function journeyStage(item: RevenueObject<JourneyData>) {
  if (item.status === "PAID" || item.data.stage === "PAID") return "PAID";
  if (item.data.workflowStage) return item.data.workflowStage;
  if (["RECOVERY_SCHEDULED", "LINK_REQUIRED"].includes(item.status)) return "RECOVERY_PATH_READY";
  if (["ABANDONED", "EXPIRED"].includes(item.status)) return "ABANDONED";
  if (item.data.stage === "CHECKOUT_OPENED") return "SESSION_OPEN";
  return "ACTIVE_OBSERVATION";
}

function JourneyPipeline({ item }: { item: RevenueObject<JourneyData> }) {
  const steps = ["Session", "Observe", "Abandoned", "Recovery path", "Verified paid"];
  const stage = journeyStage(item);
  const current = stage === "SESSION_OPEN" ? 0 : stage === "ACTIVE_OBSERVATION" ? 1 : stage === "ABANDONED" ? 2 : stage === "RECOVERY_PATH_READY" ? 3 : 4;
  return <div className="journey-pipeline" aria-label={`Current checkout journey stage: ${words(stage)}`}>
    {steps.map((step, index) => <div className={index < current || stage === "PAID" ? "done" : index === current ? "current" : "queued"} key={step}>
      <i>{index < current || stage === "PAID" ? <Check/> : index + 1}</i><span>{step}</span>
    </div>)}
  </div>;
}

export function JourneysView({ items, cases, demoMode, busy, mutate, onOpenCase }: { items: Array<RevenueObject<JourneyData>>; cases: RecoveryCase[]; demoMode: boolean; busy: boolean; mutate: Mutate; onOpenCase: (id: string) => void }) {
  const [filter, setFilter] = useState<"ALL" | "ACTIVE" | "ABANDONED" | "RECOVERY" | "PAID">("ALL");
  const counts = {
    ACTIVE: items.filter((item) => ["SESSION_OPEN", "ACTIVE_OBSERVATION"].includes(journeyStage(item))).length,
    ABANDONED: items.filter((item) => journeyStage(item) === "ABANDONED").length,
    RECOVERY: items.filter((item) => journeyStage(item) === "RECOVERY_PATH_READY").length,
    PAID: items.filter((item) => journeyStage(item) === "PAID").length
  };
  const visible = [...items]
    .filter((item) => filter === "ALL" || journeyStage(item) === filter || (filter === "ACTIVE" && ["SESSION_OPEN", "ACTIVE_OBSERVATION"].includes(journeyStage(item))) || (filter === "RECOVERY" && journeyStage(item) === "RECOVERY_PATH_READY"))
    .sort((left, right) => Number(journeyStage(left) === "PAID") - Number(journeyStage(right) === "PAID") || right.updatedAt - left.updatedAt);
  return <div className="revenue-page">
    <PageIntro eyebrow="Checkout abandonment" title="Customer journey rescue" detail="Observe active retries, reuse the original Razorpay checkout whenever possible, and create a bounded replacement only when the original has expired."/>
    <div className="journey-toolbar panel"><div><strong>{items.length}</strong><span>Total journeys</span></div>{(["ALL", "ACTIVE", "ABANDONED", "RECOVERY", "PAID"] as const).map((value) => <button className={filter === value ? "active" : ""} onClick={() => setFilter(value)} key={value}>{words(value)} <span>{value === "ALL" ? items.length : counts[value]}</span></button>)}</div>
    <div className="journey-list">{visible.map((item) => {
      const stage = journeyStage(item);
      const terminal = stage === "PAID";
      const checkoutValid = Boolean(item.data.originalCheckoutUrl) && item.data.checkoutExpiresAt > Date.now() / 1000;
      const recoveryReady = stage === "RECOVERY_PATH_READY";
      const recoveryCase = item.data.orderId ? cases.find((candidate) => candidate.orderId === item.data.orderId) : undefined;
      const actionLabel = item.data.customerActive
        ? "Recheck customer activity"
        : checkoutValid ? "Schedule original checkout" : "Request bounded recovery";
      const actionFeedback = item.data.customerActive
        ? "Customer is still active—outreach remains suppressed"
        : checkoutValid ? "Original checkout selected; no duplicate link created" : "Bounded recovery requested; waiting for signed provider evidence";
      const checkoutState = terminal ? "Closed after payment" : item.data.recoveryPath === "ORIGINAL_CHECKOUT" ? "Selected for reuse" : checkoutValid ? "Reusable" : "Expired / unavailable";
      return <article className={`journey-card panel ${terminal ? "terminal" : ""}`} key={item.id}>
        <div className="journey-main"><div className="object-icon"><Route/></div><div><div className="title-line"><h3>{item.customerRef}</h3><Pill value={item.status}/></div><span>{item.data.sessionId} · {words(item.data.paymentMethod)}</span><p>{item.data.reason}</p></div></div>
        <div className="journey-decision"><div><span>{terminal ? "Recovered" : "At risk"}</span><strong className={terminal ? "positive" : ""}>{money(terminal ? item.data.recoveredAmount : item.amount)}</strong></div><div><span>Autopilot decision</span><strong>{words(item.data.recommendedAction)}</strong></div><div><span>Original checkout</span><strong>{checkoutState}</strong></div></div>
        <div className="journey-actions">{terminal
          ? <div className="journey-complete"><CheckCircle2/><div><strong>Workflow complete</strong><span>No retry, message, or abandonment action can reopen this payment.</span></div></div>
          : <>{recoveryReady
            ? item.data.recoveryPath === "ORIGINAL_CHECKOUT" && item.data.originalCheckoutUrl
              ? <a className="journey-primary-action" href={item.data.originalCheckoutUrl} target="_blank" rel="noreferrer"><Link2/>Open original checkout</a>
              : recoveryCase
                ? <button onClick={() => onOpenCase(recoveryCase.id)}><WalletCards/>Open Recovery Case</button>
                : <div className="journey-awaiting"><Clock3/><div><strong>Await signed failure event</strong><span>The Recovery Case and bounded link are created only from provider evidence.</span></div></div>
            : <button disabled={busy} onClick={() => void mutate(actionFeedback, () => import("./api").then(({ api }) => api.recoverJourney(item.id)))}>{item.data.customerActive ? <Ban/> : <Link2/>}{actionLabel}</button>}
            {demoMode && item.data.customerActive && <button className="secondary-button" disabled={busy} onClick={() => void mutate("Checkout abandonment detected; recovery path can now be selected", () => import("./api").then(({ api }) => api.signalJourney(item.id, "ABANDONED", false)))}><Route/>Demo abandonment</button>}
            {demoMode && <button className="secondary-button" disabled={busy} onClick={() => void mutate("Demo paid outcome applied; recovery stopped", () => import("./api").then(({ api }) => api.payJourney(item.id)))}><CreditCard/>Demo paid outcome</button>}</>}
        </div>
        <JourneyPipeline item={item}/>
        <div className="journey-activity"><Activity/><div><span>Latest state change</span><strong>{item.data.lastActivity ?? item.data.reason}</strong><small>{item.data.lastActivityAt ? date(item.data.lastActivityAt) : `Updated ${date(item.updatedAt)}`}</small></div></div>
      </article>;
    })}{!visible.length && <div className="journey-empty panel"><Route/><strong>No journeys in this stage</strong><span>Choose another filter or create a fresh Checkout Journey demo from Scenario Lab.</span></div>}</div>
  </div>;
}

function subscriptionStage(item: RevenueObject<SubscriptionData>) {
  if (item.data.workflowStage) return item.data.workflowStage;
  if (item.status === "PROVIDER_RETRY") return "PROVIDER_RETRY_PENDING";
  if (item.status === "METHOD_UPDATE_SENT") return "METHOD_UPDATE_SENT";
  if (item.status === "RETRY_SCHEDULED") return "RETRY_SCHEDULED";
  if (item.status === "RECOVERED") return "RECOVERED";
  return "METHOD_UPDATE_REQUIRED";
}

function SubscriptionPipeline({ item }: { item: RevenueObject<SubscriptionData> }) {
  const stage = subscriptionStage(item);
  const providerPath = stage === "PROVIDER_RETRY_PENDING";
  const steps = providerPath
    ? ["Failure", "Provider retry", "Verify payment", "Closed"]
    : ["Failure", "Method update", "Bounded retry", "Verify payment"];
  const current = stage === "PROVIDER_RETRY_PENDING" || stage === "METHOD_UPDATE_REQUIRED" || stage === "METHOD_UPDATE_SENT"
    ? 1
    : stage === "RETRY_SCHEDULED" ? 2 : 3;
  return <div className="subscription-pipeline" aria-label={`Current subscription stage: ${words(stage)}`}>
    {steps.map((step, index) => <div className={index < current ? "done" : index === current ? "current" : "queued"} key={step}>
      <i>{index < current ? <Check/> : index + 1}</i><span>{step}</span>
    </div>)}
  </div>;
}

export function SubscriptionsView({ subscriptions, mandates, busy, mutate }: { subscriptions: Array<RevenueObject<SubscriptionData>>; mandates: Array<RevenueObject<MandateData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="Recurring revenue" title="Subscription and mandate sequencer" detail="Honor provider-managed retries, request method updates when mandates are unrecoverable, and block attempts whenever duplicate-debit or bank-health risk is present."/>
    <div className="split-layout">
      <section className="panel collection-panel">
        <div className="panel-heading"><div><span className="overline">Failed subscriptions</span><h3>Outstanding invoices</h3></div><span className="count-badge">{subscriptions.length}</span></div>
        <div className="stack-list">{subscriptions.map((item) => {
          const stage = subscriptionStage(item);
          const awaitingProvider = stage === "PROVIDER_RETRY_PENDING";
          const updateRequired = stage === "METHOD_UPDATE_REQUIRED";
          const updateSent = stage === "METHOD_UPDATE_SENT";
          const retryScheduled = stage === "RETRY_SCHEDULED";
          const actionLabel = awaitingProvider ? "Recheck provider window" : updateRequired ? "Send update request" : updateSent ? "Confirm update & schedule" : retryScheduled ? "Retry scheduled" : "Workflow closed";
          const feedback = awaitingProvider
            ? "Provider retry respected—no competing debit created"
            : updateRequired
              ? "Payment-method update request sent; automatic debit paused"
              : updateSent
                ? "Updated mandate confirmed; one bounded retry scheduled"
                : "Subscription workflow rechecked";
          return <article className="subscription-row" key={item.id}>
            <div className="subscription-summary"><div className="object-icon"><RefreshCw/></div><div className="grow"><div className="title-line"><h4>{item.data.plan}</h4><Pill value={item.status}/></div><span>{item.data.invoiceId} · {item.customerRef}</span><div className="inline-facts"><span>{item.data.failedAttempts} failed attempts</span><span>{words(item.data.mandateStatus)}</span><span>{item.data.providerRetryAt ? `Provider retry ${date(item.data.providerRetryAt)}` : "Provider retries exhausted"}</span></div></div><strong className="subscription-amount">{money(item.data.outstandingAmount)}</strong></div>
            <SubscriptionPipeline item={item}/>
            <div className="workflow-activity"><ShieldCheck/><div><span>Current decision</span><strong>{item.data.lastActivity ?? words(item.data.recommendedAction)}</strong>{item.data.lastActivityAt && <small>Updated {date(item.data.lastActivityAt)}</small>}</div></div>
            <div className="subscription-action"><div><span>Next safe action</span><strong>{words(item.data.recommendedAction)}</strong>{item.data.nextActionAt && <small>{date(item.data.nextActionAt)}</small>}</div><button disabled={busy || retryScheduled || stage === "RECOVERED"} onClick={() => void mutate(feedback, () => import("./api").then(({ api }) => api.advanceSubscription(item.id)))}><Zap/>{actionLabel}</button></div>
          </article>;
        })}</div>
      </section>
      <section className="panel collection-panel">
        <div className="panel-heading"><div><span className="overline">Mandate retry sequencing</span><h3>Bounded attempt plans</h3></div><span className="count-badge">{mandates.length}</span></div>
        <div className="stack-list">{mandates.map((item) => {
          const blocked = item.data.duplicateDebitRisk || !item.data.bankHealthy;
          const terminal = item.status === "EXHAUSTED";
          const nextStep = item.data.steps.find((step) => step.status === "QUEUED")?.label;
          const actionLabel = blocked ? "Re-evaluate safety" : nextStep ? `Schedule ${nextStep}` : "Complete sequence";
          const feedback = blocked ? "Safety rechecked—retry remains blocked" : nextStep ? `${nextStep} is now the next bounded attempt` : "Mandate sequence exhausted; automatic debits stopped";
          return <article className="mandate-card" key={item.id}>
            <div className="title-line"><div><span>{item.customerRef}</span><h4>{item.data.rail}</h4></div><Pill value={item.status}/></div>
            <div className="sequence">{item.data.steps.map((step) => <div className={step.status.toLowerCase()} key={step.label}><i>{step.status === "DONE" ? <Check/> : step.status === "BLOCKED" ? <Ban/> : <Clock3/>}</i><div><strong>{step.label}</strong><span>{step.scheduledAt ? date(step.scheduledAt) : words(step.status)}</span></div></div>)}</div>
            {blocked && <div className="risk-banner"><ShieldAlert/>Retry blocked: {item.data.duplicateDebitRisk ? "duplicate debit risk" : "bank unhealthy"}</div>}
            {item.data.lastActivity && <div className="workflow-activity compact"><Activity/><div><span>Latest evaluation</span><strong>{item.data.lastActivity}</strong>{item.data.lastEvaluatedAt && <small>{date(item.data.lastEvaluatedAt)}</small>}</div></div>}
            {terminal ? <div className="terminal-workflow"><ShieldCheck/><div><strong>Automatic sequence complete</strong><span>No more debits will be attempted. Manual checkout is the final safe path.</span></div></div> : <button disabled={busy} onClick={() => void mutate(feedback, () => import("./api").then(({ api }) => api.advanceMandate(item.id)))}><Route/>{actionLabel}</button>}
          </article>;
        })}</div>
      </section>
    </div>
  </div>;
}

export function ReceivablesView({ items, busy, mutate }: { items: Array<RevenueObject<ReceivableData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="B2B receivables" title="Invoice blocker and collections desk" detail="Resolve operational blockers such as missing PO or GST details before contacting buyers, then capture disputes and promises against the authoritative invoice."/>
    <div className="receivable-grid">{items.map((item) => {
      const terminal = ["PAID", "CANCELLED"].includes(item.status);
      const contacted = item.status === "CONTACTED";
      const promiseCaptured = item.status === "PROMISE_CAPTURED";
      const needsReview = item.status === "HUMAN_REVIEW" && !item.data.blocker;
      const decision = item.status === "PAID"
        ? "Payment reconciled — collection stopped"
        : contacted
          ? "Buyer contacted — record their response"
          : promiseCaptured
            ? "Promise tracked automatically"
            : needsReview
              ? "Merchant review required"
              : words(item.data.nextAction);
      return <article className="receivable-card panel" key={item.id}>
        <div className="card-top"><div className="object-icon"><Building2/></div><div><span>{item.data.invoiceNumber}</span><h3>{item.data.buyer}</h3></div><Pill value={item.status}/></div>
        <strong className="large-amount">{money(item.amount)}</strong>
        <div className="receivable-aging"><span>{item.data.daysOverdue} days overdue</span><div><i style={{ width: `${Math.min(100, item.data.daysOverdue * 4)}%` }}/></div><small>Due {date(item.data.dueAt)}</small></div>
        {item.data.blocker
          ? <div className="blocker-box"><AlertTriangle/><div><span>Invoice blocker detected</span><strong>{words(item.data.blocker)}</strong></div></div>
          : <div className="next-action"><Bot/><div><span>{terminal ? "Workflow result" : "Current next step"}</span><strong>{decision}</strong></div></div>}
        {item.data.lastActivity && <div className="receivable-activity"><Activity/><span>{item.data.lastActivity}{item.data.lastContactAt ? ` · ${date(item.data.lastContactAt)}` : ""}</span></div>}
        <div className="card-actions receivable-actions">
          {item.data.blocker && <button disabled={busy} onClick={() => void mutate("Invoice blocker resolved; invoice is ready for outreach", () => import("./api").then(({ api }) => api.resolveReceivableBlocker(item.id)))}><Check/>Resolve blocker</button>}
          {!item.data.blocker && !terminal && !contacted && !promiseCaptured && !needsReview && <button disabled={busy} onClick={() => void mutate(`Collection request sent via ${words(item.data.contactChannel)}`, () => import("./api").then(({ api }) => api.contactReceivable(item.id)))}><MessageSquareText/>Send {words(item.data.contactChannel)} request</button>}
          {contacted && <>
            <button disabled={busy} onClick={() => void mutate("Payment promise captured and added to the promise pipeline", () => import("./api").then(({ api }) => api.recordReceivableOutcome(item.id, "PROMISE")))}><CalendarClock/>Record promise</button>
            <button className="secondary-button" disabled={busy} onClick={() => void mutate("Invoice dispute recorded; automatic contact stopped", () => import("./api").then(({ api }) => api.recordReceivableOutcome(item.id, "DISPUTE")))}><AlertTriangle/>Record dispute</button>
            <button className="secondary-button" disabled={busy} onClick={() => void mutate("Receivable payment reconciled", () => import("./api").then(({ api }) => api.recordReceivableOutcome(item.id, "PAID")))}><CheckCircle2/>Mark paid</button>
          </>}
          {promiseCaptured && <a className="receivable-link-button" href="?view=conversations"><Route/>View promise pipeline<ArrowRight/></a>}
          {needsReview && <span className="receivable-terminal review"><UserCheck/>Automatic collection stopped for merchant review</span>}
          {terminal && <span className="receivable-terminal paid"><CheckCircle2/>Workflow complete—no further collection actions</span>}
        </div>
      </article>;
    })}</div>
  </div>;
}

const promisePipeline = [
  { key: "CAPTURED", label: "Promise", detail: "Captured" },
  { key: "PAUSED_UNTIL_DUE", label: "Pause", detail: "Until due" },
  { key: "DUE_CHECK", label: "Verify", detail: "Payment check" },
  { key: "REMINDER_SCHEDULED", label: "Reminder", detail: "One contact" },
  { key: "GRACE_PERIOD", label: "Grace", detail: "Await payment" },
  { key: "MERCHANT_REVIEW", label: "Review", detail: "Merchant queue" },
  { key: "CLOSED", label: "Closed", detail: "Paid or stopped" }
] as const;

function currentPromiseStage(item: RevenueObject<PromiseData>, now: number): PromiseWorkflowStage {
  if (item.data.workflowStage) return item.data.workflowStage;
  if (item.status === "KEPT") return "CLOSED_PAID";
  if (item.status === "CANCELLED") return "CLOSED_CANCELLED";
  if (item.status === "MISSED") return item.data.reminderAt && item.data.reminderAt > now ? "REMINDER_SCHEDULED" : "MERCHANT_REVIEW";
  return item.data.dueAt > now ? "PAUSED_UNTIL_DUE" : "DUE_CHECK";
}

function countdown(target: number | null | undefined, now: number) {
  if (!target) return "No timer";
  const remaining = Math.max(0, target - now);
  if (remaining === 0) return "Advancing now";
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  const seconds = remaining % 60;
  if (days) return `${days}d ${hours}h remaining`;
  if (hours) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s remaining`;
}

function PromiseFlow({ item, now }: { item: RevenueObject<PromiseData>; now: number }) {
  const stage = currentPromiseStage(item, now);
  const currentIndex = stage.startsWith("CLOSED_") ? 6 : promisePipeline.findIndex((step) => step.key === stage);
  const contactAttempts = item.data.contactAttempts ?? 0;
  const contactLimit = item.data.maxContactAttempts ?? 1;
  const terminal = stage.startsWith("CLOSED_");
  const status = stage === "PAUSED_UNTIL_DUE"
    ? { title: "Contact paused safely", detail: `Due check · ${countdown(item.data.dueAt, now)}`, tone: "blue" }
    : stage === "DUE_CHECK"
      ? { title: "Checking payment state", detail: "Razorpay verification is in progress", tone: "blue" }
      : stage === "REMINDER_SCHEDULED"
        ? { title: "One reminder scheduled", detail: countdown(item.data.reminderAt, now), tone: "amber" }
        : stage === "GRACE_PERIOD"
          ? { title: "Awaiting payment after reminder", detail: `Grace period · ${countdown(item.data.graceExpiresAt, now)}`, tone: "amber" }
          : stage === "MERCHANT_REVIEW"
            ? { title: "Merchant review required", detail: "Contact limit reached; no more automatic messages", tone: "red" }
            : stage === "CLOSED_PAID"
              ? { title: "Payment verified", detail: "Recovery stopped successfully", tone: "green" }
              : { title: "Contact stopped", detail: "Customer opt-out or merchant cancellation", tone: "gray" };

  return <div className="promise-flow-wrap">
    <div className={`promise-stage-summary ${status.tone}`}>
      <span className="promise-stage-icon">{stage === "CLOSED_PAID" ? <Check/> : stage === "MERCHANT_REVIEW" ? <UserCheck/> : <Clock3/>}</span>
      <div><small>Current workflow state</small><strong>{status.title}</strong><span>{status.detail}</span></div>
      <div className="promise-contact-meter"><small>Contact budget</small><strong>{contactAttempts} of {contactLimit}</strong><span>{item.data.consentVerified ? "Consent verified" : "Consent unavailable"}</span></div>
    </div>
    <div className="promise-pipeline" role="list" aria-label={`Recovery workflow for ${item.customerRef ?? item.id}`}>
      {promisePipeline.map((step, index) => {
        let state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
        if (stage === "MERCHANT_REVIEW" && (index === 3 || index === 4) && !item.data.reminderSentAt) state = "skipped";
        if (terminal && index > 0 && index < 6) {
          const wasUsed = index <= 2 || (index === 3 && Boolean(item.data.reminderSentAt)) || (index === 4 && Boolean(item.data.reminderSentAt));
          state = wasUsed ? "complete" : "skipped";
        }
        return <div className={`promise-step ${state}`} role="listitem" key={step.key}>
          <span className="promise-step-dot">{state === "complete" ? <Check/> : index + 1}</span>
          <strong>{step.label}</strong>
          <small>{state === "skipped" ? "Skipped safely" : step.detail}</small>
        </div>;
      })}
    </div>
    <div className="promise-flow-foot">
      <span><Activity/> {item.data.lastActivity ?? "Promise captured"}{item.data.lastActivityAt ? ` · ${date(item.data.lastActivityAt)}` : ""}</span>
      <span><ShieldCheck/> Stop on verified payment, opt-out, or {contactLimit} contact</span>
    </div>
  </div>;
}

export function ConversationsView({ conversations, promises, busy, mutate }: { conversations: Array<RevenueObject<ConversationData>>; promises: Array<RevenueObject<PromiseData>>; busy: boolean; mutate: Mutate }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const activePromises = promises.filter((item) => !["KEPT", "CANCELLED"].includes(item.status)).length;
  return <div className="revenue-page">
    <PageIntro eyebrow="Consent-aware engagement" title="Hinglish conversations and promises" detail="Convert customer language into structured, auditable outcomes. Every promise pauses contact, every opt-out stops outreach, and every paid claim is verified against Razorpay."/>
    <div className="conversation-layout promise-workspace"><section className="panel conversation-panel"><div className="panel-heading"><div><span className="overline">Live conversation</span><h3>Voice recovery simulator</h3></div><Languages/></div>{conversations.map((item) => <article className="conversation" key={item.id}><div className="conversation-meta"><div><span>{item.customerRef}</span><strong>{words(item.data.channel)} · {words(item.data.language)}</strong></div><Pill value={item.status}/></div><div className="transcript">{item.data.messages.map((message, index) => <div className={message.role.toLowerCase()} key={`${message.at}-${index}`}><span>{message.role === "AGENT" ? <Bot/> : <UserCheck/>}</span><p>{message.text}</p></div>)}</div><div className="structured-intent"><span>Structured outcome</span><strong>{words(item.data.intent)}</strong><small>{words(item.data.nextAction)}</small></div><div className="intent-buttons"><button disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Promise captured from Hinglish conversation", () => import("./api").then(({ api }) => api.respondConversation(item.id, "PROMISE_TOMORROW")))}><CalendarClock/>“Kal pay karunga”</button><button disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Existing UPI checkout selected", () => import("./api").then(({ api }) => api.respondConversation(item.id, "SEND_UPI")))}><IndianRupee/>Send UPI</button><button className="secondary-button" disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Payment verification queued", () => import("./api").then(({ api }) => api.respondConversation(item.id, "ALREADY_PAID")))}><ShieldCheck/>Already paid</button><button className="danger-button" disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Customer opted out; all contact stopped", () => import("./api").then(({ api }) => api.respondConversation(item.id, "OPT_OUT")))}><Ban/>Opt out</button></div></article>)}</section>
      <section className="panel promises-panel"><div className="panel-heading"><div><span className="overline">Promise recovery pipeline</span><h3>Every promise, action, and stopping rule</h3></div><span className="count-badge">{activePromises} active</span></div><div className="promise-list">{promises.map((item) => <article className="promise-card" key={item.id}><div className="promise-head"><div className="object-icon"><CircleDollarSign/></div><div><strong>{money(item.amount)}</strong><span>{item.customerRef} · due {date(item.data.dueAt)}</span></div><Pill value={item.status}/></div><PromiseFlow item={item} now={now}/><div className="promise-card-bottom"><div className="confidence"><span>Promise confidence</span><div><i style={{ width: `${item.data.confidence * 100}%` }}/></div><strong>{percent(item.data.confidence)}</strong></div><p><ShieldCheck/>{item.data.stoppingRule}</p>{!["KEPT", "CANCELLED"].includes(item.status) && <div className="card-actions"><button disabled={busy} onClick={() => void mutate("Payment verified; promise pipeline closed", () => import("./api").then(({ api }) => api.updatePromise(item.id, "KEPT")))}><Check/>Mark payment received</button>{item.status === "OPEN" && <button className="secondary-button" disabled={busy} onClick={() => void mutate("Promise missed; one reminder scheduled in 5 minutes", () => import("./api").then(({ api }) => api.updatePromise(item.id, "MISSED")))}><Clock3/>Mark missed</button>}</div>}</div></article>)}</div></section></div>
  </div>;
}
