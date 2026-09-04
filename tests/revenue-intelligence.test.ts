import assert from "node:assert/strict";
import test from "node:test";
import { buildApplication } from "../src/app.js";
import { RevenueIntelligenceService } from "../src/services/revenue-intelligence.js";
import { signWebhook } from "../src/security/webhook.js";
import { RecoveryRepository } from "../src/storage/database.js";
import { TestClock, testConfig } from "./helpers.js";

function setupService() {
  const repository = new RecoveryRepository(":memory:");
  const clock = new TestClock();
  const service = new RevenueIntelligenceService(repository, clock);
  return { repository, clock, service };
}

test("Revenue Digital Twin seeds every playbook and produces causal portfolio metrics", () => {
  const { repository, service } = setupService();
  const snapshot = service.snapshot();
  assert.ok(snapshot.incidents.length >= 2);
  assert.ok(snapshot.journeys.length >= 4);
  assert.ok(snapshot.subscriptions.length >= 2);
  assert.ok(snapshot.receivables.length >= 2);
  assert.ok(snapshot.mandates.length >= 2);
  assert.ok(snapshot.conversations.length >= 1);
  assert.ok(snapshot.promises.length >= 2);
  assert.ok(snapshot.portfolio.some((item) => item.selected));
  assert.ok(snapshot.metrics.totalAtRisk > 0);
  assert.ok(snapshot.metrics.protectedRevenue > 0);
  assert.equal(repository.verifyAuditChain().valid, true);
  repository.close();
});

test("active checkout is observed while abandoned checkout reuses the original link", () => {
  const { repository, service } = setupService();
  const active = service.recoverJourney("journey_active_retry");
  assert.equal(active.status, "OBSERVING");
  assert.equal(active.data.contactEligible, false);
  assert.equal(active.data.recommendedAction, "OBSERVE_ACTIVE_RETRY");

  const abandoned = service.recoverJourney("journey_abandoned_otp");
  assert.equal(abandoned.status, "RECOVERY_SCHEDULED");
  assert.equal(abandoned.data.recommendedAction, "REUSE_EXISTING_CHECKOUT");
  assert.ok(repository.listRevenueOperations().some((item) => item.operation === "RECOVER_JOURNEY"));
  repository.close();
});

test("B2B receivable advances from blocker to outreach and a tracked promise", () => {
  const { repository, service } = setupService();
  let receivable = service.contactReceivable("recv_acme_1042");
  assert.equal(receivable.status, "HUMAN_REVIEW");
  assert.equal(receivable.data.nextAction, "RESOLVE_DOCUMENT_BLOCKER");

  receivable = service.resolveReceivableBlocker(receivable.id);
  assert.equal(receivable.status, "READY_TO_CONTACT");
  receivable = service.contactReceivable(receivable.id);
  assert.equal(receivable.status, "CONTACTED");
  assert.equal(receivable.data.nextAction, "AWAIT_CUSTOMER_RESPONSE");
  assert.equal(receivable.data.contactAttempts, 1);

  receivable = service.recordReceivableOutcome(receivable.id, "PROMISE");
  assert.equal(receivable.status, "PROMISE_CAPTURED");
  assert.ok(receivable.data.linkedPromiseId);
  const promise = service.snapshot().promises.find((item) => item.id === receivable.data.linkedPromiseId)!;
  assert.equal(promise.data.linkedReceivableId, receivable.id);
  assert.equal(promise.data.workflowStage, "PAUSED_UNTIL_DUE");
  assert.equal(repository.verifyAuditChain().valid, true);
  repository.close();
});

test("paid B2B receivable is terminal and cannot be contacted again", () => {
  const { repository, service } = setupService();
  let receivable = service.contactReceivable("recv_orbit_1049");
  receivable = service.recordReceivableOutcome(receivable.id, "PAID");
  assert.equal(receivable.status, "PAID");
  assert.equal(receivable.data.recoveredAmount, receivable.amount);
  const operationCount = repository.listRevenueOperations().length;
  const unchanged = service.contactReceivable(receivable.id);
  assert.equal(unchanged.status, "PAID");
  assert.equal(repository.listRevenueOperations().length, operationCount);
  repository.close();
});

test("incident circuit breaker requires resolution and releases recovery traffic in stages", () => {
  const { repository, service } = setupService();
  assert.throws(() => service.releaseIncident("inc_hdfc_card"), /Resolve the incident/);
  let incident = service.resolveIncident("inc_hdfc_card");
  assert.equal(incident.data.circuitBreaker, false);
  assert.equal(incident.data.stagedReleasePercent, 25);
  incident = service.releaseIncident("inc_hdfc_card");
  assert.equal(incident.data.stagedReleasePercent, 50);
  repository.close();
});

test("unsafe mandate retries fail closed without advancing the sequence", () => {
  const { repository, service } = setupService();
  const before = service.snapshot().mandates.find((item) => item.id === "mandate_card_risky")!;
  const after = service.advanceMandate(before.id);
  assert.equal(after.status, "BLOCKED");
  assert.equal(after.data.attempt, before.data.attempt);
  assert.equal(after.data.nextAttemptAt, null);
  repository.close();
});

test("Hinglish promise capture creates an auditable promise and kept outcome reconciles its invoice", () => {
  const { repository, service } = setupService();
  service.contactReceivable("recv_orbit_1049");
  const conversation = service.respondConversation("conv_orbit_voice", "PROMISE_TOMORROW");
  assert.equal(conversation.status, "PROMISE_CAPTURED");
  assert.ok(conversation.data.linkedPromiseId);
  const promise = service.updatePromise(conversation.data.linkedPromiseId!, "KEPT");
  assert.equal(promise.status, "KEPT");
  const receivable = service.snapshot().receivables.find((item) => item.id === "recv_orbit_1049")!;
  assert.equal(receivable.status, "PAID");
  assert.equal(receivable.data.recoveredAmount, receivable.amount);
  assert.equal(repository.verifyAuditChain().valid, true);
  repository.close();
});

test("missed promise advances through one reminder, grace period, and merchant review", () => {
  const { repository, clock, service } = setupService();
  const conversation = service.respondConversation("conv_orbit_voice", "PROMISE_TOMORROW");
  const promiseId = conversation.data.linkedPromiseId!;

  let promise = service.snapshot().promises.find((item) => item.id === promiseId)!;
  assert.equal(promise.data.workflowStage, "PAUSED_UNTIL_DUE");
  assert.equal(promise.data.contactAttempts, 0);

  clock.advance(86_400);
  assert.ok(service.reconcilePromiseWorkflows() >= 1);
  promise = service.snapshot().promises.find((item) => item.id === promiseId)!;
  assert.equal(promise.data.workflowStage, "DUE_CHECK");

  assert.ok(service.reconcilePromiseWorkflows() >= 1);
  promise = service.snapshot().promises.find((item) => item.id === promiseId)!;
  assert.equal(promise.status, "MISSED");
  assert.equal(promise.data.workflowStage, "REMINDER_SCHEDULED");

  clock.advance(300);
  assert.ok(service.reconcilePromiseWorkflows() >= 1);
  promise = service.snapshot().promises.find((item) => item.id === promiseId)!;
  assert.equal(promise.data.workflowStage, "GRACE_PERIOD");
  assert.equal(promise.data.contactAttempts, 1);

  clock.advance(86_400);
  assert.ok(service.reconcilePromiseWorkflows() >= 1);
  promise = service.snapshot().promises.find((item) => item.id === promiseId)!;
  assert.equal(promise.data.workflowStage, "MERCHANT_REVIEW");
  assert.equal(service.snapshot().receivables.find((item) => item.id === "recv_orbit_1049")!.status, "HUMAN_REVIEW");
  assert.equal(repository.listRevenueOperations().filter((item) => item.objectId === promiseId && item.operation === "PROMISE_REMINDER_DISPATCHED").length, 1);
  assert.equal(repository.verifyAuditChain().valid, true);
  repository.close();
});

test("verified payment stops a scheduled promise reminder", () => {
  const { repository, clock, service } = setupService();
  const promiseId = service.respondConversation("conv_orbit_voice", "PROMISE_TOMORROW").data.linkedPromiseId!;
  service.updatePromise(promiseId, "MISSED");
  let promise = service.updatePromise(promiseId, "KEPT");
  assert.equal(promise.data.workflowStage, "CLOSED_PAID");
  clock.advance(600);
  assert.equal(service.reconcilePromiseWorkflows(), 0);
  promise = service.snapshot().promises.find((item) => item.id === promiseId)!;
  assert.equal(promise.status, "KEPT");
  assert.equal(promise.data.contactAttempts, 0);
  assert.equal(repository.listRevenueOperations().filter((item) => item.operation === "PROMISE_REMINDER_DISPATCHED").length, 0);
  repository.close();
});

test("revenue APIs mutate state and reject invalid conversation intents", async () => {
  const repository = new RecoveryRepository(":memory:");
  const context = await buildApplication({ config: testConfig(), repository, clock: new TestClock() });
  const snapshot = await context.app.inject({ method: "GET", url: "/api/revenue/snapshot" });
  assert.equal(snapshot.statusCode, 200);
  assert.ok(snapshot.json().portfolio.length > 0);

  const resolved = await context.app.inject({ method: "POST", url: "/api/revenue/incidents/inc_hdfc_card/resolve", payload: {} });
  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.json().data.stagedReleasePercent, 25);

  const invalid = await context.app.inject({ method: "POST", url: "/api/revenue/conversations/conv_orbit_voice/respond", payload: { intent: "TRANSFER_MONEY" } });
  assert.equal(invalid.statusCode, 409);

  const batch = await context.app.inject({ method: "POST", url: "/api/revenue/batch/run", payload: {} });
  assert.equal(batch.statusCode, 200);
  assert.ok(batch.json().processed > 0);
  await context.app.close();
  repository.close();
});

test("signed downtime webhooks engage and resolve a real incident circuit breaker", async () => {
  const repository = new RecoveryRepository(":memory:");
  const clock = new TestClock();
  const config = testConfig();
  const context = await buildApplication({ config, repository, clock });
  const send = async (type: "payment.downtime.started" | "payment.downtime.resolved", status: string) => {
    const raw = JSON.stringify({
      event: type,
      account_id: "acc_test",
      created_at: clock.now(),
      payload: { payment_downtime: { entity: { id: "down_hdfc_upi", status, method: "upi", bank: "HDFC Bank" } } }
    });
    return context.app.inject({ method: "POST", url: "/webhooks/razorpay", payload: raw, headers: {
      "content-type": "application/json",
      "x-razorpay-event-id": `evt_${status}`,
      "x-razorpay-signature": signWebhook(raw, config.razorpay.webhookSecrets[0]!)
    } });
  };
  assert.equal((await send("payment.downtime.started", "started")).statusCode, 202);
  let incident = context.revenueIntelligence.snapshot().incidents.find((item) => item.id === "inc_provider_down_hdfc_upi")!;
  assert.equal(incident.data.circuitBreaker, true);
  clock.advance(300);
  assert.equal((await send("payment.downtime.resolved", "resolved")).statusCode, 202);
  incident = context.revenueIntelligence.snapshot().incidents.find((item) => item.id === "inc_provider_down_hdfc_upi")!;
  assert.equal(incident.data.circuitBreaker, false);
  assert.equal(incident.data.stagedReleasePercent, 25);
  await context.app.close();
  repository.close();
});

test("checkout SDK API registers a journey, detects abandonment, and forbids reopening paid revenue", async () => {
  const repository = new RecoveryRepository(":memory:");
  const context = await buildApplication({ config: testConfig(), repository, clock: new TestClock() });
  const created = await context.app.inject({ method: "POST", url: "/api/revenue/journeys", payload: {
    customerRef: "cus_tokenized_1",
    orderId: "order_checkout_1",
    amount: 98_900,
    currency: "INR",
    originalCheckoutUrl: "https://rzp.io/i/existing",
    checkoutExpiresAt: 1_800_086_400,
    paymentMethod: "card"
  } });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  const abandoned = await context.app.inject({ method: "POST", url: `/api/revenue/journeys/${id}/signal`, payload: { stage: "ABANDONED", customerActive: false } });
  assert.equal(abandoned.statusCode, 200);
  assert.equal(abandoned.json().data.recommendedAction, "REUSE_EXISTING_CHECKOUT");
  const paid = await context.app.inject({ method: "POST", url: `/api/revenue/journeys/${id}/signal`, payload: { stage: "PAID", customerActive: false } });
  assert.equal(paid.json().data.recoveredAmount, 98_900);
  const reopened = await context.app.inject({ method: "POST", url: `/api/revenue/journeys/${id}/signal`, payload: { stage: "FAILED", customerActive: true } });
  assert.equal(reopened.statusCode, 409);
  await context.app.close();
  repository.close();
});
