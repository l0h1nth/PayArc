import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("existing ledgers gain durable action retry scheduling columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "payarc-migration-"));
  const path = join(directory, "legacy.db");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE actions (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE, decision_json TEXT NOT NULL, policy_json TEXT NOT NULL,
        provider_reference TEXT, provider_url TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `);
    legacy.close();

    const repository = new RecoveryRepository(path);
    const columns = new Set((repository.db.prepare("PRAGMA table_info(actions)").all() as Array<{ name: string }>).map((column) => column.name));
    assert.equal(columns.has("attempt_count"), true);
    assert.equal(columns.has("max_attempts"), true);
    assert.equal(columns.has("next_attempt_at"), true);
    assert.equal(columns.has("last_attempt_at"), true);
    repository.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
