# PayArc

PayArc is a zero-trust AI revenue-recovery backend for the Razorpay AI Buildathon. It consumes signed failure events, classifies the next-best intervention, authorizes it through deterministic financial policy, creates bounded Razorpay Test Mode Payment Links, and counts revenue only after a verified payment outcome.

## Flagship innovation: the Recovery Decision Passport

PayArc is not a Payment Link generator. It builds a counterfactual Revenue Digital Twin for each obligation and selects from a recovery hierarchy: observe an active checkout, reuse the original checkout, wait for a provider-managed retry, remove a merchant blocker, contact with consent, or create one bounded replacement as a last resort. Every decision carries a visible passport with:

- **causal proof** — deterministic holdouts separate natural recovery from money caused by the intervention;
- **path conservation** — an existing checkout or provider retry is preserved before a new payment path is allowed;
- **a financial safety envelope** — provider-verified amount, expiry, idempotency, contact limits, stopping rules, and signed audit evidence.

This turns revenue recovery into a portfolio-level control problem: maximize *incremental* recovered money while minimizing duplicate-debit risk, customer fatigue, and unsafe retries. A decision to wait or suppress can therefore be more valuable than sending another link.

## What is implemented

- Razorpay-inspired React + TypeScript operator dashboard with functional navigation, search, notifications, case operations, analytics, security, and integration views
- Fastify + TypeScript orchestration API
- SQLite durable event/job/case/action storage using Node's built-in SQLite
- Raw-body Razorpay HMAC verification and secret rotation
- At-least-once deduplication and out-of-order handling
- Payment/subscription/link webhook normalization
- Hard/soft/merchant/risk failure classification
- Treatment/control assignment and recovery-uplift metrics
- Deterministic decision engine plus optional OpenAI strict structured-output adapter
- Deterministic policy gate with contact caps, cooldown, opt-out, pause, approval, value threshold, currency allowlist, and kill switch
- Real Razorpay Test Mode adapter for payment verification, subscription invoice lookup, Payment Link lookup/create/fetch/cancel
- Partial/full/expired/cancelled outcome verification
- Hash-chained audit ledger
- PII-redacted stored webhook bodies and no persisted customer email/contact in cases
- Interactive operator UI with 15 executable payment, subscription, lifecycle, resilience, and security scenarios
- Persistent Revenue Digital Twin spanning payment incidents, checkout journeys, subscriptions, mandates, B2B receivables, consent-aware conversations, and promise-to-pay objects
- Portfolio optimizer that ranks interventions by incremental value after natural recovery, cost, customer-fatigue, and duplicate-debit risk
- Live payment-degradation circuit breakers driven by signed Razorpay downtime webhooks with staged traffic release
- Checkout SDK API that observes active customers, reuses valid checkout URLs, and creates a replacement only when the original checkout is unavailable
- Dynamic responsive pages for every playbook, causal revenue metrics, and end-to-end batch execution
- Authenticated realtime synchronization plus URL-persistent views and case drawers
- Consent-aware WhatsApp click-to-chat and optional approved-template Cloud API delivery with no plaintext recipient persistence
- Bounded concurrent autopilot workers, scheduled decision cooldowns, and exception-only merchant review
- Just-in-time Razorpay contact resolution from the payment linked to an order, with order/payment note consent proof and idempotent automatic WhatsApp delivery
- Dual-mode Scenario Lab: genuine Razorpay Test Orders and hosted Checkout failures enter merchant cases through signed webhooks, while unsafe/provider-unavailable edge cases remain isolated
- Built-in Operator Guide and complete workflow manual in [docs/USER_GUIDE.md](./docs/USER_GUIDE.md)
- Offline automated security, integration, provider-contract, concurrency, and end-to-end tests

The detailed sequence and edge-case matrix are in [the roadmap](./docs/ROADMAP.md). Research evidence is in [research notes](./docs/RESEARCH.md), security boundaries are in [the threat model](./docs/THREAT_MODEL.md), and the polyglot decision is explained in [the architecture](./docs/ARCHITECTURE.md).

## Local start

Requirements: Node.js 24 or newer.

```bash
npm install
cp .env.example .env
npm test
npm run build:ui
npm run dev
```

Open <http://127.0.0.1:3000>. The default is safe mock mode. The Scenario Lab can execute all 15 deterministic flows through isolated ingestion, worker, policy, action, outcome, metrics, and hash-chained audit boundaries without credentials. In Razorpay mode it also creates genuine Test Orders, launches hosted Standard Checkout, and admits failed payments into merchant Recovery Cases only through signed Razorpay webhooks.

For frontend hot reload, keep the backend running and start `npm run dev:ui` in a second terminal, then open <http://127.0.0.1:5173>.

Seed a richer local dataset:

```bash
npm run demo:seed
```

## Razorpay Test Mode

Never commit credentials. In the Razorpay Dashboard, switch to Test Mode, generate a Test key, and configure a separate webhook secret. Then set:

```dotenv
PAYMENT_PROVIDER_MODE=razorpay
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
EXTERNAL_ACTIONS_ENABLED=true
AUTO_ACTIONS_ENABLED=true
WHATSAPP_AUTO_SEND_ENABLED=true
OPERATOR_API_TOKEN=<at-least-32-random-characters-in-production>
```

Configure the public HTTPS webhook URL as:

```text
https://your-host.example/webhooks/razorpay
```

Subscribe to:

```text
payment.failed
payment.authorized
payment.captured
payment.downtime.started
payment.downtime.updated
payment.downtime.resolved
order.paid
subscription.pending
subscription.halted
subscription.charged
subscription.activated
payment_link.paid
payment_link.partially_paid
payment_link.expired
payment_link.cancelled
```

Razorpay documents that common tunnel domains are blocked for webhooks and recommends a supported public staging URL or `zrok` for localhost testing. Test webhook payloads have the same structure as live events. See [Razorpay webhook testing](https://razorpay.com/docs/webhooks/validate-test/).

The adapter refuses any key not starting with `rzp_test_`. Standard Test Mode Payment Links are capped at 30 per business, so use mock mode for bulk evaluation and real Test Mode for the judged end-to-end proof. [Razorpay Payment Link documentation](https://razorpay.com/docs/api/payments/payment-links/create-standard/)

Read-only connectivity smoke check:

```bash
RAZORPAY_SMOKE_PAYMENT_ID=pay_... npm run smoke:razorpay
```

## Optional AI provider

Without an AI key the project uses a deterministic and fully testable recovery decision engine. To add model reasoning:

```dotenv
OPENAI_API_KEY=...
OPENAI_MODEL=<a structured-output model available to your account>
```

The adapter sends only minimized structured failure features—never names, email, contact, free-text notes, amounts proposed by users, or API credentials. It uses the OpenAI Responses API with strict JSON Schema, no tools, and `store: false`. Every result is re-authorized by deterministic policy; invalid or unavailable model output falls back safely. [Official OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

## Verification

```bash
npm run typecheck
npm test
npm run test:coverage
npm audit --omit=dev
```

The default tests are offline. The live Razorpay smoke command is deliberately separate because it requires credentials and an existing Test Mode payment.

## API reference

See [docs/API.md](./docs/API.md).
