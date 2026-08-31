# Research notes and design implications

Research was performed against current primary product documentation on 29 August 2026. The implementation follows the conclusions below.

## Razorpay behaviour

- Razorpay webhooks are asynchronous, use at-least-once delivery, can be duplicated, and can arrive out of order. The raw request body must be used for HMAC-SHA256 verification, while `x-razorpay-event-id` identifies duplicate deliveries. This directly motivated raw-body validation, durable enqueue-before-acknowledgement, unique event IDs, and order-independent state transitions. [Validate and test webhooks](https://razorpay.com/docs/webhooks/validate-test/) and [webhook best practices](https://razorpay.com/docs/webhooks/best-practices/)
- Failed payment entities expose structured `error_code`, `error_description`, `error_source`, `error_step`, and `error_reason` fields. PayArc classifies from programmatic fields and does not treat the free-text description as authority. [Payments entity](https://razorpay.com/docs/api/payments/entity/)
- A subscription moves to `pending` after a failed charge and Razorpay performs provider-managed retries. Once retries are exhausted it moves to `halted`; earlier unpaid invoices are not automatically retried after reactivation. PayArc waits during transient pending states and intervenes on halted/outstanding invoices. [Payment retries](https://razorpay.com/docs/payments/subscriptions/payment-retries/) and [subscription states](https://razorpay.com/docs/payments/subscriptions/states/)
- Subscription webhooks may contain the payment entity when a payment attempt occurred. When amount data is absent, the invoices endpoint returns outstanding `amount_due`, currency, status, and short URL. [Subscription webhook events](https://razorpay.com/docs/webhooks/subscriptions/) and [fetch subscription invoices](https://razorpay.com/docs/api/payments/subscriptions/fetch-invoices/)
- Standard Payment Links support unique references, explicit amount/currency, expiry, reminders, and created/partially-paid/paid/expired/cancelled states. Test Mode is limited to 30 links per business. PayArc disables Razorpay reminders, uses a unique deterministic reference, and observes link webhooks. [Create a Standard Payment Link](https://razorpay.com/docs/api/payments/payment-links/create-standard/), [fetch by reference](https://razorpay.com/docs/api/payments/payment-links/fetch-all-standard/), and [Payment Link webhooks](https://razorpay.com/docs/webhooks/payment-links/)
- Test Mode uses simulated transactions and no real money moves. Test webhook payload structures match live payloads. [Standard Checkout Test Mode](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/) and [webhook testing](https://razorpay.com/docs/webhooks/validate-test/)

## Revenue-recovery patterns

- Mature dunning systems distinguish hard declines that require payment-method/customer intervention from soft declines that can succeed later. They also pause retries around a promise-to-pay and stop dunning when appropriate. [Chargebee dunning](https://www.chargebee.com/docs/payments/2.0/dunning/dunning-v2)
- Recovery should be measured across attempts by both count and money volume, segmented by failure reason and payment method. [Chargebee retry and recovery analysis](https://www.chargebee.com/docs/reveal/transactions/understanding-payment-performance/retry-analysis-and-order-recovery)
- Commercial recovery systems combine tactical retries, bounded customer notifications, payment-method update paths, and suppression of messages after recovery. [Paddle Retain recovery cadence](https://www.paddle.com/help/profitwell-metrics/retain/how-it-works/retain-payment-recovery-how-it-works-retry-cadence)

These patterns motivated the hard/soft classifier, explicit WAIT action, contact caps/cooldowns, promise-to-pay pause, treatment/control cohorts, and verified money-recovered metrics.

## Agent and AI security

- OWASP recommends treating external content as untrusted, separating instructions from data, using least privilege, and independently validating proposed tool calls. PayArc therefore gives the AI no tools and validates its typed recommendation with deterministic policy. [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- OWASP identifies excessive functionality, permissions, and autonomy as causes of damaging agent actions. PayArc constrains all three: one recommendation schema, no direct API permission, and manual/policy gates. [OWASP Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- NIST recommends documenting AI scope, third-party risks, human oversight, testing, evaluation, verification, and validation. These appear as explicit scope/non-goals, an operator approval path, reproducible tests, and an immutable audit trail. [NIST AI RMF](https://www.nist.gov/itl/ai-risk-management-framework)
- The optional OpenAI adapter uses the Responses API with strict JSON Schema output, no tools, minimized inputs, and `store: false`; malformed or unavailable responses fall back deterministically. [Official OpenAI Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)

## Novel combination

No single referenced system is copied. PayArc combines:

1. Razorpay-native Test Mode events and recovery links.
2. Provider-aware dunning coordination instead of competing retries.
3. AI classification without AI authorization.
4. Treatment/control measurement of verified recovered money.
5. Replay-safe execution and hash-chained decision evidence.
6. An adversarial evaluation lane for forged, duplicated, stale, and prompt-injected inputs.
