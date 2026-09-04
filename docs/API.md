# HTTP API

All amounts use the smallest currency unit (paise for INR). Public responses never include API/webhook secrets or raw unredacted webhook bodies.

When `OPERATOR_API_TOKEN` is configured, every `/api/*` request requires `Authorization: Bearer <token>`. A token of at least 32 characters is mandatory in production. `/health`, `/recover/:id`, and provider webhooks use their own public/provider-authenticated boundaries.

`GET /recover/:id` is the public, opaque Smart Recovery Session. Its stored states are `WAITING`, `READY`, `PAID`, `CLOSED`, and `EXPIRED`; a paused case is rendered as a waiting experience. It navigates only to allowlisted Razorpay hosts (plus the mock test host outside Razorpay mode). The address is stable even when the provider destination changes. Responses use `Cache-Control: no-store` and a restrictive Content Security Policy.

## Conventions

- Amounts use the smallest currency unit (`98900` means ₹989.00 for INR).
- Time values are Unix seconds unless an endpoint states otherwise.
- IDs are opaque and must not be parsed for business meaning.
- Provider/event mutations are idempotent; clients may safely retry after an uncertain network response.
- `400` means malformed input, `401`/`403` authentication failure, `404` unknown or disabled resource, `409` a valid request blocked by current state/policy, and `502` an upstream provider failure.

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

Supported event names are:

```text
payment.failed                 payment.authorized
payment.captured               order.paid
payment.downtime.started       payment.downtime.updated
payment.downtime.resolved      subscription.pending
subscription.halted            subscription.charged
subscription.activated         payment_link.paid
payment_link.partially_paid    payment_link.expired
payment_link.cancelled
```

An authenticated but unsupported event is stored safely and ignored by the recovery engine; it does not create an action.

## Operations

- `GET /health` — process/provider/audit-chain health
- `GET /api/config` — redacted runtime mode and safety switches
- `GET /api/metrics` — business, cohort, operational, and security metrics
- `GET /api/cases` — recovery queue
- `GET /api/cases/:id` — case, actions, Smart Recovery Session, deliveries, and audit timeline; `channelReadiness` is intentionally `null` on this fast path
- `GET /api/actions/:id/channel-readiness` — resolve masked contact/consent readiness just in time; may perform Razorpay reads and is loaded only when the WhatsApp surface is opened
- `GET /api/actions` — recent action records
- `GET /api/events?limit=100` — redacted event-processing summaries without raw payloads or PII
- `GET /api/audit/recent?limit=30` — newest audit/security records for the live UI
- `GET /api/audit/verify` — validate the complete audit hash chain
- `GET /api/realtime` — authenticated Server-Sent Events stream that emits `sync` when durable recovery state changes
- `POST /api/worker/run` — synchronously process queued jobs and advance eligible failure swarms (demo/test helper)
- `POST /api/actions/:id/approve` — merchant approval with fresh policy evaluation
- `POST /api/actions/:id/execute` — execute an approved idempotent action
- `POST /api/actions/:id/whatsapp` with `{ "consentConfirmed": true }` — merchant fallback that resolves the trusted Razorpay contact automatically; the browser never submits a phone number and only a keyed recipient hash is stored
- `POST /api/cases/:id/suppress` — terminal contact opt-out/suppression
- `POST /api/cases/:id/pause` with `{ "until": <unix-seconds> }` — promise-to-pay pause

## WhatsApp inbound intent

- `GET /webhooks/whatsapp` — Meta verification challenge using `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `POST /webhooks/whatsapp` — raw-body `X-Hub-Signature-256` verification using `WHATSAPP_APP_SECRET`

Recognized replies are `STOP`/opt-out, promise-tomorrow (`kal`, `tomorrow`), UPI preference, and already-paid. PayArc resolves the case through the keyed recipient hash, stores no phone number or message text, deduplicates on WhatsApp message ID, and verifies already-paid claims against Razorpay before marking revenue recovered. Unknown intents are ignored safely.

A successful callback response contains the number of accepted messages and redacted intent outcomes:

```json
{
  "accepted": true,
  "processed": 1,
  "outcomes": [{ "intent": "SEND_UPI", "outcome": "Smart session updated with UPI preference" }]
}
```

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

Independent of downtime events, three matching transient failures inside two minutes create an automatic failure swarm. Eligible retries are atomically held, the worker starts a 25% canary after five quiet minutes, and each successful canary advances the next release stage.

## Razorpay Test Mode proof runs

These APIs are available only when the configured provider is Razorpay. Configuration rejects Live Mode keys.

- `GET /api/razorpay-test/runs` — connection readiness, public Test Key ID, and the 20 most recent provider-backed runs
- `POST /api/razorpay-test/runs` with `{ "amount": 98900, "currency": "INR", "description": "..." }` — create an exact-value Razorpay Test Order for hosted Standard Checkout
- `POST /api/razorpay-test/runs/:runId/verify` with Checkout's payment ID, order ID, and signature — verify the HMAC and authoritative payment state after success

Failed Checkout attempts are never accepted from the browser. Only Razorpay's signed `payment.failed` webhook moves a run to `FAILURE_RECEIVED`; the worker then uses the webhook's trusted `order_id` to create the merchant Recovery Case. Successful payments are verified but intentionally do not create recovery cases.

## Local mock-mode demonstration

These endpoints return 404 in production or Razorpay mode.

- `GET /api/demo/scenarios` — catalog of 15 executable judge-facing scenarios
- `GET /api/demo/runs` — recent isolated scenario runs
- `GET /api/demo/runs/:runId` — one run and its observed evidence
- `POST /api/demo/scenarios/:scenarioId/run` — execute a complete scenario and return expected/observed evidence
- `POST /api/demo/failure` — create an authenticated simulated failed-payment event
- `POST /api/demo/actions/:actionId/pay` — emit a paid/partially-paid Payment Link outcome

Example:

```bash
curl -sS -X POST http://127.0.0.1:3000/api/demo/scenarios/full-recovery/run \
  -H 'content-type: application/json' \
  -d '{}'
```

## Realtime synchronization

`GET /api/realtime` returns `text/event-stream`. The first event is `ready`; a `sync` event is emitted when the repository revision changes. Clients should invalidate relevant cached queries and reconnect with normal SSE retry behavior.

```text
event: ready
data: {"revision":42}

event: sync
data: {"revision":43}
```

The stream sends a comment heartbeat every 15 seconds and disables proxy buffering with `X-Accel-Buffering: no`.

## Automation and stopping semantics

An action request does not guarantee an external effect. Fresh policy evaluation may return waiting, blocked, suppressed, or review state. Automatic Razorpay execution requires `AUTO_ACTIONS_ENABLED=true` and `EXTERNAL_ACTIONS_ENABLED=true`; a manually approved/executed Razorpay action still requires `EXTERNAL_ACTIONS_ENABLED=true`. Global kill switch, control cohort, consent, fatigue, cooldown, amount, currency, provider incident, active path, and terminal outcome checks still apply.

The public session and case APIs reflect current durable state. They do not accept client-supplied amounts, payment status, customer contact data, or arbitrary redirect URLs.
