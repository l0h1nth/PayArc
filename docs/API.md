# HTTP API

All amounts use the smallest currency unit (paise for INR). Public responses never include API/webhook secrets or raw unredacted webhook bodies.

When `OPERATOR_API_TOKEN` is configured, every `/api/*` request requires `Authorization: Bearer <token>`. A token of at least 32 characters is mandatory in production. The Razorpay webhook and health endpoint remain separately accessible.

## Provider webhook

### `POST /webhooks/razorpay`

Required headers:

- `Content-Type: application/json`
- `X-Razorpay-Signature: <HMAC-SHA256 hex>`
- `X-Razorpay-Event-Id: <unique provider event ID>`

Responses:

- `202` accepted and durably queued
- `200` authenticated duplicate already stored
- `400` malformed envelope or missing event ID
- `401` signature failure

## Operations

- `GET /health` — process/provider/audit-chain health
- `GET /api/config` — redacted runtime mode and safety switches
- `GET /api/metrics` — business, cohort, operational, and security metrics
- `GET /api/cases` — recovery queue
- `GET /api/cases/:id` — case, actions, deliveries, masked just-in-time contact readiness, and audit timeline
- `GET /api/actions` — recent action records
- `GET /api/events?limit=100` — redacted event-processing summaries without raw payloads or PII
- `GET /api/audit/recent?limit=30` — newest audit/security records for the live UI
- `GET /api/audit/verify` — validate the complete audit hash chain
- `GET /api/realtime` — authenticated Server-Sent Events stream that emits `sync` when durable recovery state changes
- `POST /api/worker/run` — synchronously process queued jobs (demo/test helper)
- `POST /api/actions/:id/approve` — operator approval with fresh policy evaluation
- `POST /api/actions/:id/execute` — execute an approved idempotent action
- `POST /api/actions/:id/whatsapp` with `{ "consentConfirmed": true }` — operator fallback that resolves the trusted Razorpay contact automatically; the browser never submits a phone number and only a keyed recipient hash is stored
- `POST /api/cases/:id/suppress` — terminal contact opt-out/suppression
- `POST /api/cases/:id/pause` with `{ "until": <unix-seconds> }` — promise-to-pay pause

## Revenue Digital Twin

- `GET /api/revenue/snapshot` — incidents, journeys, subscriptions, mandates, receivables, conversations, promises, optimizer recommendations, and causal metrics
- `GET /api/revenue/operations?limit=100` — recent portfolio/playbook operations
- `POST /api/revenue/portfolio/optimize` with `{ "budget": 6 }` — rank and select bounded next-best actions by expected incremental value
- `POST /api/revenue/batch/run` — execute the selected local recovery playbooks and return recovered/protected value
- `POST /api/revenue/incidents/:id/resolve` — clear the outage circuit breaker and begin a 25% staged release
- `POST /api/revenue/incidents/:id/release` — release the next 25% of recovery traffic
- `POST /api/revenue/journeys` — register a tokenized checkout session and its existing checkout URL
- `POST /api/revenue/journeys/:id/signal` — submit checkout activity, failure, abandonment, or verified paid state
- `POST /api/revenue/journeys/:id/recover` — observe an active customer, reuse a valid checkout, or require a bounded replacement
- `POST /api/revenue/journeys/:id/pay` — local verified-payment demonstration
- `POST /api/revenue/subscriptions/:id/advance` — honor provider retry or request a method update
- `POST /api/revenue/mandates/:id/advance` — execute one bounded, outage-aware sequence decision
- `POST /api/revenue/receivables/:id/contact` — run the next blocker/contact playbook
- `POST /api/revenue/receivables/:id/resolve-blocker` — clear an invoice documentation blocker
- `POST /api/revenue/conversations/:id/respond` — submit a structured Hinglish/voice intent
- `POST /api/revenue/promises/:id/outcome` — reconcile a kept, missed, or cancelled promise

Signed `payment.downtime.started`, `payment.downtime.updated`, and `payment.downtime.resolved` webhooks automatically update the incident radar and circuit breaker. Checkout URLs are merchant-registered authoritative references; arbitrary webhook notes never become executable URLs.

## Razorpay Test Mode proof runs

These APIs are available only when the configured provider is Razorpay. Configuration rejects Live Mode keys.

- `GET /api/razorpay-test/runs` — connection readiness, public Test Key ID, and the 20 most recent provider-backed runs
- `POST /api/razorpay-test/runs` with `{ "amount": 98900, "currency": "INR", "description": "..." }` — create an exact-value Razorpay Test Order for hosted Standard Checkout
- `POST /api/razorpay-test/runs/:runId/verify` with Checkout's payment ID, order ID, and signature — verify the HMAC and authoritative payment state after success

Failed Checkout attempts are never accepted from the browser. Only Razorpay's signed `payment.failed` webhook moves a run to `FAILURE_RECEIVED`; the worker then uses the webhook's trusted `order_id` to create the merchant Recovery Case. Successful payments are verified but intentionally do not create recovery cases.

## Local mock-mode demonstration

These endpoints return 404 in production or Razorpay mode.

- `GET /api/demo/scenarios` — catalog of 15 executable judge-facing scenarios
- `POST /api/demo/scenarios/:scenarioId/run` — execute a complete scenario and return expected/observed evidence
- `POST /api/demo/failure` — create an authenticated simulated failed-payment event
- `POST /api/demo/actions/:actionId/pay` — emit a paid/partially-paid Payment Link outcome

Example:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/demo/scenarios/full-recovery/run \
  -H 'content-type: application/json' \
  -d '{}'
```
