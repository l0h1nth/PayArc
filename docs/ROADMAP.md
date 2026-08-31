# PayArc implementation roadmap

## Product thesis

PayArc is a zero-trust revenue-recovery control plane for Razorpay merchants. It consumes payment and subscription failure events, classifies recoverability, proposes the next-best intervention, passes the proposal through deterministic policy, executes only bounded Razorpay Test Mode actions, and measures verified revenue recovered.

The differentiator is not another reminder bot. It is an event-driven financial agent whose inputs are untrusted, whose actions are independently authorized, and whose business impact is reproducible.

## Research translated into design decisions

1. Razorpay already retries pending subscriptions. PayArc must coordinate around those retries rather than create competing charge attempts. A transient `subscription.pending` event normally produces a wait/watch decision; a `subscription.halted` event produces a payment-method-update, recovery-link, or human-review decision.
2. Razorpay webhooks use at-least-once delivery and may arrive out of order. Ingestion must verify the raw-body HMAC, persist before acknowledging, deduplicate by `x-razorpay-event-id`, and apply monotonic/terminal state rules.
3. Failure fields such as `error_source`, `error_step`, and `error_reason` are better automation inputs than free-text descriptions. Free text and `notes` are untrusted context and never authoritative financial data.
4. Mature dunning systems distinguish hard declines from soft/transient declines, suppress unnecessary retries, pause when a promise-to-pay exists, and stop customer contact immediately after recovery or opt-out.
5. Payment Links provide a bounded recovery action: unique reference IDs, explicit amounts, expiry, full/partial-payment states, and paid/expired/cancelled webhooks.
6. OWASP guidance for agentic systems calls for least privilege and validation of every proposed tool call. The model will have no direct Razorpay tools. It returns a typed recommendation; a deterministic policy engine owns identity, amount, currency, contact limits, expiry, and approval.
7. The evaluation must report money recovered, not merely cases detected. A stable treatment/control assignment and event ledger will support recovery-rate and uplift calculations without retroactively changing cohorts.

## Scope for the hackathon build

### Supported sources

- `payment.failed`
- `payment.authorized`
- `payment.captured`
- `payment.downtime.started`
- `payment.downtime.updated`
- `payment.downtime.resolved`
- `order.paid`
- `subscription.pending`
- `subscription.halted`
- `subscription.charged`
- `subscription.activated`
- `payment_link.paid`
- `payment_link.partially_paid`
- `payment_link.expired`
- `payment_link.cancelled`

Unknown events are stored and acknowledged but cannot create actions.

### Supported interventions

- `WAIT_FOR_PROVIDER_RETRY`
- `REUSE_EXISTING_CHECKOUT`
- `SEND_RECOVERY_LINK`
- `REQUEST_PAYMENT_METHOD_UPDATE`
- `ESCALATE_TO_HUMAN`
- `SUPPRESS_CONTACT`

The first version does not directly charge a stored payment method. Razorpay owns subscription retries; PayArc only coordinates customer-facing recovery and evidence-backed follow-up.

### Explicit non-goals

- Live-mode money movement
- Storing card, VPA, or bank credentials
- Sending production email/SMS/WhatsApp messages
- Letting an LLM choose or modify payment amounts
- Claiming causal uplift without a control cohort
- Treating webhook arrival order as state order

## State model

```text
DETECTED
  -> PLANNED
  -> WAITING | ACTION_REQUIRED | HUMAN_REVIEW | SUPPRESSED
  -> ACTIONED
  -> PARTIALLY_RECOVERED
  -> RECOVERED

Any non-terminal state -> EXHAUSTED
Any contactable state -> SUPPRESSED
RECOVERED and SUPPRESSED never reopen from an older event.
```

Every transition records the source event, previous state, new state, reason, actor, and a hash chained to the preceding audit record.

## Security and correctness invariants

1. Reject a webhook unless its HMAC-SHA256 signature matches one of the configured current/previous secrets.
2. Persist the exact raw body hash; never verify a re-serialized JSON object.
3. One provider event ID can enqueue at most one job.
4. One action idempotency key can create at most one external resource.
5. A model-provided amount, customer identifier, URL, API endpoint, or schedule is ignored.
6. Amount and currency come from a verified payment entity or outstanding subscription invoice.
7. Production Razorpay keys are rejected unless an explicit unsafe override is set; the default integration accepts only `rzp_test_` keys.
8. A recovered, opted-out, expired, cancelled, or control-cohort case cannot trigger customer contact.
9. Customer contact respects per-case caps, cooldowns, and a global kill switch.
10. High-value, malformed, unsupported-currency, missing-authoritative-data, and contradictory events go to human review.
11. A payment-link-paid event must match a stored provider link ID, reference, currency, and expected amount before credit is counted.
12. Partial payments update recovered value but do not close a case until the verified amount due is zero.
13. Webhook acknowledgement is fast: validate and enqueue transactionally, then process asynchronously.
14. API secrets, full webhook payloads containing PII, and model prompts are not returned by public endpoints.
15. The AI receives a minimised, structured feature set without email, phone number, names, notes, or arbitrary descriptions.

## Delivery phases

### Phase 0 — Baseline and contracts

- Bootstrap Node.js + TypeScript service.
- Define domain types, event schema, state machine, and provider interfaces.
- Add SQLite migrations and deterministic clocks/ID factories for tests.
- Produce `.env.example`, threat model, API contract, and test fixtures.

Exit criteria: application boots with an empty local database and health/config endpoints expose no secrets.

### Phase 1 — Secure event ingestion

- Add raw-body webhook endpoint.
- Verify current and previous webhook secrets in constant time.
- Deduplicate events and preserve raw hash.
- Queue durable jobs in the same database transaction.
- Implement supported-event normalization.
- Tolerate duplicate, unknown, malformed, stale, and out-of-order events.

Exit criteria: forged events return 401; valid events return quickly; duplicates do not create duplicate jobs or cases.

### Phase 2 — Recovery domain engine

- Build recovery-case state machine.
- Classify failure as transient, customer-actionable, payment-method-invalid, merchant/configuration, risk/compliance, or unknown.
- Add deterministic cohort assignment.
- Add stopping rules, cooldown, contact caps, promise-to-pay pause, opt-out, terminal-state handling, and manual review.
- Record a tamper-evident audit chain.

Exit criteria: replayed/out-of-order events preserve correct state and every transition verifies against its audit chain.

### Phase 3 — Hybrid AI decisioning

- Implement deterministic decision provider for offline use and reproducible tests.
- Add optional OpenAI Responses provider with strict JSON Schema output and `store: false`.
- Send only minimized structured features.
- Detect obvious indirect prompt-injection content for security telemetry, but never rely on detection as authorization.
- Validate all model output and fail closed to deterministic decisions/human review.

Exit criteria: malformed, unavailable, slow, or adversarial model responses cannot create an unsafe action.

### Phase 4 — Policy authorization

- Convert recommendations into typed action proposals.
- Re-derive amount, currency, recipient, expiry, and case ownership from trusted storage/provider reads.
- Apply action allowlist, value thresholds, cooldowns, notification caps, cohort rules, and kill switches.
- Require manual approval for configured high-value or uncertain actions.

Exit criteria: property/negative tests prove an LLM cannot alter authoritative financial parameters.

### Phase 5 — Razorpay Test Mode adapter

- Fetch payments for source-of-truth verification.
- Fetch outstanding subscription invoices when a subscription event lacks a payment entity.
- Create standard expiring Payment Links with unique references and reminders disabled.
- Fetch and cancel Payment Links.
- Use timeouts, bounded retries for safe reads, and redacted errors.
- Provide a faithful mock adapter for deterministic tests.

Exit criteria: contract tests cover authentication, request bodies, provider errors, timeouts, and duplicate-link responses; optional live smoke test runs only with user-provided Test Mode credentials.

### Phase 6 — Execution and outcome verification

- Execute approved proposals via an outbox worker.
- Persist intent before external calls and reconcile uncertain outcomes by unique reference ID.
- Close cases only on verified captured/paid events or trusted provider fetches.
- Cancel still-open links after recovery, suppression, or expiry where permitted.
- Handle partial payment, late authorization, duplicated success, and success-before-failure delivery.

Exit criteria: a full failed-payment -> link -> paid flow is idempotent and reports exactly-once recovered value.

### Phase 7 — Metrics and evaluation

- Report detected revenue, eligible revenue, contacted revenue, recovered revenue, recovery rate, time-to-recovery, and outcome by failure category/intervention.
- Separate treatment and holdout metrics; calculate absolute uplift only when both cohorts have observations.
- Report operational/security counters: duplicates, signature failures, policy blocks, AI fallbacks, stale/out-of-order events, and manual reviews.
- Add a seeded event-stream evaluator with benign and adversarial scenarios.

Exit criteria: metrics are derived from immutable events/actions rather than mutable dashboard counters.

### Phase 8 — Minimal operator UI

- Dashboard summary and cohort metrics.
- Case queue with filters and states.
- Case detail with event timeline, proposed/blocked actions, provider link, and audit proof.
- Manual approve, suppress, resume, and run-worker controls for local demonstration.
- Clearly label mock versus Razorpay Test Mode.

Exit criteria: the complete demo can be operated without editing the database or using curl.

### Phase 9 — Verification and demo hardening

- Unit tests for classification, state transitions, policy, signatures, and audit chain.
- Integration tests for SQLite transactions, webhook API, worker, provider adapter, and metrics.
- End-to-end tests for successful recovery, hard decline, transient wait, partial payment, replay, forged signature, prompt injection, opt-out, stale/out-of-order events, provider timeout, and kill switch.
- Concurrency test for duplicate deliveries.
- Optional real Razorpay Test Mode smoke test, excluded from default CI.
- Create a seeded five-minute demo script and evidence report.

Exit criteria: clean install, lint/typecheck, full test suite, and deterministic demo pass.

## Edge-case matrix

| Edge case | Required behaviour |
|---|---|
| Duplicate event ID | Acknowledge; no duplicate job/action |
| Same failure with different event IDs | Attach to active case; do not duplicate contact |
| Captured event arrives before failed event | Preserve recovered terminal state |
| Old pending event arrives after charged | Record as stale; never reopen |
| Invalid signature | Reject before parsing/processing |
| Secret rotation | Accept current or explicitly configured previous secret |
| Missing event ID | Reject in strict mode; optional quarantine in development |
| Unknown event | Store and acknowledge; no action |
| Malformed entity | Quarantine/manual review; no action |
| Missing amount on subscription | Fetch issued invoice; otherwise manual review |
| Currency not allowed | Manual review |
| Zero/negative/too-large amount | Block |
| Provider API timeout after link creation | Reconcile by unique reference before retrying |
| Duplicate link reference | Fetch existing link and verify equivalence |
| Link partially paid | Track partial value; leave case open |
| Link paid twice/duplicate paid webhook | Count recovered value once |
| Link expires | Rescore case; do not silently recreate indefinitely |
| Customer opts out | Suppress all pending contact/action outbox entries |
| Promise to pay | Pause until promised date; no reminders during pause |
| Contact cap/cooldown | Block and audit |
| Control cohort | Observe outcomes; no automated intervention |
| AI timeout/invalid JSON | Deterministic fallback or human review |
| Prompt injection in notes/description | Exclude from authority and model input; log signal |
| AI suggests disallowed tool or amount | Schema/policy rejection |
| Worker crash | Durable job resumes without duplicate external action |
| Database transaction failure | No webhook acknowledgement claiming successful enqueue |
| Global kill switch | No new external actions; ingestion and observation continue |

## Definition of done

- The repository contains executable backend and minimal UI code, not only diagrams.
- Default local mode needs no third-party credentials.
- Razorpay mode rejects non-test keys and can use real user-supplied Test Mode credentials.
- The complete default test suite runs offline and covers security, business, failure, and concurrency paths.
- No test asserts fabricated business success; a seeded evaluation generates the displayed metrics.
- Documentation explains which flows are real Razorpay Test Mode flows and which records are synthetic.
