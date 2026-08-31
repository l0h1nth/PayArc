# Technology architecture

PayArc uses different technologies at boundaries where they provide a concrete advantage. It does not introduce additional programming languages purely to appear complex.

## Current runtime

| Boundary | Technology | Reason |
| --- | --- | --- |
| Operator dashboard | React, TypeScript, Vite, Recharts | Stateful workflows, typed API contracts, responsive visualizations, production bundling |
| Payment orchestration API | Fastify, TypeScript, Zod | Raw-body webhook control, shared financial types, fast validation, low integration overhead |
| Durable local state | SQLite with WAL | Atomic event/job/case/action writes and a zero-setup judged demo |
| Payment provider | Razorpay Test Mode adapter | Real payment lookup and bounded Payment Link execution |
| Decision intelligence | Deterministic engine with optional OpenAI structured output | Repeatable offline behavior plus an optional constrained AI recommendation path |
| Security ledger | SHA-256 hash chain | Detects modification of accepted events and operator/action history |
| Revenue Digital Twin | Typed JSON objects in indexed SQLite tables | Unifies journeys, incidents, subscriptions, mandates, invoices, conversations, and promises without duplicating the underlying obligation |
| Portfolio optimizer | Deterministic incremental-value scorer | Selects actions under a daily budget after natural recovery, action cost, customer fatigue, and risk penalties |
| Realtime projection | Authenticated SSE revision stream | Pushes durable webhook, worker, and channel changes into every open operator view |
| Channel orchestrator | WhatsApp click-to-chat or Cloud API adapter | Requires opt-in, minimizes PII, deduplicates delivery, and obeys stopping rules |
| High-volume worker | Bounded concurrent worker pool | Claims durable batches, processes provider reads concurrently, prevents overlapping polling cycles, and keeps per-action idempotency |
| Contact resolver | Just-in-time Razorpay payment/order/invoice reads | Uses the payment phone plus order/payment opt-in notes without persisting raw contact data |

React and Fastify both use TypeScript because sharing the domain vocabulary reduces amount/currency and state-machine integration bugs. They are separate applications and technology layers even though they share a language.

The recovery hierarchy is deliberately conservative: observe an active checkout, reuse an existing valid checkout, wait for provider-managed retry, request a method update, and create a bounded replacement Payment Link only when no reusable payment path exists. Signed downtime events can engage a portfolio-wide circuit breaker before any individual recovery action executes.

Low-risk actions are autonomous, not manually reviewed one order at a time. The worker schedules each decision for its policy-selected cooldown, re-evaluates policy at execution time, performs the provider action once, resolves channel data just-in-time, and sends only when consent proof is present. High-value, low-confidence, risk/compliance, merchant-configuration, opt-out, cooldown, control-cohort, and incident cases remain blocked or operator-gated.

## Purposeful Python boundary

Python should be introduced when PayArc trains or serves a merchant-specific model—for example recovery-probability scoring, retry-time optimization, anomaly detection, or offline feature evaluation. That service should receive only minimized structured features and return a recommendation schema. It must never receive Razorpay credentials or execute payments.

```text
Razorpay webhook → TypeScript ingestion/orchestration → Python scoring service
                                            ↓                  ↓
                                  deterministic policy ← recommendation
                                            ↓
                                    Razorpay Test action
```

The TypeScript policy engine remains authoritative over amounts, currency, customer-contact limits, approval, idempotency, and provider execution. If the Python service is unavailable or returns invalid output, the deterministic provider is the fail-closed fallback.

## Production substitutions

- SQLite → PostgreSQL for concurrent durable state and analytics queries.
- In-process job polling → Redis Streams, SQS, or Kafka for independently scalable workers.
- Static operator token → OIDC/SSO with role-based authorization.
- Single process → separately deployed ingestion, decision, execution, and outcome workers.
- Optional Python service → FastAPI plus a versioned model registry only after real outcome data exists.

These are deployment evolutions, not requirements for demonstrating the core recovery invariant in the hackathon.
