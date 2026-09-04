import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition, isTerminal } from "../src/domain/state-machine.js";
import type { RecoveryCase, RecoveryDecision } from "../src/domain/types.js";
import { PolicyEngine } from "../src/services/policy-engine.js";
import { testConfig } from "./helpers.js";
import { loadConfig } from "../src/config.js";

function recoveryCase(overrides: Partial<RecoveryCase> = {}): RecoveryCase {
  return {
    id: "case_test", sourceKey: "payment:pay_test", entityType: "payment", entityId: "pay_test",
    paymentId: "pay_test", subscriptionId: null, orderId: "order_test", invoiceId: null,
    amount: 99_900, currency: "INR", customerEmail: "a@example.test", customerContact: "+919000090000",
    status: "ACTION_REQUIRED", failureClass: "CUSTOMER_ACTIONABLE", errorCode: "BAD_REQUEST_ERROR",
    errorReason: "incorrect_otp", errorSource: "customer", errorStep: "payment_authentication",
    recommendedAction: "SEND_RECOVERY_LINK", recommendationReason: "test", cohort: "TREATMENT",
    contactCount: 0, interventionCount: 0, recoveredAmount: 0, optedOut: false, pausedUntil: null,
    latestEventAt: 1_800_000_000, lastContactAt: null, createdAt: 1_800_000_000, updatedAt: 1_800_000_000,
    ...overrides
  };
}

const decision: RecoveryDecision = {
  action: "SEND_RECOVERY_LINK", confidence: 0.9, reason: "test", delaySeconds: 0,
  requiresHumanApproval: false, provider: "deterministic"
};

test("state machine preserves terminal recovery", () => {
  assert.equal(canTransition("ACTIONED", "RECOVERED"), true);
  assert.equal(isTerminal("RECOVERED"), true);
  assert.throws(() => assertTransition("RECOVERED", "ACTION_REQUIRED"));
});

test("policy derives authoritative values and requires operator approval by default", () => {
  const policy = new PolicyEngine(testConfig().policy).evaluate(recoveryCase(), decision, 1_800_000_100);
  assert.equal(policy.allowed, true);
  assert.equal(policy.requiresApproval, true);
  assert.equal(policy.authoritative.amount, 99_900);
  assert.equal(policy.authoritative.currency, "INR");
});

test("policy blocks control, opt-out, cooldown, invalid currency, and kill switch cases", () => {
  const base = testConfig({ CONTACT_COOLDOWN_SECONDS: "3600" });
  const engine = new PolicyEngine(base.policy);
  assert.equal(engine.evaluate(recoveryCase({ cohort: "CONTROL" }), decision, 1_800_000_100).allowed, false);
  assert.equal(engine.evaluate(recoveryCase({ optedOut: true }), decision, 1_800_000_100).allowed, false);
  assert.equal(engine.evaluate(recoveryCase({ lastContactAt: 1_800_000_000 }), decision, 1_800_000_100).allowed, false);
  assert.equal(engine.evaluate(recoveryCase({ currency: "USD" }), decision, 1_800_000_100).allowed, false);
  assert.equal(new PolicyEngine(testConfig({ GLOBAL_KILL_SWITCH: "true" }).policy).evaluate(recoveryCase(), decision, 1_800_000_100).allowed, false);
});

test("high-value cases are allowed only with approval", () => {
  const policy = new PolicyEngine(testConfig({ AUTO_ACTIONS_ENABLED: "true", MAX_AUTO_AMOUNT_PAISE: "100000" }).policy)
    .evaluate(recoveryCase({ amount: 200_000 }), decision, 1_800_000_100);
  assert.equal(policy.allowed, true);
  assert.equal(policy.requiresApproval, true);
  assert.ok(policy.reasons.some((reason) => reason.includes("threshold")));
});

test("production configuration requires strong webhook and merchant authentication secrets", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }));
  const config = loadConfig({
    NODE_ENV: "production",
    RAZORPAY_WEBHOOK_SECRET: "a-secure-webhook-secret",
    AUTH_SESSION_SECRET: "x".repeat(40),
    MERCHANT_OWNER_PASSWORD: "owner-production-secret-2026",
    RECOVERY_OPERATOR_PASSWORD: "operator-production-secret-2026"
  });
  assert.equal(config.nodeEnv, "production");
  assert.equal(config.auth.enabled, true);
});

test("AI provider auto-selects Groq and explicit providers fail fast without credentials", () => {
  const groq = loadConfig({ GROQ_API_KEY: "gsk_test" });
  assert.equal(groq.aiProvider, "groq");
  assert.equal(groq.groq.model, "openai/gpt-oss-20b");
  assert.throws(() => loadConfig({ AI_PROVIDER: "groq" }), /GROQ_API_KEY/);
  assert.throws(() => loadConfig({ AI_PROVIDER: "openai" }), /OPENAI_API_KEY/);
});
