# PayArc Operator Guide

## The problem in plain language

A failed payment is not automatically lost revenue. The customer may still be retrying, Razorpay may retry a subscription, the bank may be temporarily unhealthy, an invoice may have a merchant-side dispute, or the payment may already have succeeded late. Sending every customer another link creates noise and duplicate-payment risk.

PayArc builds one stateful revenue obligation, chooses the least disruptive safe action, delivers it through a consented channel, stops on payment or opt-out, and measures only incremental recovery above a holdout baseline.

## The real Razorpay flow

1. Keep `npm start` and the public HTTPS tunnel running.
2. Razorpay sends a signed `payment.failed` event to `/webhooks/razorpay`.
3. PayArc verifies the raw-body signature, deduplicates the event, and creates or updates one case.
4. The worker fetches authoritative payment facts, classifies the failure, and chooses a recovery action.
5. Eligible low-risk actions are scheduled and executed automatically. Only policy exceptions appear in **Needs your attention**.
6. PayArc reuses an existing checkout or creates one bounded Razorpay Test Mode Payment Link after the decision cooldown.
7. PayArc resolves the contact just-in-time from the trusted Razorpay payment associated with the order. If the order or payment contains `payarc_whatsapp_opt_in=true`, Cloud API mode sends the approved template automatically. Click-to-chat mode prepares the message automatically for one-click operator send.
8. Complete the payment on Razorpay's hosted page.
9. Razorpay sends `payment_link.paid`; the backend verifies and reconciles it.
10. The open UI receives a live sync event and changes the case to **Recovered** without a browser refresh.

The browser URL stores `view` and `case`, so refresh, back, and forward restore the same workspace and drawer.

## What every page does

| Page | Meaning | Primary actions |
|---|---|---|
| Overview | Portfolio health and operator queue | Open Autopilot, inspect a case |
| Recovery Autopilot | Ranks work by incremental value, not gross amount | Set budget, Optimize, Run selected batch |
| Payment Intelligence | Detects provider degradation and prevents retry storms | Resolve incident, staged release |
| Checkout Journeys | Separates active retries from abandonment | Observe, simulate abandonment, reuse checkout |
| Recurring Revenue | Subscription and mandate recovery | Advance subscription, evaluate next mandate step |
| B2B Receivables | Invoice aging, blockers, and collections | Resolve blocker, run next action |
| Promises & Voice | Structured Hinglish intents and promise ledger | Promise tomorrow, Send UPI, Already paid, Opt out |
| Recovery Cases | Evidence and bounded execution for one obligation | Approve, Execute, WhatsApp, Pause, Suppress |
| Scenario Lab | Real Razorpay Test Checkout plus isolated edge-case simulations | Launch a genuine failed payment or run any of 15 controlled scenarios |
| Events & Audit | Signed event history and hash-chained decisions | Inspect evidence |
| Analytics | Treatment-versus-control recovery measurement | Read causal uplift |
| Security Center | Forgery, replay, injection, and tamper controls | Run security proofs, verify ledger |
| Integrations | Razorpay, AI, WhatsApp, webhook, and policy readiness | Copy webhook URL, inspect configuration |
| Operator Guide | Built-in walkthrough | Navigate directly to each workflow |

## Case buttons

- **Approve**: authorizes a proposed action after re-running policy.
- **Execute**: performs the bounded provider action exactly once.
- **Retry execution**: retries a failed provider call using the same idempotency reference.
- **Open/Copy Razorpay Payment Link**: uses the real hosted Test Mode URL.
- **WhatsApp delivery**: shows the masked Razorpay contact, its source, and the consent proof. There is no phone-number field. An operator attestation is available only as a controlled fallback.
- **Pause 24h**: stops contact during a promise-to-pay window.
- **Suppress**: permanently stops outreach for the case.

## Scenario Lab: genuine Razorpay proof

1. Connect Razorpay Test Mode keys and configure `payment.failed`, `payment.authorized`, `payment.captured`, and `order.paid` webhooks.
2. Open **Scenario Lab**, enter the amount in rupees, and click **Launch real test checkout**.
3. PayArc creates a Razorpay Order on the server and opens hosted Standard Checkout with the public Test Key ID.
4. Choose a payment method and select **Failure** on Razorpay's mock bank page. Do not close the backend or public webhook tunnel.
5. The run changes from **Checkout Ready** to **Failure Received** only after a valid Razorpay webhook arrives.
6. The background worker fetches the payment from Razorpay and creates the case. Click **Open Recovery Case** from the run card.

Choosing **Success** proves the non-recovery branch: PayArc verifies the Checkout HMAC and fetches the authoritative payment, but correctly creates no recovery case because no revenue is at risk. The 15 controlled scenarios below this panel remain isolated for provider outages, replay, forgery, prompt injection, and other conditions Razorpay cannot expose safely on demand.

## WhatsApp modes

`click_to_chat` is the default and needs no credentials. It prepares a `wa.me` URL and leaves the final send under operator control.

`cloud_api` calls the WhatsApp Business Platform using an approved utility template. Configure `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, template name, language, and Graph API base URL. Cloud mode also requires `EXTERNAL_ACTIONS_ENABLED=true`.

For unattended delivery, set `WHATSAPP_AUTO_SEND_ENABLED=true` and write explicit consent when creating the Razorpay order:

```json
{
  "notes": {
    "payarc_whatsapp_opt_in": "true"
  }
}
```

The customer number comes from the associated payment entity (or outstanding subscription invoice), because Razorpay orders do not themselves contain a customer phone field. The order note provides the consent evidence. PayArc reads both from authenticated Razorpay APIs at action time and stores only a keyed recipient hash.

The approved template must accept three body parameters in this order: amount, payment URL, and case reference. It should identify the merchant, explain the recovery purpose, and include opt-out language.

## Winning differentiation

The Payment Link and WhatsApp message are actuators, not the invention. The invention is the Recovery Decision Passport:

1. **Causal proof**: a deterministic holdout estimates natural recovery.
2. **Path conservation**: active and valid payment paths are preserved before replacement.
3. **Safety envelope**: amount, expiry, idempotency, consent, cooldowns, contact caps, stopping rules, and signed evidence travel with the decision.

This lets PayArc count protected revenue—money saved by *not* running an unsafe retry—alongside incremental recovered revenue.
