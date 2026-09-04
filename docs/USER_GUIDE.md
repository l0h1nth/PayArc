# PayArc merchant and demo guide

## PayArc in plain language

PayArc watches money that should reach the merchant but has not. It finds the likely reason, chooses the least disruptive safe next step, performs routine work automatically, stops when it should, and proves whether its intervention recovered the money.

The merchant is not expected to open every failed transaction or type every customer phone number. The autopilot handles eligible cases in the background. The merchant queue contains only cases that need approval, missing information, a policy exception, or an explicit business decision.

## What is automatic

For an eligible treatment case, PayArc can automatically:

1. ingest and verify the Razorpay event;
2. create/update the revenue obligation and recovery case;
3. diagnose the failure;
4. obtain an AI or deterministic recommendation;
5. run deterministic policy checks;
6. schedule a cooldown with a visible timer;
7. reuse a valid checkout or create one bounded last-resort Razorpay Test Mode Payment Link;
8. create/update the permanent Smart Recovery Session;
9. resolve the customer contact from Razorpay just in time;
10. send an approved WhatsApp message when consent and fatigue rules allow;
11. react to signed customer intent;
12. verify payment outcomes and stop remaining work;
13. update causal metrics and the audit ledger.

Control-cohort cases deliberately receive no recovery contact. High-value, risky, consent-missing, merchant-actionable, or ambiguous cases can require human review.

## First setup

### Safe local demonstration

```bash
npm install
cp .env.example .env
npm run dev
```

Open <http://127.0.0.1:3000>. Mock mode exercises the complete internal workflow without external credentials.

### Real Razorpay Test Mode demonstration

Configure Test Mode API keys and a webhook secret as described in the main README. Expose the server through an HTTPS tunnel and configure Razorpay to send events to:

```text
https://your-public-host/webhooks/razorpay
```

Keep PayArc, the public tunnel, and the Razorpay webhook enabled during the demo.

## Page-by-page guide

### Overview

Use this as the merchant’s daily summary.

- **Revenue at risk** is the outstanding value of unique obligations, not duplicated attempts.
- **Gross recovered** is all verified recovered money.
- **Incremental recovered** removes estimated natural/control recovery.
- **Protected revenue** is money shielded from unsafe retries or duplicate-payment risk.
- **Open promises** shows active promise-to-pay commitments.
- **Audit ledger** must remain valid.

Open the action queue only when PayArc reports an exception. Routine cases continue automatically.

### Portfolio optimizer

This ranks obligations by expected incremental value after natural recovery, cost, customer fatigue, and risk. Use it to explain why PayArc may recover a smaller high-probability case before a larger low-value or unsafe case.

Batch execution remains bounded by policy and concurrency limits. Selecting a batch does not bypass individual case checks.

### Payment intelligence

This page groups provider-wide degradation rather than blaming each customer.

- **Healthy**: normal policy applies.
- **Incident held**: matching transient retries are paused.
- **Quiet window**: PayArc waits for evidence that the provider has recovered.
- **Canary**: 25% of eligible traffic is released.
- **Recovered/reopened**: the remaining cohort can proceed.

If failures continue during canary, PayArc holds the cohort again. The merchant does not need to suppress every case manually.

### Checkout journeys

This distinguishes a genuine abandonment from an active customer. PayArc observes an active checkout, reuses a valid checkout, and creates a replacement only when the original path is unavailable and policy permits it.

### Recurring revenue

This shows failed subscriptions, invoices, and mandate attempts. PayArc respects Razorpay/provider retry schedules and advances only the next safe step, preventing duplicate debits.

### B2B receivables

This joins overdue invoice state, merchant blockers, customer contact, and promise-to-pay. Fix a merchant-owned blocker before contacting the payer. Recorded promises remain open until payment is verified or the promise expires.

### Promises & voice

This displays intent captured from supported channels. A Hinglish or plain-language response can become a bounded intent such as promise-to-pay or UPI preference. It cannot directly mark an invoice paid.

### Recovery cases

This is the exception and investigation workbench. The top tabs are computed from current case states, so counts change when a case is created, scheduled, suppressed, partially recovered, or recovered.

Open a row to inspect:

- failure evidence and source;
- amount at risk and verified recovery;
- treatment/control cohort;
- Recovery Decision Passport;
- counterfactual wait-versus-act estimate;
- policy status and timer;
- Smart Recovery Session and delivery state;
- complete audit timeline.

### Scenario Lab

Use isolated scenarios to demonstrate rare, unsafe, or provider-unavailable branches. Use real Razorpay Test Mode scenarios to prove genuine hosted Checkout and signed-webhook integration.

Running a scenario creates or updates visible data. Real Test Mode cases appear only after Razorpay sends the signed failure webhook; creating a Test Order alone is not a payment failure.

### Events & audit

Use this to show that provider input was signature-verified, normalized, redacted, and linked to a case. Audit-chain validation recomputes the stored hashes.

### Analytics

Use treatment-versus-control metrics to answer the key judging question: “How much money did PayArc cause to recover?” Gross recovery alone is not claimed as AI impact.

### Security Center

Run fail-closed demonstrations for forged signatures, replay/deduplication, prompt injection, provider errors, and audit tampering. These are security proofs, not production attacks.

### Integrations

Check Razorpay, webhook, AI, WhatsApp, public URL, and autopilot readiness. The page reports whether configuration is present without revealing secret values.

### Operator Guide

This is the in-product quick manual and judge-demo sequence. Use this document for the full explanation.

## Recovery case statuses

| Status | Meaning | Merchant action |
| --- | --- | --- |
| Action Required | A decision exists but an exception needs attention | Inspect passport; approve, pause, or suppress |
| Human Review | Policy explicitly requires a person | Confirm evidence and authorize only if appropriate |
| Waiting | Cooldown, promise, provider retry, or incident hold is active | Usually none; watch the timer/reason |
| Actioned | The authorized recovery step ran | Wait for signed outcome |
| Partially Recovered | Some value was verified but a balance remains | Let the same obligation/session continue safely |
| Recovered | Full value was verified | None; automation has stopped |
| Exhausted | The bounded path expired or retry budget ended | Review only when new provider/customer evidence exists |
| Suppressed | Contact/action was stopped by policy, customer, or merchant | Terminal; create new work only with legitimate new consent/evidence |

The red sidebar badge represents the current actionable exception count—Action Required, Human Review, and Partially Recovered—not the total number of cases.

## Case buttons and controls

### Approve

Authorizes the proposed action when policy requires human review. Approval does not skip provider verification, consent, fatigue, cooldown, or idempotency checks.

### Run now / Retry execution

Asks the worker to execute an already authorized action immediately or retry the same failed action. It retains the action’s idempotency key. Do not use it to bypass an active failure swarm; incident-held actions remain held.

### Smart Recovery Link

Copies or opens the permanent PayArc customer URL. This is the recommended link to share because its safe destination can change without sending another message. It may display:

- waiting for a safe time/path;
- ready to continue through Razorpay;
- UPI-preferred recovery;
- verified paid receipt;
- closed or expired state.

### Open Razorpay checkout

This is a direct provider fallback shown only when a current authorized Razorpay path exists. The permanent PayArc Smart Link is preferred for customer communication.

### Send or prepare WhatsApp

PayArc resolves the customer contact from the Razorpay payment, order payments, or subscription invoice immediately before use. In Cloud mode, it sends the configured approved template automatically. In click-to-chat mode, it prepares a merchant-controlled handoff. Missing consent, missing contact, opt-out, or exhausted fatigue budget prevents delivery.

### Pause

Temporarily stops scheduled execution/contact while preserving the case and its evidence. Use it for a short operational or customer-requested hold.

### Suppress

Stops the matching case and closes its Smart Recovery Session. Existing pending actions become ineligible because the case is terminal; their historical records remain in the audit trail. A signed customer `STOP` reply applies the same case-level stop automatically.

### Pay in full / simulated outcome

Available only in isolated mock scenarios to demonstrate verified workflow transitions without contacting Razorpay. Real Test Mode recovery must arrive through Razorpay provider state and signed webhooks.

## Smart Recovery customer experience

The customer should receive one PayArc URL. Opening it does not automatically charge anything.

1. PayArc resolves the obligation and stopping rules.
2. If a provider incident is active, the page explains that recovery is waiting safely.
3. When ready, it offers the currently authorized payment path.
4. The customer completes payment on Razorpay-hosted Checkout.
5. Razorpay sends the outcome webhook.
6. PayArc verifies the outcome and turns the same URL into a paid receipt.

This avoids repeated dead links and reduces confusion when the safe payment path changes.

## WhatsApp customer replies

Supported bounded intents include:

- **STOP / unsubscribe**: suppress the matching recovery case and close its Smart Session.
- **Promise-to-pay**: record when the customer intends to pay and stop premature reminders until the promise becomes due.
- **Prefer UPI**: store a recovery preference and update the Smart Session where possible.
- **Already paid**: check Razorpay; close only if provider truth confirms it.

Unknown text is recorded only as a redacted/unknown intent and cannot authorize a payment or override policy.

## Seven-minute judge demo

1. **Problem (30 seconds):** failed revenue is fragmented, and blind retries create risk and fatigue.
2. **Real failure (60 seconds):** launch a Razorpay Test Mode Checkout failure from Scenario Lab.
3. **Realtime detection (30 seconds):** show the signed event and automatically created case without refreshing.
4. **Agent plus passport (60 seconds):** show the AI recommendation, counterfactual, path conservation, and safety envelope.
5. **Autopilot (60 seconds):** show the timer, policy authorization, contact resolution, and permanent Smart Link.
6. **Customer loop (60 seconds):** demonstrate WhatsApp intent or open the Smart Session and complete Test payment.
7. **Verified stop (30 seconds):** show the case become recovered and remaining actions stop.
8. **Portfolio innovation (60 seconds):** trigger a failure swarm, cohort hold, quiet window, and 25% canary.
9. **Proof (30 seconds):** show incremental recovery, treatment/control comparison, and valid audit chain.

## Recommended demonstration order

Start with one isolated scenario to explain the UI, then use one real Razorpay Test Mode payment failure for external proof. Use the downtime/failure-swarm scenario after the audience understands a single case. End with Analytics and Events & audit.

## Common issues

### A Test Order was created but no case appeared

A Test Order is not a failed payment. Open hosted Checkout, complete a test failure, confirm Razorpay delivered the signed webhook, and check that the tunnel points to the active PayArc port.

### The webhook returns a signature error

Use the webhook secret configured on that Razorpay webhook, not the API key secret. Confirm there is no proxy/body parser changing the raw request bytes before verification.

### The recovery path is waiting

Open the timer or policy explanation. Common reasons are cooldown, active provider incident, deterministic control cohort, promise-to-pay, contact fatigue, merchant pause, or provider-managed retry.

### WhatsApp was not sent

Check Integrations and channel readiness. PayArc requires a resolvable contact, consent proof, available customer-wide fatigue budget, Cloud API configuration for automatic sending, and an action that is still eligible.

### A customer says they paid but the case remains open

PayArc intentionally trusts Razorpay, not text. Confirm the payment belongs to the same obligation and that the signed paid/captured event reached PayArc.

### The dashboard did not update

Confirm the API is reachable and the Live indicator is connected. The UI uses authenticated server-sent events and should update without manual refresh. Refreshing preserves the current page and case route.

### A count looks different from the total table rows

The sidebar badge is the actionable exception count: Action Required, Human Review, and Partially Recovered. The All tab is the total case count. Filter tabs are recomputed from the current database state.

## Safe operating checklist

- Keep Test Mode enabled for the hackathon demonstration.
- Keep provider execution explicitly gated.
- Use one webhook secret per environment and rotate safely.
- Confirm `PUBLIC_BASE_URL` before sharing a Smart Link.
- Do not paste credentials into screenshots, issues, or commits.
- Treat Human Review as a real safety stop.
- Use suppression when consent is withdrawn.
- Verify the audit ledger before presenting recovery claims.
