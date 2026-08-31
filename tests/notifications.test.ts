import assert from "node:assert/strict";
import test from "node:test";
import { caseNotificationState, notificationRevisionKey } from "../frontend/src/notifications.js";
import type { RecoveryCase } from "../frontend/src/types.js";

function recoveryCase(overrides: Partial<RecoveryCase> = {}): RecoveryCase {
  return {
    id: "case_1",
    sourceKey: "payment:pay_1",
    entityType: "payment",
    entityId: "pay_1",
    paymentId: "pay_1",
    subscriptionId: null,
    orderId: "order_1",
    invoiceId: null,
    amount: 98_900,
    currency: "INR",
    status: "ACTION_REQUIRED",
    failureClass: "CUSTOMER_ACTIONABLE",
    errorCode: null,
    errorReason: "payment_failed",
    errorSource: "customer",
    errorStep: "payment_authentication",
    recommendedAction: "SEND_RECOVERY_LINK",
    recommendationReason: "Fresh checkout required",
    cohort: "TREATMENT",
    contactCount: 0,
    interventionCount: 1,
    recoveredAmount: 0,
    optedOut: false,
    pausedUntil: null,
    latestEventAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides
  };
}

test("notification state separates merchant actions from unresolved lifecycle alerts", () => {
  const actionable = recoveryCase();
  const waiting = recoveryCase({ id: "case_waiting", status: "WAITING" });
  const recovered = recoveryCase({ id: "case_2", status: "RECOVERED", recoveredAmount: 98_900 });

  const state = caseNotificationState([actionable, waiting, recovered], new Set());

  assert.deepEqual(state.actionable.map((item) => item.id), ["case_1"]);
  assert.deepEqual(state.open.map((item) => item.id), ["case_1", "case_waiting"]);
  assert.deepEqual(state.unread.map((item) => item.id), ["case_1", "case_waiting"]);
});

test("opening a case decrements unread without changing the open exception count", () => {
  const item = recoveryCase();
  const readKeys = new Set([notificationRevisionKey(item)]);

  const state = caseNotificationState([item], readKeys);

  assert.equal(state.actionable.length, 1);
  assert.equal(state.open.length, 1);
  assert.equal(state.unread.length, 0);
  assert.equal(state.ordered.length, 1);
});

test("a newly-created waiting case increments unread without increasing merchant actions", () => {
  const actionable = recoveryCase();
  const readKeys = new Set([notificationRevisionKey(actionable)]);
  const waiting = recoveryCase({ id: "case_new", status: "WAITING", updatedAt: 1_300 });

  const state = caseNotificationState([waiting, actionable], readKeys);

  assert.equal(state.actionable.length, 1);
  assert.deepEqual(state.unread.map((item) => item.id), ["case_new"]);
});

test("a later case revision becomes unread again", () => {
  const original = recoveryCase();
  const changed = recoveryCase({ updatedAt: 1_100, interventionCount: 2 });
  const state = caseNotificationState([changed], new Set([notificationRevisionKey(original)]));

  assert.equal(state.actionable.length, 1);
  assert.equal(state.unread.length, 1);
});

test("resolved cases leave both the open and unread counts", () => {
  const resolved = recoveryCase({ status: "RECOVERED", recoveredAmount: 98_900, updatedAt: 1_200 });
  const state = caseNotificationState([resolved], new Set());

  assert.equal(state.actionable.length, 0);
  assert.equal(state.open.length, 0);
  assert.equal(state.unread.length, 0);
});
