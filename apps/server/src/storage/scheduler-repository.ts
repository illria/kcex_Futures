import type { DatabaseSync } from "node:sqlite";
import {
  SchedulerDailyPlanSchema,
  SchedulerMissReasonSchema,
  SchedulerSlotSchema,
  type SchedulerDailyPlan,
  type SchedulerMissReason,
  type SchedulerSlot,
} from "../../../../packages/shared/src/scheduler.js";
import { DailyPlanRecordSchema, type AppendAuditEventInput, type DailyPlanRecord } from "../../../../packages/shared/src/storage.js";
import type { AuditRepository } from "./audit-repository.js";
import { SchedulerSlotConflictError, StorageDataIntegrityError } from "./storage-errors.js";

type RawRow = Record<string, unknown>;
type Clock = () => Date;

const SLOT_COLUMNS = `
  id,
  date_key AS dateKey,
  slot_index AS slotIndex,
  symbol,
  side,
  due_at AS dueAt,
  status,
  execution_attempt_id AS executionAttemptId,
  live_execution_attempt_id AS liveExecutionAttemptId,
  completed_at AS completedAt,
  missed_at AS missedAt,
  miss_reason AS missReason,
  created_at AS createdAt,
  updated_at AS updatedAt,
  version
`;

export interface CreateDailyScheduleInput {
  dateKey: string;
  dailyTarget: number;
  createdAt: string;
  slots: SchedulerSlot[];
}

export interface SchedulerPlanCreationResult {
  plan: SchedulerDailyPlan;
  created: boolean;
}

export class SchedulerRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly auditEvents: AuditRepository,
    private readonly now: Clock = () => new Date(),
  ) {}

  createDailySchedule(input: CreateDailyScheduleInput): SchedulerPlanCreationResult {
    const timestamp = parseTimestamp(input.createdAt, "scheduler plan timestamp");
    const slots = input.slots.map((slot) => SchedulerSlotSchema.parse(slot));
    const proposed = SchedulerDailyPlanSchema.parse({
      dateKey: input.dateKey,
      symbol: "GPS_USDT",
      dailyTarget: input.dailyTarget,
      completed: 0,
      marginUsdt: 50,
      leverage: 10,
      createdAt: timestamp,
      updatedAt: timestamp,
      slots,
    });
    if (slots.some((slot) => slot.status !== "SCHEDULED" || slot.executionAttemptId !== null || slot.liveExecutionAttemptId !== null)) {
      throw new StorageDataIntegrityError("new scheduler slots");
    }

    this.database.exec("BEGIN IMMEDIATE;");
    let created = false;
    try {
      const existing = this.readDailyPlan(proposed.dateKey);
      if (!existing) {
        this.database.prepare(`
          INSERT INTO daily_plans(date_key, symbol, daily_target, completed, margin_usdt, leverage, created_at, updated_at)
          VALUES (?, 'GPS_USDT', ?, 0, 50, 10, ?, ?)
        `).run(proposed.dateKey, proposed.dailyTarget, proposed.createdAt, proposed.updatedAt);
        for (const slot of proposed.slots) this.insertSlot(slot);
        this.auditEvents.appendAuditEvent(schedulerAudit(
          "SCHEDULER_DAILY_PLAN_CREATED",
          "A UTC daily schedule was created with immutable fixture slots.",
          { dateKey: proposed.dateKey, dailyTarget: proposed.dailyTarget, slotCount: proposed.slots.length },
        ));
        created = true;
      }
      const stored = this.readDailySchedule(proposed.dateKey);
      if (!stored) throw new StorageDataIntegrityError("daily scheduler plan");
      this.database.exec("COMMIT;");
      return { plan: stored, created };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transaction error. */ }
      throw error;
    }
  }

  getDailySchedule(dateKey: string): SchedulerDailyPlan | null {
    return this.readDailySchedule(dateKey);
  }

  getSlot(id: string): SchedulerSlot | null {
    const row = this.database.prepare(`SELECT ${SLOT_COLUMNS} FROM scheduler_slots WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? parseSlotRow(row) : null;
  }

  listSlots(dateKey: string): SchedulerSlot[] {
    const rows = this.database.prepare(`
      SELECT ${SLOT_COLUMNS} FROM scheduler_slots WHERE date_key = ? ORDER BY slot_index ASC LIMIT 10
    `).all(dateKey) as unknown as RawRow[];
    return rows.map(parseSlotRow);
  }

  getCurrentDueSlot(dateKey: string): SchedulerSlot | null {
    const rows = this.database.prepare(`
      SELECT ${SLOT_COLUMNS} FROM scheduler_slots
      WHERE date_key = ? AND status = 'DUE'
      ORDER BY slot_index ASC LIMIT 2
    `).all(dateKey) as unknown as RawRow[];
    if (rows.length > 1) throw new StorageDataIntegrityError("multiple due scheduler slots");
    return rows[0] ? parseSlotRow(rows[0]) : null;
  }

  getNextScheduledSlot(dateKey: string): SchedulerSlot | null {
    const row = this.database.prepare(`
      SELECT ${SLOT_COLUMNS} FROM scheduler_slots
      WHERE date_key = ? AND status = 'SCHEDULED'
      ORDER BY due_at ASC, slot_index ASC LIMIT 1
    `).get(dateKey) as RawRow | undefined;
    return row ? parseSlotRow(row) : null;
  }

  listReconciliationCandidates(now: string, currentDateKey: string): SchedulerSlot[] {
    const timestamp = parseTimestamp(now, "scheduler reconciliation timestamp");
    const rows = this.database.prepare(`
      SELECT ${SLOT_COLUMNS} FROM scheduler_slots
      WHERE status IN ('SCHEDULED', 'DUE') AND date_key <= ? AND due_at <= ?
      ORDER BY date_key ASC, due_at ASC, slot_index ASC LIMIT 1000
    `).all(currentDateKey, timestamp) as unknown as RawRow[];
    return rows.map(parseSlotRow);
  }

  findUnboundConfirmedMatchesForSlot(slot: Pick<SchedulerSlot, "symbol" | "side" | "dueAt">): string[] {
    const dueAtMs = Date.parse(slot.dueAt);
    if (!Number.isFinite(dueAtMs)) throw new RangeError("Scheduler due time is invalid.");
    const windowEndsAt = new Date(dueAtMs + GRACE_MS).toISOString();
    const rows = this.database.prepare(`
      SELECT attempt.attempt_id AS attemptId
      FROM execution_attempts AS attempt
      WHERE attempt.status = 'CONFIRMED'
        AND attempt.symbol = ?
        AND attempt.side = ?
        AND attempt.confirmed_at >= ?
        AND attempt.confirmed_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM scheduler_slots AS bound
          WHERE bound.execution_attempt_id = attempt.attempt_id
        )
      ORDER BY attempt.confirmed_at ASC, attempt.attempt_id ASC
      LIMIT 2
    `).all(slot.symbol, slot.side, slot.dueAt, windowEndsAt) as unknown as Array<{ attemptId: string }>;
    return rows.map((row) => row.attemptId);
  }

  hasExecutionAttemptBinding(attemptId: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 AS found FROM scheduler_slots WHERE execution_attempt_id = ? LIMIT 1
    `).get(attemptId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  transitionSlot(input: {
    id: string;
    expectedVersion: number;
    status: "DUE" | "MISSED";
    at: string;
    missReason?: SchedulerMissReason;
  }): SchedulerSlot {
    const at = parseTimestamp(input.at, "scheduler transition timestamp");
    const missReason = input.status === "MISSED"
      ? SchedulerMissReasonSchema.parse(input.missReason)
      : null;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.readSlot(input.id);
      if (!current) throw new StorageDataIntegrityError("scheduler slot");
      if (current.version !== input.expectedVersion || current.status !== "SCHEDULED" && current.status !== "DUE") {
        throw new SchedulerSlotConflictError();
      }
      if (input.status === "DUE") {
        const dueAtMs = Date.parse(current.dueAt);
        const nowMs = Date.parse(at);
        if (current.status !== "SCHEDULED" || nowMs < dueAtMs || nowMs > dueAtMs + GRACE_MS) {
          throw new SchedulerSlotConflictError();
        }
        const otherDue = this.database.prepare(`
          SELECT 1 AS found FROM scheduler_slots WHERE date_key = ? AND status = 'DUE' AND id != ? LIMIT 1
        `).get(current.dateKey, current.id) as { found?: number } | undefined;
        if (otherDue?.found === 1) throw new SchedulerSlotConflictError();
      }
      if (input.status === "MISSED" && !missReason) throw new SchedulerSlotConflictError();
      const changed = this.database.prepare(`
        UPDATE scheduler_slots SET status = ?, missed_at = ?, miss_reason = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(input.status, input.status === "MISSED" ? at : null, missReason, at, input.id, input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new SchedulerSlotConflictError();
      this.auditEvents.appendAuditEvent(input.status === "DUE"
        ? schedulerAudit("SCHEDULER_SLOT_DUE", "A scheduled slot entered its manual eligibility window.", slotAuditPayload(current))
        : schedulerAudit("SCHEDULER_SLOT_MISSED", "A scheduler slot expired without an entry confirmation.", {
            ...slotAuditPayload(current), missReason,
          }));
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transition error. */ }
      throw error;
    }
    const stored = this.getSlot(input.id);
    if (!stored) throw new StorageDataIntegrityError("scheduler slot");
    return stored;
  }

  completeSlotWithAttempt(input: {
    slotId: string;
    expectedVersion: number;
    executionAttemptId: string;
  }): SchedulerSlot {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const slot = this.readSlot(input.slotId);
      if (!slot || (slot.status !== "DUE" && slot.status !== "SCHEDULED") || slot.version !== input.expectedVersion) {
        throw new SchedulerSlotConflictError();
      }
      const attempt = this.database.prepare(`
        SELECT status, symbol, side, confirmed_at AS confirmedAt
        FROM execution_attempts WHERE attempt_id = ?
      `).get(input.executionAttemptId) as {
        status?: string; symbol?: string; side?: string; confirmedAt?: string | null;
      } | undefined;
      if (!attempt || attempt.status !== "CONFIRMED" || attempt.symbol !== slot.symbol || attempt.side !== slot.side
        || typeof attempt.confirmedAt !== "string") throw new SchedulerSlotConflictError();
      const confirmedMs = Date.parse(attempt.confirmedAt);
      const dueMs = Date.parse(slot.dueAt);
      if (!Number.isFinite(confirmedMs) || confirmedMs < dueMs || confirmedMs > dueMs + GRACE_MS) {
        throw new SchedulerSlotConflictError();
      }
      const alreadyBound = this.database.prepare(`
        SELECT 1 AS found FROM scheduler_slots WHERE execution_attempt_id = ? LIMIT 1
      `).get(input.executionAttemptId) as { found?: number } | undefined;
      if (alreadyBound?.found === 1) throw new SchedulerSlotConflictError();

      const updatedAt = this.timestamp();
      const changed = this.database.prepare(`
        UPDATE scheduler_slots SET status = 'COMPLETED', execution_attempt_id = ?, live_execution_attempt_id = NULL, completed_at = ?,
          updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status IN ('DUE', 'SCHEDULED')
      `).run(input.executionAttemptId, attempt.confirmedAt, updatedAt, input.slotId, input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new SchedulerSlotConflictError();
      const completed = this.database.prepare(`
        SELECT COUNT(*) AS count FROM scheduler_slots WHERE date_key = ? AND status = 'COMPLETED'
      `).get(slot.dateKey) as { count?: number | bigint } | undefined;
      const completedCount = Number(completed?.count);
      if (!Number.isSafeInteger(completedCount) || completedCount < 1) throw new StorageDataIntegrityError("scheduler completed count");
      const header = this.database.prepare(`
        UPDATE daily_plans SET completed = ?, updated_at = ? WHERE date_key = ? AND completed <= daily_target
      `).run(completedCount, updatedAt, slot.dateKey);
      if (Number(header.changes) !== 1) throw new StorageDataIntegrityError("daily plan completion count");
      this.auditEvents.appendAuditEvent(schedulerAudit(
        "SCHEDULER_SLOT_COMPLETED",
        "A scheduled slot matched one manually confirmed fixture entry.",
        { ...slotAuditPayload(slot), executionAttemptId: input.executionAttemptId },
      ));
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transition error. */ }
      throw error;
    }
    const stored = this.getSlot(input.slotId);
    if (!stored) throw new StorageDataIntegrityError("scheduler slot");
    return stored;
  }

  completeSlotWithLiveAttempt(input: {
    slotId: string;
    expectedVersion: number;
    liveExecutionAttemptId: string;
  }): SchedulerSlot {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const slot = this.readSlot(input.slotId);
      if (!slot || slot.status !== "DUE" || slot.version !== input.expectedVersion) throw new SchedulerSlotConflictError();
      const attempt = this.database.prepare(`
        SELECT attempt_type AS attemptType, status, date_key AS dateKey, slot_index AS slotIndex, side, confirmed_at AS confirmedAt
        FROM live_execution_attempts WHERE attempt_id = ?
      `).get(input.liveExecutionAttemptId) as {
        attemptType?: string; status?: string; dateKey?: string; slotIndex?: number; side?: string; confirmedAt?: string | null;
      } | undefined;
      if (!attempt || attempt.attemptType !== "SCHEDULED" || attempt.status !== "CONFIRMED" || attempt.dateKey !== slot.dateKey
        || Number(attempt.slotIndex) !== slot.slotIndex || attempt.side !== slot.side || typeof attempt.confirmedAt !== "string") {
        throw new SchedulerSlotConflictError();
      }
      const confirmedMs = Date.parse(attempt.confirmedAt);
      const dueMs = Date.parse(slot.dueAt);
      if (!Number.isFinite(confirmedMs) || confirmedMs < dueMs || confirmedMs > dueMs + GRACE_MS) throw new SchedulerSlotConflictError();
      const updatedAt = this.timestamp();
      const changed = this.database.prepare(`
        UPDATE scheduler_slots SET status = 'COMPLETED', execution_attempt_id = NULL,
          live_execution_attempt_id = ?, completed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND status = 'DUE'
      `).run(input.liveExecutionAttemptId, attempt.confirmedAt, updatedAt, input.slotId, input.expectedVersion);
      if (Number(changed.changes) !== 1) throw new SchedulerSlotConflictError();
      const completed = this.database.prepare("SELECT COUNT(*) AS count FROM scheduler_slots WHERE date_key = ? AND status = 'COMPLETED'")
        .get(slot.dateKey) as { count?: number | bigint } | undefined;
      const count = Number(completed?.count);
      if (!Number.isSafeInteger(count) || count < 1) throw new StorageDataIntegrityError("scheduler completed count");
      const header = this.database.prepare("UPDATE daily_plans SET completed = ?, updated_at = ? WHERE date_key = ?")
        .run(count, updatedAt, slot.dateKey);
      if (Number(header.changes) !== 1) throw new StorageDataIntegrityError("daily plan completion count");
      this.auditEvents.appendAuditEvent(schedulerAudit(
        "SCHEDULER_SLOT_COMPLETED_LIVE",
        "A scheduler slot was completed after fresh live position confirmation.",
        { ...slotAuditPayload(slot), liveExecutionAttemptId: input.liveExecutionAttemptId },
      ));
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transition error. */ }
      throw error;
    }
    const stored = this.getSlot(input.slotId);
    if (!stored) throw new StorageDataIntegrityError("scheduler slot");
    return stored;
  }

  expireSlots(now: string, currentDateKey: string, dueMissReason: SchedulerMissReason = "WINDOW_EXPIRED"): SchedulerSlot[] {
    const timestamp = parseTimestamp(now, "scheduler expiry timestamp");
    const rows = this.database.prepare(`
      SELECT ${SLOT_COLUMNS} FROM scheduler_slots
      WHERE status IN ('SCHEDULED', 'DUE')
        AND (date_key < ? OR (date_key = ? AND due_at < ?))
      ORDER BY date_key ASC, due_at ASC, slot_index ASC LIMIT 1000
    `).all(currentDateKey, currentDateKey, new Date(Date.parse(timestamp) - GRACE_MS).toISOString()) as unknown as RawRow[];
    const changed: SchedulerSlot[] = [];
    for (const row of rows) {
      const slot = parseSlotRow(row);
      const rollover = slot.dateKey < currentDateKey;
      changed.push(this.transitionSlot({
        id: slot.id,
        expectedVersion: slot.version,
        status: "MISSED",
        at: timestamp,
        missReason: rollover ? "DAY_ROLLOVER" : slot.status === "DUE" ? dueMissReason : "WINDOW_EXPIRED",
      }));
    }
    return changed;
  }

  private readDailySchedule(dateKey: string): SchedulerDailyPlan | null {
    const header = this.readDailyPlan(dateKey);
    if (!header) return null;
    const slots = this.listSlots(dateKey);
    return SchedulerDailyPlanSchema.parse({ ...header, slots });
  }

  private readDailyPlan(dateKey: string): DailyPlanRecord | null {
    const row = this.database.prepare(`
      SELECT date_key AS dateKey, symbol, daily_target AS dailyTarget, completed, margin_usdt AS marginUsdt,
        leverage, created_at AS createdAt, updated_at AS updatedAt
      FROM daily_plans WHERE date_key = ?
    `).get(dateKey) as RawRow | undefined;
    if (!row) return null;
    const base = {
      ...row,
      completed: Number(row.completed),
      dailyTarget: Number(row.dailyTarget),
      marginUsdt: Number(row.marginUsdt),
      leverage: Number(row.leverage),
    };
    const header = DailyPlanRecordSchema.safeParse(base);
    if (!header.success) throw new StorageDataIntegrityError("daily scheduler plan");
    return header.data;
  }

  private readSlot(id: string): SchedulerSlot | null {
    const row = this.database.prepare(`SELECT ${SLOT_COLUMNS} FROM scheduler_slots WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? parseSlotRow(row) : null;
  }

  private insertSlot(slot: SchedulerSlot): void {
    this.database.prepare(`
      INSERT INTO scheduler_slots(
        id, date_key, slot_index, symbol, side, due_at, status, execution_attempt_id, live_execution_attempt_id,
        completed_at, missed_at, miss_reason, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      slot.id, slot.dateKey, slot.slotIndex, slot.symbol, slot.side, slot.dueAt, slot.status,
      slot.executionAttemptId, slot.liveExecutionAttemptId, slot.completedAt, slot.missedAt, slot.missReason,
      slot.createdAt, slot.updatedAt, slot.version,
    );
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new StorageDataIntegrityError("scheduler clock");
    return value.toISOString();
  }
}

const GRACE_MS = 15 * 60_000;

function parseSlotRow(row: RawRow): SchedulerSlot {
  const normalized = {
    ...row,
    slotIndex: Number(row.slotIndex),
    version: Number(row.version),
  };
  const parsed = SchedulerSlotSchema.safeParse(normalized);
  if (!parsed.success) throw new StorageDataIntegrityError("scheduler slot");
  return parsed.data;
}

function parseTimestamp(value: string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new StorageDataIntegrityError(field);
  return value;
}

function schedulerAudit(eventType: string, message: string, payload: Record<string, unknown>): AppendAuditEventInput {
  return { category: "SCHEDULER", eventType, severity: "INFO", message, payload };
}

function slotAuditPayload(slot: SchedulerSlot): Record<string, unknown> {
  return { dateKey: slot.dateKey, slotIndex: slot.slotIndex, symbol: slot.symbol, side: slot.side, dueAt: slot.dueAt };
}
