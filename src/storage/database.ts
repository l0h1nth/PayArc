import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertTransition } from "../domain/state-machine.js";
import type {
  ActionType,
  Cohort,
  FailureClass,
  NormalizedEvent,
  RecoveryCase,
  RecoveryDecision,
  RecoveryStatus,
  StoredAction,
  PolicyDecision
} from "../domain/types.js";
import type { RevenueObject, RevenueObjectKind } from "../domain/revenue-intelligence.js";
import type { JourneyData } from "../domain/revenue-intelligence.js";

type JsonObject = Record<string, unknown>;

export type EnqueueResult = { inserted: boolean; duplicate: boolean; eventRowId: number | null };

export type StoredEvent = {
  id: number;
  providerEventId: string;
  type: string;
  entityId: string;
  occurredAt: number;
  rawPayload: string;
  payloadHash: string;
  normalized: NormalizedEvent;
  status: string;
  error: string | null;
};

export type StoredJob = {
  id: number;
  eventId: number;
  attempts: number;
  availableAt: number;
};

export type EventSummary = {
  id: number;
  providerEventId: string;
  type: string;
  entityId: string;
  entityType: NormalizedEvent["entityType"];
  status: string;
  occurredAt: number;
  processedAt: number | null;
  payloadHash: string;
  error: string | null;
};

export type ChannelDelivery = {
  id: string;
  actionId: string;
  channel: "WHATSAPP";
  mode: "CLICK_TO_CHAT" | "CLOUD_API";
  status: "PREPARED" | "SENT" | "FAILED";
  recipientHash: string;
  providerReference: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToCase(row: Record<string, unknown>): RecoveryCase {
  return {
    id: String(row.id),
    sourceKey: String(row.source_key),
    entityType: String(row.entity_type) as RecoveryCase["entityType"],
    entityId: String(row.entity_id),
    paymentId: nullableString(row.payment_id),
    subscriptionId: nullableString(row.subscription_id),
    orderId: nullableString(row.order_id),
    invoiceId: nullableString(row.invoice_id),
    amount: row.amount === null ? null : Number(row.amount),
    currency: nullableString(row.currency),
    customerEmail: nullableString(row.customer_email),
    customerContact: nullableString(row.customer_contact),
    status: String(row.status) as RecoveryStatus,
    failureClass: String(row.failure_class) as FailureClass,
    errorCode: nullableString(row.error_code),
    errorReason: nullableString(row.error_reason),
    errorSource: nullableString(row.error_source),
    errorStep: nullableString(row.error_step),
    recommendedAction: nullableString(row.recommended_action) as ActionType | null,
    recommendationReason: nullableString(row.recommendation_reason),
    cohort: String(row.cohort) as Cohort,
    contactCount: Number(row.contact_count),
    interventionCount: Number(row.intervention_count),
    recoveredAmount: Number(row.recovered_amount),
    optedOut: Boolean(row.opted_out),
    pausedUntil: row.paused_until === null ? null : Number(row.paused_until),
    latestEventAt: Number(row.latest_event_at),
    lastContactAt: row.last_contact_at === null ? null : Number(row.last_contact_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToAction(row: Record<string, unknown>): StoredAction {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    type: String(row.type) as ActionType,
    status: String(row.status) as StoredAction["status"],
    idempotencyKey: String(row.idempotency_key),
    decision: parseJson<RecoveryDecision>(row.decision_json),
    policy: parseJson<PolicyDecision>(row.policy_json),
    providerReference: nullableString(row.provider_reference),
    providerUrl: nullableString(row.provider_url),
    error: nullableString(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToRevenueObject<T = Record<string, unknown>>(row: Record<string, unknown>): RevenueObject<T> {
  return {
    id: String(row.id),
    kind: String(row.kind) as RevenueObjectKind,
    status: String(row.status),
    amount: Number(row.amount),
    currency: String(row.currency),
    priority: Number(row.priority),
    customerRef: nullableString(row.customer_ref),
    data: parseJson<T>(row.data_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class RecoveryRepository {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS incoming_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        raw_payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        error TEXT,
        created_at INTEGER NOT NULL,
        processed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL UNIQUE REFERENCES incoming_events(id),
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL,
        locked_at INTEGER,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS recovery_cases (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payment_id TEXT,
        subscription_id TEXT,
        order_id TEXT,
        invoice_id TEXT,
        amount INTEGER,
        currency TEXT,
        customer_email TEXT,
        customer_contact TEXT,
        status TEXT NOT NULL,
        failure_class TEXT NOT NULL,
        error_code TEXT,
        error_reason TEXT,
        error_source TEXT,
        error_step TEXT,
        recommended_action TEXT,
        recommendation_reason TEXT,
        cohort TEXT NOT NULL,
        contact_count INTEGER NOT NULL DEFAULT 0,
        intervention_count INTEGER NOT NULL DEFAULT 0,
        recovered_amount INTEGER NOT NULL DEFAULT 0,
        opted_out INTEGER NOT NULL DEFAULT 0,
        paused_until INTEGER,
        latest_event_at INTEGER NOT NULL,
        last_contact_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cases_status ON recovery_cases(status);
      CREATE INDEX IF NOT EXISTS idx_cases_provider_ids ON recovery_cases(payment_id, subscription_id, invoice_id);

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES recovery_cases(id),
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        decision_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        provider_reference TEXT,
        provider_url TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_actions_case ON actions(case_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_provider_reference
        ON actions(provider_reference) WHERE provider_reference IS NOT NULL;

      CREATE TABLE IF NOT EXISTS channel_deliveries (
        id TEXT PRIMARY KEY,
        action_id TEXT NOT NULL REFERENCES actions(id),
        channel TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        recipient_hash TEXT NOT NULL,
        provider_reference TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(action_id, channel)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id TEXT,
        event_id INTEGER,
        action_id TEXT,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        record_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_log(case_id, id);

      CREATE TABLE IF NOT EXISTS revenue_objects (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'INR',
        priority INTEGER NOT NULL DEFAULT 50,
        customer_ref TEXT,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_revenue_objects_kind_status
        ON revenue_objects(kind, status, priority DESC);

      CREATE TABLE IF NOT EXISTS revenue_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id TEXT REFERENCES revenue_objects(id),
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_revenue_operations_object
        ON revenue_operations(object_id, id DESC);

      CREATE TABLE IF NOT EXISTS revenue_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  enqueueEvent(input: {
    rawPayload: string;
    payloadHash: string;
    normalized: NormalizedEvent;
    now: number;
  }): EnqueueResult {
    return this.transaction(() => {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO incoming_events
          (provider_event_id, type, entity_id, occurred_at, raw_payload, payload_hash, normalized_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.normalized.providerEventId,
        input.normalized.type,
        input.normalized.entityId,
        input.normalized.occurredAt,
        input.rawPayload,
        input.payloadHash,
        JSON.stringify(input.normalized),
        input.now
      );
      if (Number(insert.changes) === 0) {
        this.appendAudit({ kind: "DUPLICATE_EVENT_IGNORED", actor: "webhook", data: { providerEventId: input.normalized.providerEventId }, now: input.now });
        return { inserted: false, duplicate: true, eventRowId: null };
      }
      const eventRowId = Number(insert.lastInsertRowid);
      this.db.prepare("INSERT INTO jobs (event_id, available_at) VALUES (?, ?)").run(eventRowId, input.now);
      this.appendAudit({ eventId: eventRowId, kind: "EVENT_ACCEPTED", actor: "webhook", data: {
        providerEventId: input.normalized.providerEventId,
        type: input.normalized.type,
        payloadHash: input.payloadHash
      }, now: input.now });
      return { inserted: true, duplicate: false, eventRowId };
    });
  }

  getEvent(id: number): StoredEvent | null {
    const row = this.db.prepare("SELECT * FROM incoming_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: Number(row.id),
      providerEventId: String(row.provider_event_id),
      type: String(row.type),
      entityId: String(row.entity_id),
      occurredAt: Number(row.occurred_at),
      rawPayload: String(row.raw_payload),
      payloadHash: String(row.payload_hash),
      normalized: parseJson<NormalizedEvent>(row.normalized_json),
      status: String(row.status),
      error: nullableString(row.error)
    };
  }

  listEventSummaries(limit = 100): EventSummary[] {
    const rows = this.db.prepare(`
      SELECT id, provider_event_id, type, entity_id, occurred_at, processed_at,
             payload_hash, normalized_json, status, error
      FROM incoming_events ORDER BY id DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const normalized = parseJson<NormalizedEvent>(row.normalized_json);
      return {
        id: Number(row.id),
        providerEventId: String(row.provider_event_id),
        type: String(row.type),
        entityId: String(row.entity_id),
        entityType: normalized.entityType,
        status: String(row.status),
        occurredAt: Number(row.occurred_at),
        processedAt: row.processed_at === null ? null : Number(row.processed_at),
        payloadHash: String(row.payload_hash),
        error: nullableString(row.error)
      };
    });
  }

  claimJobs(now: number, limit = 20): StoredJob[] {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id, event_id, attempts, available_at FROM jobs
        WHERE status = 'PENDING' AND available_at <= ?
        ORDER BY id LIMIT ?
      `).all(now, limit) as Array<Record<string, unknown>>;
      const update = this.db.prepare("UPDATE jobs SET status = 'PROCESSING', locked_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'");
      const claimed: StoredJob[] = [];
      for (const row of rows) {
        if (Number(update.run(now, Number(row.id)).changes) === 1) {
          claimed.push({ id: Number(row.id), eventId: Number(row.event_id), attempts: Number(row.attempts) + 1, availableAt: Number(row.available_at) });
        }
      }
      return claimed;
    });
  }

  completeJob(jobId: number, eventId: number, now: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'DONE', error = NULL WHERE id = ?").run(jobId);
      this.db.prepare("UPDATE incoming_events SET status = 'PROCESSED', processed_at = ?, error = NULL WHERE id = ?").run(now, eventId);
    });
  }

  ignoreJob(jobId: number, eventId: number, reason: string, now: number): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET status = 'DONE', error = ? WHERE id = ?").run(reason, jobId);
      this.db.prepare("UPDATE incoming_events SET status = 'IGNORED', processed_at = ?, error = ? WHERE id = ?").run(now, reason, eventId);
      this.appendAudit({ eventId, kind: "EVENT_IGNORED", actor: "worker", data: { reason }, now });
    });
  }

  failJob(jobId: number, eventId: number, error: string, now: number, retryable: boolean): void {
    this.transaction(() => {
      const job = this.db.prepare("SELECT attempts FROM jobs WHERE id = ?").get(jobId) as { attempts: number } | undefined;
      const shouldRetry = retryable && (job?.attempts ?? 99) < 5;
      const delay = Math.min(300, 2 ** Math.max(1, job?.attempts ?? 1));
      this.db.prepare("UPDATE jobs SET status = ?, available_at = ?, error = ? WHERE id = ?")
        .run(shouldRetry ? "PENDING" : "FAILED", now + delay, error.slice(0, 500), jobId);
      this.db.prepare("UPDATE incoming_events SET status = ?, error = ? WHERE id = ?")
        .run(shouldRetry ? "RETRYING" : "FAILED", error.slice(0, 500), eventId);
      this.appendAudit({ eventId, kind: shouldRetry ? "JOB_RETRY_SCHEDULED" : "JOB_FAILED", actor: "worker", data: { error: error.slice(0, 200) }, now });
    });
  }

  findCaseBySourceKey(sourceKey: string): RecoveryCase | null {
    const row = this.db.prepare("SELECT * FROM recovery_cases WHERE source_key = ?").get(sourceKey) as Record<string, unknown> | undefined;
    return row ? rowToCase(row) : null;
  }

  findCaseForEvent(event: NormalizedEvent): RecoveryCase | null {
    const row = this.db.prepare(`
      SELECT * FROM recovery_cases
      WHERE (? IS NOT NULL AND payment_id = ?)
         OR (? IS NOT NULL AND invoice_id = ?)
         OR (? IS NOT NULL AND subscription_id = ?)
      ORDER BY updated_at DESC LIMIT 1
    `).get(
      event.paymentId ?? null, event.paymentId ?? null,
      event.invoiceId ?? null, event.invoiceId ?? null,
      event.subscriptionId ?? null, event.subscriptionId ?? null
    ) as Record<string, unknown> | undefined;
    return row ? rowToCase(row) : null;
  }

  createCase(input: Omit<RecoveryCase, "id">, eventId: number, now: number): RecoveryCase {
    return this.transaction(() => {
      const id = `case_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      this.db.prepare(`
        INSERT INTO recovery_cases (
          id, source_key, entity_type, entity_id, payment_id, subscription_id, order_id, invoice_id,
          amount, currency, customer_email, customer_contact, status, failure_class, error_code,
          error_reason, error_source, error_step, recommended_action, recommendation_reason, cohort,
          contact_count, intervention_count, recovered_amount, opted_out, paused_until, latest_event_at,
          last_contact_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.sourceKey, input.entityType, input.entityId, input.paymentId, input.subscriptionId,
        input.orderId, input.invoiceId, input.amount, input.currency, input.customerEmail, input.customerContact,
        input.status, input.failureClass, input.errorCode, input.errorReason, input.errorSource, input.errorStep,
        input.recommendedAction, input.recommendationReason, input.cohort, input.contactCount,
        input.interventionCount, input.recoveredAmount, input.optedOut ? 1 : 0, input.pausedUntil,
        input.latestEventAt, input.lastContactAt, input.createdAt, input.updatedAt
      );
      this.appendAudit({ caseId: id, eventId, kind: "CASE_CREATED", actor: "recovery-engine", data: { status: input.status, sourceKey: input.sourceKey, cohort: input.cohort }, now });
      return this.getCase(id)!;
    });
  }

  getCase(id: string): RecoveryCase | null {
    const row = this.db.prepare("SELECT * FROM recovery_cases WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToCase(row) : null;
  }

  listCases(limit = 100): RecoveryCase[] {
    return (this.db.prepare("SELECT * FROM recovery_cases ORDER BY updated_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(rowToCase);
  }

  saveCase(next: RecoveryCase, eventId: number | null, actor: string, reason: string, now: number): RecoveryCase {
    return this.transaction(() => {
      const previous = this.getCase(next.id);
      if (!previous) throw new Error(`Case not found: ${next.id}`);
      assertTransition(previous.status, next.status);
      this.db.prepare(`
        UPDATE recovery_cases SET
          payment_id=?, subscription_id=?, order_id=?, invoice_id=?, amount=?, currency=?,
          customer_email=?, customer_contact=?, status=?, failure_class=?, error_code=?, error_reason=?,
          error_source=?, error_step=?, recommended_action=?, recommendation_reason=?, cohort=?,
          contact_count=?, intervention_count=?, recovered_amount=?, opted_out=?, paused_until=?,
          latest_event_at=?, last_contact_at=?, updated_at=? WHERE id=?
      `).run(
        next.paymentId, next.subscriptionId, next.orderId, next.invoiceId, next.amount, next.currency,
        next.customerEmail, next.customerContact, next.status, next.failureClass, next.errorCode,
        next.errorReason, next.errorSource, next.errorStep, next.recommendedAction,
        next.recommendationReason, next.cohort, next.contactCount, next.interventionCount,
        next.recoveredAmount, next.optedOut ? 1 : 0, next.pausedUntil, next.latestEventAt,
        next.lastContactAt, now, next.id
      );
      this.appendAudit({ caseId: next.id, ...(eventId === null ? {} : { eventId }), kind: "CASE_UPDATED", actor, data: {
        from: previous.status,
        to: next.status,
        reason,
        recoveredAmount: next.recoveredAmount
      }, now });
      return this.getCase(next.id)!;
    });
  }

  createAction(input: {
    caseId: string;
    type: ActionType;
    status: StoredAction["status"];
    idempotencyKey: string;
    decision: RecoveryDecision;
    policy: PolicyDecision;
    now: number;
  }): StoredAction {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM actions WHERE idempotency_key = ?").get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) return rowToAction(existing);
      const id = `act_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
      this.db.prepare(`
        INSERT INTO actions (id, case_id, type, status, idempotency_key, decision_json, policy_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.caseId, input.type, input.status, input.idempotencyKey, JSON.stringify(input.decision), JSON.stringify(input.policy), input.now, input.now);
      this.appendAudit({ caseId: input.caseId, actionId: id, kind: "ACTION_CREATED", actor: "policy-engine", data: { type: input.type, status: input.status, reasons: input.policy.reasons }, now: input.now });
      return this.getAction(id)!;
    });
  }

  getAction(id: string): StoredAction | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToAction(row) : null;
  }

  listActions(caseId?: string): StoredAction[] {
    const rows = caseId
      ? this.db.prepare("SELECT * FROM actions WHERE case_id = ? ORDER BY created_at DESC").all(caseId)
      : this.db.prepare("SELECT * FROM actions ORDER BY created_at DESC LIMIT 200").all();
    return (rows as Array<Record<string, unknown>>).map(rowToAction);
  }

  listDueApprovedActions(now: number, limit = 100): StoredAction[] {
    const rows = this.db.prepare(`
      SELECT * FROM actions
      WHERE status = 'APPROVED'
        AND created_at + CAST(json_extract(decision_json, '$.delaySeconds') AS INTEGER) <= ?
      ORDER BY created_at ASC LIMIT ?
    `).all(now, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToAction);
  }

  findActionByProviderReference(reference: string): StoredAction | null {
    const row = this.db.prepare("SELECT * FROM actions WHERE provider_reference = ?").get(reference) as Record<string, unknown> | undefined;
    return row ? rowToAction(row) : null;
  }

  updateAction(id: string, patch: {
    status: StoredAction["status"];
    providerReference?: string | null;
    providerUrl?: string | null;
    error?: string | null;
  }, actor: string, now: number): StoredAction {
    return this.transaction(() => {
      const current = this.getAction(id);
      if (!current) throw new Error(`Action not found: ${id}`);
      this.db.prepare(`
        UPDATE actions SET status=?, provider_reference=?, provider_url=?, error=?, updated_at=? WHERE id=?
      `).run(
        patch.status,
        patch.providerReference === undefined ? current.providerReference : patch.providerReference,
        patch.providerUrl === undefined ? current.providerUrl : patch.providerUrl,
        patch.error === undefined ? current.error : patch.error,
        now,
        id
      );
      this.appendAudit({ caseId: current.caseId, actionId: id, kind: "ACTION_UPDATED", actor, data: { from: current.status, to: patch.status, error: patch.error ?? null }, now });
      return this.getAction(id)!;
    });
  }

  countRevenueObjects(): number {
    const row = this.db.prepare("SELECT COUNT(*) count FROM revenue_objects").get() as { count: number };
    return Number(row.count);
  }

  upsertRevenueObject<T>(object: RevenueObject<T>, actor = "revenue-intelligence"): RevenueObject<T> {
    this.db.prepare(`
      INSERT INTO revenue_objects
        (id, kind, status, amount, currency, priority, customer_ref, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind, status=excluded.status, amount=excluded.amount,
        currency=excluded.currency, priority=excluded.priority,
        customer_ref=excluded.customer_ref, data_json=excluded.data_json,
        updated_at=excluded.updated_at
    `).run(
      object.id, object.kind, object.status, object.amount, object.currency,
      object.priority, object.customerRef, JSON.stringify(object.data), object.createdAt, object.updatedAt
    );
    this.appendAudit({
      kind: "REVENUE_OBJECT_UPDATED",
      actor,
      data: { objectId: object.id, objectKind: object.kind, status: object.status },
      now: object.updatedAt
    });
    return this.getRevenueObject<T>(object.id)!;
  }

  getRevenueObject<T = Record<string, unknown>>(id: string): RevenueObject<T> | null {
    const row = this.db.prepare("SELECT * FROM revenue_objects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToRevenueObject<T>(row) : null;
  }

  listRevenueObjects<T = Record<string, unknown>>(kind?: RevenueObjectKind): Array<RevenueObject<T>> {
    const rows = kind
      ? this.db.prepare("SELECT * FROM revenue_objects WHERE kind = ? ORDER BY priority DESC, updated_at DESC").all(kind)
      : this.db.prepare("SELECT * FROM revenue_objects ORDER BY priority DESC, updated_at DESC").all();
    return (rows as Array<Record<string, unknown>>).map((row) => rowToRevenueObject<T>(row));
  }

  findJourneyByOrderId(orderId: string): RevenueObject<JourneyData> | null {
    const row = this.db.prepare(`
      SELECT * FROM revenue_objects
      WHERE kind = 'JOURNEY' AND json_extract(data_json, '$.orderId') = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(orderId) as Record<string, unknown> | undefined;
    return row ? rowToRevenueObject<JourneyData>(row) : null;
  }

  recordRevenueOperation(input: {
    objectId?: string;
    operation: string;
    status: string;
    input?: JsonObject;
    output?: JsonObject;
    now: number;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO revenue_operations (object_id, operation, status, input_json, output_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.objectId ?? null,
      input.operation,
      input.status,
      JSON.stringify(input.input ?? {}),
      JSON.stringify(input.output ?? {}),
      input.now
    );
    this.appendAudit({
      kind: "REVENUE_OPERATION",
      actor: "recovery-autopilot",
      data: { objectId: input.objectId ?? null, operation: input.operation, status: input.status },
      now: input.now
    });
    return Number(result.lastInsertRowid);
  }

  listRevenueOperations(limit = 100): Array<Record<string, unknown>> {
    const rows = this.db.prepare("SELECT * FROM revenue_operations ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      objectId: nullableString(row.object_id),
      operation: String(row.operation),
      status: String(row.status),
      input: parseJson<JsonObject>(row.input_json),
      output: parseJson<JsonObject>(row.output_json),
      createdAt: Number(row.created_at)
    }));
  }

  setRevenueState(key: string, value: JsonObject, now: number): void {
    this.db.prepare(`
      INSERT INTO revenue_state (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(key, JSON.stringify(value), now);
  }

  getRevenueState<T extends JsonObject>(key: string): { value: T; updatedAt: number } | null {
    const row = this.db.prepare("SELECT value_json, updated_at FROM revenue_state WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? { value: parseJson<T>(row.value_json), updatedAt: Number(row.updated_at) } : null;
  }

  appendAudit(input: {
    caseId?: string;
    eventId?: number;
    actionId?: string;
    kind: string;
    actor: string;
    data: JsonObject;
    now: number;
  }): string {
    const previous = this.db.prepare("SELECT record_hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { record_hash: string } | undefined;
    const previousHash = previous?.record_hash ?? "GENESIS";
    const canonical = JSON.stringify({
      previousHash,
      caseId: input.caseId ?? null,
      eventId: input.eventId ?? null,
      actionId: input.actionId ?? null,
      kind: input.kind,
      actor: input.actor,
      data: input.data,
      createdAt: input.now
    });
    const recordHash = sha256(canonical);
    this.db.prepare(`
      INSERT INTO audit_log (case_id, event_id, action_id, kind, actor, data_json, previous_hash, record_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.caseId ?? null, input.eventId ?? null, input.actionId ?? null, input.kind, input.actor, JSON.stringify(input.data), previousHash, recordHash, input.now);
    return recordHash;
  }

  getChannelDelivery(actionId: string, channel: "WHATSAPP"): ChannelDelivery | null {
    const row = this.db.prepare("SELECT * FROM channel_deliveries WHERE action_id = ? AND channel = ?").get(actionId, channel) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), actionId: String(row.action_id), channel: "WHATSAPP",
      mode: String(row.mode) as ChannelDelivery["mode"], status: String(row.status) as ChannelDelivery["status"],
      recipientHash: String(row.recipient_hash), providerReference: nullableString(row.provider_reference),
      error: nullableString(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
    };
  }

  listChannelDeliveries(caseId: string): ChannelDelivery[] {
    const rows = this.db.prepare(`
      SELECT d.* FROM channel_deliveries d
      JOIN actions a ON a.id = d.action_id
      WHERE a.case_id = ? ORDER BY d.created_at DESC
    `).all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id), actionId: String(row.action_id), channel: "WHATSAPP" as const,
      mode: String(row.mode) as ChannelDelivery["mode"], status: String(row.status) as ChannelDelivery["status"],
      recipientHash: String(row.recipient_hash), providerReference: nullableString(row.provider_reference),
      error: nullableString(row.error), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
    }));
  }

  saveChannelDelivery(input: Omit<ChannelDelivery, "id" | "createdAt" | "updatedAt"> & { now: number }): ChannelDelivery {
    const current = this.getChannelDelivery(input.actionId, input.channel);
    const id = current?.id ?? `delivery_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const createdAt = current?.createdAt ?? input.now;
    this.db.prepare(`
      INSERT INTO channel_deliveries
        (id, action_id, channel, mode, status, recipient_hash, provider_reference, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(action_id, channel) DO UPDATE SET
        mode=excluded.mode, status=excluded.status, recipient_hash=excluded.recipient_hash,
        provider_reference=excluded.provider_reference, error=excluded.error, updated_at=excluded.updated_at
    `).run(id, input.actionId, input.channel, input.mode, input.status, input.recipientHash,
      input.providerReference, input.error, createdAt, input.now);
    return this.getChannelDelivery(input.actionId, input.channel)!;
  }

  revision(): string {
    const row = this.db.prepare(`
      SELECT
        COALESCE((SELECT MAX(id) FROM audit_log), 0) audit_id,
        COALESCE((SELECT MAX(updated_at) FROM revenue_objects), 0) revenue_at,
        COALESCE((SELECT MAX(id) FROM revenue_operations), 0) operation_id,
        COALESCE((SELECT MAX(updated_at) FROM channel_deliveries), 0) delivery_at
    `).get() as Record<string, unknown>;
    return `${row.audit_id}:${row.revenue_at}:${row.operation_id}:${row.delivery_at}`;
  }

  listAudit(caseId?: string): Array<Record<string, unknown>> {
    const rows = caseId
      ? this.db.prepare("SELECT * FROM audit_log WHERE case_id = ? ORDER BY id").all(caseId)
      : this.db.prepare("SELECT * FROM audit_log ORDER BY id").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: Number(row.id), caseId: nullableString(row.case_id), eventId: row.event_id === null ? null : Number(row.event_id),
      actionId: nullableString(row.action_id), kind: String(row.kind), actor: String(row.actor),
      data: parseJson<JsonObject>(row.data_json), previousHash: String(row.previous_hash),
      recordHash: String(row.record_hash), createdAt: Number(row.created_at)
    }));
  }

  verifyAuditChain(): { valid: boolean; checked: number; brokenAt: number | null } {
    const rows = this.db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<Record<string, unknown>>;
    let previousHash = "GENESIS";
    for (const row of rows) {
      const canonical = JSON.stringify({
        previousHash,
        caseId: nullableString(row.case_id),
        eventId: row.event_id === null ? null : Number(row.event_id),
        actionId: nullableString(row.action_id),
        kind: String(row.kind),
        actor: String(row.actor),
        data: parseJson<JsonObject>(row.data_json),
        createdAt: Number(row.created_at)
      });
      if (String(row.previous_hash) !== previousHash || sha256(canonical) !== String(row.record_hash)) {
        return { valid: false, checked: Number(row.id) - 1, brokenAt: Number(row.id) };
      }
      previousHash = String(row.record_hash);
    }
    return { valid: true, checked: rows.length, brokenAt: null };
  }

  metrics(): Record<string, unknown> {
    const cases = this.listCases(10_000);
    const treatment = cases.filter((item) => item.cohort === "TREATMENT");
    const control = cases.filter((item) => item.cohort === "CONTROL");
    const sum = (items: RecoveryCase[], selector: (item: RecoveryCase) => number) => items.reduce((total, item) => total + selector(item), 0);
    const cohortMetric = (items: RecoveryCase[]) => {
      const eligible = sum(items, (item) => item.amount ?? 0);
      const recovered = sum(items, (item) => Math.min(item.recoveredAmount, item.amount ?? item.recoveredAmount));
      return { cases: items.length, eligibleAmount: eligible, recoveredAmount: recovered, recoveryRate: eligible > 0 ? recovered / eligible : null };
    };
    const treatmentMetric = cohortMetric(treatment);
    const controlMetric = cohortMetric(control);
    const uplift = treatmentMetric.recoveryRate !== null && controlMetric.recoveryRate !== null
      ? treatmentMetric.recoveryRate - controlMetric.recoveryRate
      : null;
    const operationRows = this.db.prepare(`
      SELECT kind, COUNT(*) count FROM audit_log
      WHERE kind IN (
        'EVENT_IGNORED','ACTION_CREATED','JOB_FAILED','JOB_RETRY_SCHEDULED',
        'WEBHOOK_SIGNATURE_REJECTED','DUPLICATE_EVENT_IGNORED','PROMPT_INJECTION_SIGNAL',
        'STALE_FAILURE_IGNORED','OUT_OF_ORDER_EVENT_OBSERVED'
      )
      GROUP BY kind
    `).all() as Array<{ kind: string; count: number }>;
    const recoveredCases = cases.filter((item) => item.status === "RECOVERED");
    const averageRecoverySeconds = recoveredCases.length > 0
      ? recoveredCases.reduce((total, item) => total + Math.max(0, item.updatedAt - item.createdAt), 0) / recoveredCases.length
      : null;
    const byFailureClass = Object.fromEntries([...new Set(cases.map((item) => item.failureClass))].map((failureClass) => {
      const items = cases.filter((item) => item.failureClass === failureClass);
      return [failureClass, cohortMetric(items)];
    }));
    const byIntervention = Object.fromEntries([...new Set(cases.map((item) => item.recommendedAction).filter(Boolean))].map((intervention) => {
      const items = cases.filter((item) => item.recommendedAction === intervention);
      return [String(intervention), cohortMetric(items)];
    }));
    return {
      totalCases: cases.length,
      totalAtRisk: sum(cases, (item) => item.amount ?? 0),
      totalRecovered: sum(cases, (item) => Math.min(item.recoveredAmount, item.amount ?? item.recoveredAmount)),
      byStatus: Object.fromEntries([...new Set(cases.map((item) => item.status))].map((status) => [status, cases.filter((item) => item.status === status).length])),
      treatment: treatmentMetric,
      control: controlMetric,
      absoluteRecoveryUplift: uplift,
      averageRecoverySeconds,
      byFailureClass,
      byIntervention,
      operations: Object.fromEntries(operationRows.map((row) => [row.kind, Number(row.count)])),
      audit: this.verifyAuditChain()
    };
  }
}
