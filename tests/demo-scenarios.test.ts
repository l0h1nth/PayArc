import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/app.js";
import { MockPaymentProvider } from "../src/providers/mock-payment-provider.js";
import { RecoveryRepository } from "../src/storage/database.js";
import { TestClock, testConfig } from "./helpers.js";

async function setup() {
  const clock = new TestClock();
  const repository = new RecoveryRepository(":memory:");
  const provider = new MockPaymentProvider();
  const context = await buildApplication({ config: testConfig(), repository, provider, clock });
  return { ...context, repository, async close() { await context.app.close(); repository.close(); } };
}

test("scenario catalog exposes the complete judge-facing event surface", async () => {
  const context = await setup();
  const response = await context.app.inject({ method: "GET", url: "/api/demo/scenarios" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.count, 22);
  assert.deepEqual(
    new Set(body.scenarios.map((scenario: { category: string }) => scenario.category)),
    new Set(["Revenue Autopilot", "Payment intelligence", "Subscriptions", "Recovery lifecycle", "Resilience & security"])
  );
  assert.ok(body.scenarios.every((scenario: { expected?: string; events?: string[] }) => scenario.expected && scenario.events?.length));
  const workspaceDemos = body.scenarios.filter((scenario: { mode?: string }) => scenario.mode === "workspace");
  assert.equal(workspaceDemos.length, 7);
  assert.deepEqual(
    new Set(workspaceDemos.map((scenario: { destinationView: string }) => scenario.destinationView)),
    new Set(["overview", "portfolio", "incidents", "journeys", "subscriptions", "receivables", "conversations"])
  );
  await context.close();
});

test("all 22 scenarios execute through their real workspace or isolated boundaries", async () => {
  const context = await setup();
  const catalog = (await context.app.inject({ method: "GET", url: "/api/demo/scenarios" })).json().scenarios as Array<{ id: string }>;
  const results = new Map<string, Record<string, any>>();
  for (const scenario of catalog) {
    const response = await context.app.inject({ method: "POST", url: `/api/demo/scenarios/${scenario.id}/run`, payload: {} });
    assert.equal(response.statusCode, 201, `${scenario.id}: ${response.body}`);
    const result = response.json();
    assert.equal(result.scenario.id, scenario.id);
    assert.equal(typeof result.observed, "string");
    assert.equal(result.metrics.audit.valid, true);
    results.set(scenario.id, result);
  }

  assert.equal(results.get("incorrect-otp")!.case.recommendedAction, "SEND_RECOVERY_LINK");
  assert.equal(results.get("insufficient-funds")!.actions[0].decision.delaySeconds, 14_400);
  assert.equal(results.get("gateway-outage")!.case.failureClass, "TRANSIENT_PROVIDER");
  assert.equal(results.get("expired-card")!.case.recommendedAction, "REQUEST_PAYMENT_METHOD_UPDATE");
  assert.equal(results.get("merchant-misconfiguration")!.case.status, "HUMAN_REVIEW");
  assert.equal(results.get("risk-block")!.case.failureClass, "RISK_OR_COMPLIANCE");
  assert.equal(results.get("subscription-pending")!.case.status, "WAITING");
  assert.equal(results.get("subscription-halted")!.case.recommendedAction, "SEND_RECOVERY_LINK");
  assert.equal(results.get("full-recovery")!.case.status, "RECOVERED");
  assert.equal(results.get("partial-recovery")!.case.status, "RECOVERED");
  assert.equal(results.get("link-expired")!.case.status, "EXHAUSTED");
  assert.equal(results.get("prompt-injection")!.security.promptInjectionDetected, true);
  assert.equal(results.get("prompt-injection")!.security.authoritativeAmountPaise, 99_900);
  assert.equal(results.get("forged-signature")!.security.signatureRejected, true);
  assert.equal(results.get("forged-signature")!.security.casesCreated, 0);
  assert.equal(results.get("duplicate-replay")!.security.duplicateDetected, true);
  assert.equal(results.get("duplicate-replay")!.security.jobsClaimed, 1);
  assert.equal(results.get("stale-failure")!.security.sourceOfTruthProtected, true);
  assert.equal(results.get("autopilot-overview")!.outcome, "AUTOPILOT_BATCH_COMPLETE");
  assert.equal(results.get("portfolio-optimizer-demo")!.outcome, "PORTFOLIO_OPTIMIZED");
  assert.equal(results.get("payment-incident-demo")!.outcome, "CIRCUIT_BREAKER_ACTIVE");
  assert.equal(results.get("checkout-journey-demo")!.outcome, "ABANDONED");
  assert.equal(results.get("recurring-revenue-demo")!.outcome, "RETRY_SEQUENCE_READY");
  assert.equal(results.get("b2b-receivable-demo")!.outcome, "BLOCKER_DETECTED");
  assert.equal(results.get("promise-voice-demo")!.outcome, "PROMISE_CAPTURED");
  assert.ok(results.get("autopilot-overview")!.security.workspaceObjectsCreated >= 7);

  const revenue = (await context.app.inject({ method: "GET", url: "/api/revenue/snapshot" })).json();
  assert.ok(revenue.incidents.some((item: { id: string }) => item.id.startsWith("inc_provider_demo_bank_")));
  assert.ok(revenue.journeys.some((item: { id: string }) => item.id.startsWith("journey_")));
  assert.ok(revenue.subscriptions.some((item: { id: string }) => item.id.startsWith("sub_demo_")));
  assert.ok(revenue.receivables.some((item: { id: string }) => item.id.startsWith("recv_demo_")));
  assert.ok(revenue.conversations.some((item: { id: string }) => item.id.startsWith("conv_demo_")));
  assert.ok(revenue.promises.some((item: { id: string }) => item.id.startsWith("promise_demo_")));

  assert.ok([...results.values()].every((result) => result.recentAudit.length > 0));
  const historyResponse = await context.app.inject({ method: "GET", url: "/api/demo/runs" });
  assert.equal(historyResponse.statusCode, 200);
  const history = historyResponse.json();
  assert.equal(history.count, 22);
  assert.equal(history.runs[0].scenarioId, "stale-failure");
  assert.ok(history.runs.every((run: { runId?: string; observed?: string }) => run.runId && run.observed));
  const fullRecoveryRun = history.runs.find((run: { scenarioId: string }) => run.scenarioId === "full-recovery");
  const traceResponse = await context.app.inject({ method: "GET", url: `/api/demo/runs/${fullRecoveryRun.runId}` });
  assert.equal(traceResponse.statusCode, 200);
  const trace = traceResponse.json();
  assert.equal(trace.scenario.id, "full-recovery");
  assert.equal(trace.case.status, "RECOVERED");
  assert.equal(trace.eventTrace.length, 2);
  assert.ok(trace.recentAudit.length > 0);
  const events = await context.app.inject({ method: "GET", url: "/api/events?limit=3" });
  assert.equal(events.statusCode, 200);
  assert.equal(events.json().length, 0, "Scenario fixtures must remain isolated from the merchant event inbox");
  assert.equal(context.repository.verifyAuditChain().valid, true);
  await context.close();
});

test("scenario endpoints remain disabled in production", async () => {
  const clock = new TestClock();
  const repository = new RecoveryRepository(":memory:");
  const provider = new MockPaymentProvider();
  const config = testConfig();
  config.nodeEnv = "production";
  const context = await buildApplication({ config, repository, provider, clock });
  assert.equal((await context.app.inject({ method: "GET", url: "/api/demo/scenarios" })).statusCode, 404);
  assert.equal((await context.app.inject({ method: "GET", url: "/api/demo/runs" })).statusCode, 404);
  assert.equal((await context.app.inject({ method: "GET", url: "/api/demo/runs/run_unknown" })).statusCode, 404);
  assert.equal((await context.app.inject({ method: "POST", url: "/api/demo/scenarios/incorrect-otp/run" })).statusCode, 404);
  await context.app.close();
  repository.close();
});
