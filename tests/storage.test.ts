import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRazorpayEvent } from "../src/services/razorpay-events.js";
import { RecoveryRepository } from "../src/storage/database.js";
import { failedPaymentEvent } from "./helpers.js";

test("event enqueue is atomic and duplicate provider IDs do not create duplicate jobs", () => {
  const repository = new RecoveryRepository(":memory:");
  const rawPayload = JSON.stringify(failedPaymentEvent());
  const normalized = normalizeRazorpayEvent(rawPayload, "evt_duplicate");
  const first = repository.enqueueEvent({ rawPayload, payloadHash: "hash", normalized, now: 1 });
  const second = repository.enqueueEvent({ rawPayload, payloadHash: "hash", normalized, now: 2 });
  assert.equal(first.inserted, true);
  assert.equal(second.duplicate, true);
  assert.equal(repository.claimJobs(10).length, 1);
  repository.close();
});

test("audit chain detects database tampering", () => {
  const repository = new RecoveryRepository(":memory:");
  repository.appendAudit({ kind: "ONE", actor: "test", data: { a: 1 }, now: 1 });
  repository.appendAudit({ kind: "TWO", actor: "test", data: { b: 2 }, now: 2 });
  assert.deepEqual(repository.verifyAuditChain(), { valid: true, checked: 2, brokenAt: null });
  repository.db.prepare("UPDATE audit_log SET data_json = ? WHERE id = 1").run('{"a":999}');
  assert.deepEqual(repository.verifyAuditChain(), { valid: false, checked: 0, brokenAt: 1 });
  repository.close();
});
