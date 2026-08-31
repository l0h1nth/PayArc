import { useState, type ReactNode } from "react";
import {
  Activity, AlertTriangle, ArrowRight, Ban, Bot, Building2, CalendarClock, Check,
  CheckCircle2, CircleDollarSign, Clock3, CreditCard, Gauge, IndianRupee,
  Languages, Link2, MessageSquareText, Network, PhoneCall, Play, RefreshCw,
  Route, ShieldAlert, ShieldCheck, Sparkles, TrendingUp, UserCheck, WalletCards,
  Zap
} from "lucide-react";
import type {
  ConversationData, IncidentData, JourneyData, MandateData, PromiseData,
  ReceivableData, RevenueObject, RevenueSnapshot, SubscriptionData
} from "./revenue-types";

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
      <div className="incident-facts"><div><span>Failures</span><strong>{item.data.failureCount}</strong></div><div><span>At risk</span><strong>{money(item.amount)}</strong></div><div><span>Retries stopped</span><strong>{item.data.preventedRetries}</strong></div></div>
      <div className={`breaker ${item.data.circuitBreaker ? "on" : "off"}`}><ShieldAlert/><div><strong>Circuit breaker {item.data.circuitBreaker ? "engaged" : "released"}</strong><span>{item.data.circuitBreaker ? "Recovery traffic is paused" : `${item.data.stagedReleasePercent}% traffic released`}</span></div></div>
      <div className="card-actions">{item.data.circuitBreaker ? <button disabled={busy} onClick={() => void mutate("Incident marked healthy; 25% staged release started", () => import("./api").then(({ api }) => api.resolveIncident(item.id)))}><CheckCircle2/>Resolve incident</button> : item.data.stagedReleasePercent < 100 ? <button disabled={busy} onClick={() => void mutate("Recovery traffic released another 25%", () => import("./api").then(({ api }) => api.releaseIncident(item.id)))}><TrendingUp/>Release next 25%</button> : <span className="complete-note"><Check/>Fully recovered</span>}</div>
    </article>)}</div>
  </div>;
}

export function JourneysView({ items, busy, mutate }: { items: Array<RevenueObject<JourneyData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="Checkout abandonment" title="Customer journey rescue" detail="Observe active retries, reuse the original Razorpay checkout whenever possible, and create a bounded replacement only when the original has expired."/>
    <div className="journey-list">{items.map((item) => <article className="journey-card panel" key={item.id}>
      <div className="journey-main"><div className="object-icon"><Route/></div><div><div className="title-line"><h3>{item.customerRef}</h3><Pill value={item.status}/></div><span>{item.data.sessionId} · {words(item.data.paymentMethod)}</span><p>{item.data.reason}</p></div></div>
      <div className="journey-stage"><span>Checkout stage</span><div className="stage-track">{["CHECKOUT_OPENED", "METHOD_SELECTED", "OTP", "FAILED", "ABANDONED"].map((stage) => <i className={stage === item.data.stage ? "current" : ""} key={stage} title={words(stage)}/>)}</div><strong>{words(item.data.stage)}</strong></div>
      <div className="journey-decision"><div><span>At risk</span><strong>{money(item.amount)}</strong></div><div><span>Autopilot decision</span><strong>{words(item.data.recommendedAction)}</strong></div><div><span>Existing checkout</span><strong>{item.data.originalCheckoutUrl && item.data.checkoutExpiresAt > Date.now() / 1000 ? "Reusable" : "Unavailable"}</strong></div></div>
      <div className="card-actions"><button disabled={busy || item.status === "PAID"} onClick={() => void mutate("Journey decision executed", () => import("./api").then(({ api }) => api.recoverJourney(item.id)))}>{item.data.customerActive ? <><Ban/>Keep observing</> : item.data.recommendedAction === "CREATE_BOUNDED_LINK" ? <><Link2/>Prepare bounded link</> : <><Link2/>Reuse checkout</>}</button>{item.data.customerActive && <button className="secondary-button" disabled={busy} onClick={() => void mutate("Checkout abandonment detected", () => import("./api").then(({ api }) => api.signalJourney(item.id, "ABANDONED", false)))}><Route/>Simulate abandonment</button>}{item.status !== "PAID" && <button className="secondary-button" disabled={busy} onClick={() => void mutate("Razorpay payment verified", () => import("./api").then(({ api }) => api.payJourney(item.id)))}><CreditCard/>Simulate paid webhook</button>}</div>
    </article>)}</div>
  </div>;
}

export function SubscriptionsView({ subscriptions, mandates, busy, mutate }: { subscriptions: Array<RevenueObject<SubscriptionData>>; mandates: Array<RevenueObject<MandateData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="Recurring revenue" title="Subscription and mandate sequencer" detail="Honor provider-managed retries, request method updates when mandates are unrecoverable, and block attempts whenever duplicate-debit or bank-health risk is present."/>
    <div className="split-layout"><section className="panel collection-panel"><div className="panel-heading"><div><span className="overline">Failed subscriptions</span><h3>Outstanding invoices</h3></div><span className="count-badge">{subscriptions.length}</span></div><div className="stack-list">{subscriptions.map((item) => <article className="subscription-row" key={item.id}><div className="object-icon"><RefreshCw/></div><div className="grow"><div className="title-line"><h4>{item.data.plan}</h4><Pill value={item.status}/></div><span>{item.data.invoiceId} · {item.customerRef}</span><div className="inline-facts"><span>{item.data.failedAttempts} failed attempts</span><span>{words(item.data.mandateStatus)}</span><span>{item.data.providerRetryAt ? `Provider retry ${date(item.data.providerRetryAt)}` : "Provider retries exhausted"}</span></div><strong className="decision-copy">{words(item.data.recommendedAction)}</strong></div><div className="row-end"><strong>{money(item.data.outstandingAmount)}</strong><button disabled={busy} onClick={() => void mutate("Subscription playbook advanced", () => import("./api").then(({ api }) => api.advanceSubscription(item.id)))}><Zap/>Advance</button></div></article>)}</div></section>
      <section className="panel collection-panel"><div className="panel-heading"><div><span className="overline">Mandate retry sequencing</span><h3>Bounded attempt plans</h3></div><span className="count-badge">{mandates.length}</span></div><div className="stack-list">{mandates.map((item) => <article className="mandate-card" key={item.id}><div className="title-line"><div><span>{item.customerRef}</span><h4>{item.data.rail}</h4></div><Pill value={item.status}/></div><div className="sequence">{item.data.steps.map((step) => <div className={step.status.toLowerCase()} key={step.label}><i>{step.status === "DONE" ? <Check/> : step.status === "BLOCKED" ? <Ban/> : <Clock3/>}</i><div><strong>{step.label}</strong><span>{step.scheduledAt ? date(step.scheduledAt) : words(step.status)}</span></div></div>)}</div>{(item.data.duplicateDebitRisk || !item.data.bankHealthy) && <div className="risk-banner"><ShieldAlert/>Retry blocked: {item.data.duplicateDebitRisk ? "duplicate debit risk" : "bank unhealthy"}</div>}<button disabled={busy} onClick={() => void mutate("Mandate sequence evaluated", () => import("./api").then(({ api }) => api.advanceMandate(item.id)))}><Route/>Evaluate next step</button></article>)}</div></section></div>
  </div>;
}

export function ReceivablesView({ items, busy, mutate }: { items: Array<RevenueObject<ReceivableData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="B2B receivables" title="Invoice blocker and collections desk" detail="Resolve operational blockers such as missing PO or GST details before contacting buyers, then capture disputes and promises against the authoritative invoice."/>
    <div className="receivable-grid">{items.map((item) => <article className="receivable-card panel" key={item.id}><div className="card-top"><div className="object-icon"><Building2/></div><div><span>{item.data.invoiceNumber}</span><h3>{item.data.buyer}</h3></div><Pill value={item.status}/></div><strong className="large-amount">{money(item.amount)}</strong><div className="receivable-aging"><span>{item.data.daysOverdue} days overdue</span><div><i style={{ width: `${Math.min(100, item.data.daysOverdue * 4)}%` }}/></div><small>Due {date(item.data.dueAt)}</small></div>{item.data.blocker ? <div className="blocker-box"><AlertTriangle/><div><span>Invoice blocker detected</span><strong>{words(item.data.blocker)}</strong></div></div> : <div className="next-action"><Bot/><div><span>Next best action</span><strong>{words(item.data.nextAction)} via {words(item.data.contactChannel)}</strong></div></div>}<div className="card-actions">{item.data.blocker && <button disabled={busy} onClick={() => void mutate("Invoice blocker resolved", () => import("./api").then(({ api }) => api.resolveReceivableBlocker(item.id)))}><Check/>Resolve blocker</button>}<button className={item.data.blocker ? "secondary-button" : ""} disabled={busy} onClick={() => void mutate("Receivable workflow advanced", () => import("./api").then(({ api }) => api.contactReceivable(item.id)))}><MessageSquareText/>Run next action</button></div></article>)}</div>
  </div>;
}

export function ConversationsView({ conversations, promises, busy, mutate }: { conversations: Array<RevenueObject<ConversationData>>; promises: Array<RevenueObject<PromiseData>>; busy: boolean; mutate: Mutate }) {
  return <div className="revenue-page">
    <PageIntro eyebrow="Consent-aware engagement" title="Hinglish conversations and promises" detail="Convert customer language into structured, auditable outcomes. Every promise pauses contact, every opt-out stops outreach, and every paid claim is verified against Razorpay."/>
    <div className="conversation-layout"><section className="panel conversation-panel"><div className="panel-heading"><div><span className="overline">Live conversation</span><h3>Voice recovery simulator</h3></div><Languages/></div>{conversations.map((item) => <article className="conversation" key={item.id}><div className="conversation-meta"><div><span>{item.customerRef}</span><strong>{words(item.data.channel)} · {words(item.data.language)}</strong></div><Pill value={item.status}/></div><div className="transcript">{item.data.messages.map((message, index) => <div className={message.role.toLowerCase()} key={`${message.at}-${index}`}><span>{message.role === "AGENT" ? <Bot/> : <UserCheck/>}</span><p>{message.text}</p></div>)}</div><div className="structured-intent"><span>Structured outcome</span><strong>{words(item.data.intent)}</strong><small>{words(item.data.nextAction)}</small></div><div className="intent-buttons"><button disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Promise captured from Hinglish conversation", () => import("./api").then(({ api }) => api.respondConversation(item.id, "PROMISE_TOMORROW")))}><CalendarClock/>“Kal pay karunga”</button><button disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Existing UPI checkout selected", () => import("./api").then(({ api }) => api.respondConversation(item.id, "SEND_UPI")))}><IndianRupee/>Send UPI</button><button className="secondary-button" disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Payment verification queued", () => import("./api").then(({ api }) => api.respondConversation(item.id, "ALREADY_PAID")))}><ShieldCheck/>Already paid</button><button className="danger-button" disabled={busy || item.status === "OPTED_OUT"} onClick={() => void mutate("Customer opted out; all contact stopped", () => import("./api").then(({ api }) => api.respondConversation(item.id, "OPT_OUT")))}><Ban/>Opt out</button></div></article>)}</section>
      <section className="panel promises-panel"><div className="panel-heading"><div><span className="overline">Promise-to-pay ledger</span><h3>Stopping rules enforced</h3></div><span className="count-badge">{promises.filter((item) => item.status === "OPEN").length} open</span></div><div className="promise-list">{promises.map((item) => <article key={item.id}><div className="promise-head"><div className="object-icon"><CircleDollarSign/></div><div><strong>{money(item.amount)}</strong><span>{item.customerRef} · due {date(item.data.dueAt)}</span></div><Pill value={item.status}/></div><div className="confidence"><span>Promise confidence</span><div><i style={{ width: `${item.data.confidence * 100}%` }}/></div><strong>{percent(item.data.confidence)}</strong></div><p><ShieldCheck/>{item.data.stoppingRule}</p>{item.status === "OPEN" && <div className="card-actions"><button disabled={busy} onClick={() => void mutate("Promise kept and payment reconciled", () => import("./api").then(({ api }) => api.updatePromise(item.id, "KEPT")))}><Check/>Mark kept</button><button className="secondary-button" disabled={busy} onClick={() => void mutate("Promise missed; one escalation scheduled", () => import("./api").then(({ api }) => api.updatePromise(item.id, "MISSED")))}><Clock3/>Mark missed</button></div>}</article>)}</div></section></div>
  </div>;
}
