# PayArc threat model

## Assets

- Razorpay Test Mode credentials and webhook secrets
- Financial integrity: case amount, currency, provider identity, and recovered totals
- Customer privacy and contact preferences
- Action authorization and Payment Link ownership
- Audit evidence and experiment assignments

## Trust boundaries

```text
Razorpay webhook (untrusted network)
  -> raw HMAC verifier
  -> durable event queue
  -> normalizer / PII minimizer
  -> AI recommendation (untrusted output)
  -> deterministic policy boundary
  -> Test Mode provider adapter
  -> verified outcome ledger
```

## Principal threats and controls

| Threat | Control |
|---|---|
| Forged webhook | HMAC-SHA256 over exact raw bytes; constant-time comparison |
| Replay/duplicate delivery | Unique provider event ID and action idempotency key |
| Out-of-order delivery | Provider-source verification, event timestamps, terminal-state invariants |
| Worker crash | Event and job committed in one SQLite transaction before 2xx acknowledgement |
| Prompt injection in notes | Notes excluded from authority/model input; signals logged; no model tools |
| Hallucinated amount/recipient | Policy re-derives financial parameters from case/provider records |
| Excessive agent authority | Closed action enum, no tool calls, approval threshold, kill switch |
| Link creation ambiguity | Unique reference; lookup by reference before creation/retry |
| Recovered-value inflation | Link ID/reference/amount/currency verification and max/cumulative accounting |
| Customer harassment | Control cohort, contact cap, cooldown, pause, opt-out, immediate terminal stop |
| Secret leakage | Environment-only secrets, public config allowlist, redacted errors |
| Unauthorized operator actions | Bearer authentication on `/api/*`; a strong token is mandatory in production |
| PII persistence | Webhook payload redaction and no email/contact persistence in cases |
| Audit tampering | SHA-256 hash chain with verification endpoint and test |
| Live-money accident | `rzp_test_` key enforcement and external-actions-off default |

## Residual risks

- SQLite is appropriate for a hackathon deployment, but multiple production replicas require a transactional shared database and queue.
- Signature validation proves Razorpay origin, not that every embedded free-text field is benign.
- Prompt-injection detection is telemetry, not a security boundary; deterministic authorization remains mandatory.
- Test Mode cannot reproduce all issuer, settlement, latency, or customer-behaviour distributions.
- Causal uplift needs enough treatment/control observations; the UI reports null rather than fabricating uplift when a cohort lacks data.
- A production notification connector needs consent proofs, template governance, regional compliance review, and a scoped customer-reference vault.
