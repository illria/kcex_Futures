import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StorageDataIntegrityError, SchedulerSlotConflictError } from "./storage-errors.js";

export const LiveExecutionAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  attemptType: z.enum(["SCHEDULED", "CANARY"]),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  slotIndex: z.number().int().min(0).max(9).nullable(),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  marginUsdt: z.number().finite().positive().max(50),
  leverage: z.literal(10),
  status: z.enum(["SUBMITTING", "SUBMITTED", "CONFIRMING", "CONFIRMED", "FAILED", "UNKNOWN"]),
  quantity: z.number().positive().nullable(),
  notionalUsdt: z.number().positive().nullable(),
  submittedAt: z.string().datetime().nullable(),
  confirmationStartedAt: z.string().datetime().nullable(),
  confirmedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  unknownAt: z.string().datetime().nullable(),
  failureReason: z.enum(["ORDER_REJECTED", "PRECHECK_FAILED"]).nullable(),
  observedEntryPrice: z.number().positive().nullable(),
  observedSize: z.number().positive().nullable(),
  observedAt: z.string().datetime().nullable(),
  tradeId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
}).strict().superRefine((attempt, context) => {
  if (attempt.attemptType === "SCHEDULED" && (attempt.dateKey === null || attempt.slotIndex === null || attempt.marginUsdt !== 50)) {
    context.addIssue({ code: "custom", path: ["attemptType"], message: "Scheduled attempts require their immutable daily slot and fixed 50 USDT margin." });
  }
  if (attempt.attemptType === "CANARY" && (attempt.dateKey !== null || attempt.slotIndex !== null)) {
    context.addIssue({ code: "custom", path: ["attemptType"], message: "Canary attempts are independent of scheduler slots." });
  }
});
export type LiveExecutionAttempt = z.infer<typeof LiveExecutionAttemptSchema>;

const COLUMNS = `attempt_id AS attemptId, attempt_type AS attemptType, date_key AS dateKey, slot_index AS slotIndex, symbol, side,
  margin_usdt AS marginUsdt, leverage, status, quantity, notional_usdt AS notionalUsdt,
  submitted_at AS submittedAt, confirmation_started_at AS confirmationStartedAt, confirmed_at AS confirmedAt,
  failed_at AS failedAt, unknown_at AS unknownAt, failure_reason AS failureReason,
  observed_entry_price AS observedEntryPrice, observed_size AS observedSize, observed_at AS observedAt,
  trade_id AS tradeId, created_at AS createdAt, updated_at AS updatedAt, version`;

type RawRow = Record<string, unknown>;

/** Durable idempotency and unknown-state guard for live scheduler entries. */
export class LiveExecutionAttemptRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  claimDueSlot(slotId: string): LiveExecutionAttempt | null {
    const timestamp = this.timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const slot = this.database.prepare(`SELECT id, date_key AS dateKey, slot_index AS slotIndex, symbol, side, due_at AS dueAt,
        status, execution_attempt_id AS executionAttemptId, live_execution_attempt_id AS liveExecutionAttemptId
        FROM scheduler_slots WHERE id = ?`).get(slotId) as RawRow | undefined;
      if (!slot || slot.status !== "DUE" || slot.executionAttemptId !== null || slot.liveExecutionAttemptId !== null) {
        throw new SchedulerSlotConflictError();
      }
      const dueAt = Date.parse(String(slot.dueAt));
      const nowMs = Date.parse(timestamp);
      if (!Number.isFinite(dueAt) || nowMs < dueAt || nowMs > dueAt + 15 * 60_000) throw new SchedulerSlotConflictError();
      const id = randomUUID();
      this.database.prepare(`INSERT INTO live_execution_attempts(
        attempt_id,attempt_type,date_key,slot_index,symbol,side,margin_usdt,leverage,status,created_at,updated_at,version
      ) VALUES(?,'SCHEDULED',?,?,?,?,50,10,'SUBMITTING',?,?,1)`).run(id, slot.dateKey, slot.slotIndex, slot.symbol, slot.side, timestamp, timestamp);
      this.database.exec("COMMIT;");
      return this.getById(id);
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Keep the original failure. */ }
      if (error instanceof SchedulerSlotConflictError) return null;
      throw error;
    }
  }

  getById(attemptId: string): LiveExecutionAttempt | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_execution_attempts WHERE attempt_id = ?`).get(attemptId) as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  getBySlot(dateKey: string, slotIndex: number): LiveExecutionAttempt | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_execution_attempts WHERE date_key = ? AND slot_index = ?`).get(dateKey, slotIndex) as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  createCanaryAttempt(input: { side: "LONG" | "SHORT"; marginUsdt: number }): LiveExecutionAttempt | null {
    if (!Number.isFinite(input.marginUsdt) || input.marginUsdt <= 0 || input.marginUsdt > 50) {
      throw new StorageDataIntegrityError("canary margin");
    }
    const timestamp = this.timestamp();
    const id = randomUUID();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existing = this.database.prepare("SELECT attempt_id FROM live_execution_attempts WHERE attempt_type = 'CANARY' LIMIT 1").get();
      if (existing) {
        this.database.exec("ROLLBACK;");
        return null;
      }
      this.database.prepare(`INSERT INTO live_execution_attempts(
        attempt_id,attempt_type,date_key,slot_index,symbol,side,margin_usdt,leverage,status,created_at,updated_at,version
      ) VALUES(?,'CANARY',NULL,NULL,'GPS_USDT',?,?,10,'SUBMITTING',?,?,1)`).run(
        id, input.side, input.marginUsdt, timestamp, timestamp,
      );
      this.database.exec("COMMIT;");
      return this.getById(id);
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Keep the original failure. */ }
      const current = this.database.prepare("SELECT attempt_id FROM live_execution_attempts WHERE attempt_type = 'CANARY' LIMIT 1").get();
      if (current) return null;
      throw error;
    }
  }

  getCanaryAttempt(): LiveExecutionAttempt | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_execution_attempts WHERE attempt_type = 'CANARY' LIMIT 1`).get() as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  getLatestAttempt(): LiveExecutionAttempt | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_execution_attempts ORDER BY created_at DESC LIMIT 1`).get() as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  getBlockingAttempt(): LiveExecutionAttempt | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_execution_attempts
      WHERE status IN ('SUBMITTING','SUBMITTED','CONFIRMING','UNKNOWN') ORDER BY created_at ASC LIMIT 1`).get() as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  getBlockingAttemptCount(exceptAttemptId?: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM live_execution_attempts
      WHERE status IN ('SUBMITTING','SUBMITTED','CONFIRMING','UNKNOWN')
        AND (? IS NULL OR attempt_id != ?)`).get(exceptAttemptId ?? null, exceptAttemptId ?? null) as { count?: number | bigint } | undefined;
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new StorageDataIntegrityError("live execution attempt aggregate");
    return count;
  }

  markSubmitted(input: { attemptId: string; quantity: number; notionalUsdt: number }): LiveExecutionAttempt {
    if (!Number.isFinite(input.quantity) || input.quantity <= 0 || !Number.isFinite(input.notionalUsdt) || input.notionalUsdt <= 0) {
      throw new StorageDataIntegrityError("live submission values");
    }
    return this.transition(input.attemptId, ["SUBMITTING"], "SUBMITTED", {
      quantity: input.quantity, notional_usdt: input.notionalUsdt, submitted_at: this.timestamp(),
    });
  }

  markConfirming(attemptId: string): LiveExecutionAttempt {
    return this.transition(attemptId, ["SUBMITTED"], "CONFIRMING", { confirmation_started_at: this.timestamp() });
  }

  markConfirmed(input: {
    attemptId: string;
    entryPrice: number;
    size: number;
    observedAt: string;
    tradeId: string;
  }): LiveExecutionAttempt {
    if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0 || !Number.isFinite(input.size) || input.size <= 0) {
      throw new StorageDataIntegrityError("live confirmation evidence");
    }
    return this.transition(input.attemptId, ["CONFIRMING"], "CONFIRMED", {
      confirmed_at: this.timestamp(),
      observed_entry_price: input.entryPrice,
      observed_size: input.size,
      observed_at: parseTimestamp(input.observedAt),
      trade_id: input.tradeId,
    });
  }

  markFailedNotSubmitted(attemptId: string, reason: "ORDER_REJECTED" | "PRECHECK_FAILED"): LiveExecutionAttempt {
    return this.transition(attemptId, ["SUBMITTING"], "FAILED", { failed_at: this.timestamp(), failure_reason: reason });
  }

  markUnknown(attemptId: string): LiveExecutionAttempt {
    return this.transition(attemptId, ["SUBMITTING", "SUBMITTED", "CONFIRMING"], "UNKNOWN", { unknown_at: this.timestamp() });
  }

  private transition(
    attemptId: string,
    allowed: LiveExecutionAttempt["status"][],
    status: LiveExecutionAttempt["status"],
    values: Record<string, string | number>,
  ): LiveExecutionAttempt {
    const current = this.getById(attemptId);
    if (!current || !allowed.includes(current.status)) throw new SchedulerSlotConflictError();
    const safeColumns: Record<string, string> = {
      quantity: "quantity", notional_usdt: "notional_usdt", submitted_at: "submitted_at",
      confirmation_started_at: "confirmation_started_at", confirmed_at: "confirmed_at", failed_at: "failed_at",
      unknown_at: "unknown_at", failure_reason: "failure_reason", observed_entry_price: "observed_entry_price",
      observed_size: "observed_size", observed_at: "observed_at", trade_id: "trade_id",
    };
    const assignments = Object.keys(values).map((key) => `${safeColumns[key]} = ?`);
    const params = Object.entries(values).map(([, value]) => value);
    const changed = this.database.prepare(`UPDATE live_execution_attempts SET status = ?, ${assignments.join(", ")},
      updated_at = ?, version = version + 1 WHERE attempt_id = ? AND version = ?`).run(
      status, ...params, this.timestamp(), attemptId, current.version,
    );
    if (Number(changed.changes) !== 1) throw new SchedulerSlotConflictError();
    const updated = this.getById(attemptId);
    if (!updated) throw new StorageDataIntegrityError("live execution attempt");
    return updated;
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new StorageDataIntegrityError("live execution clock");
    return date.toISOString();
  }
}

function parseRow(row: RawRow): LiveExecutionAttempt {
  const parsed = LiveExecutionAttemptSchema.safeParse({
    ...row,
    slotIndex: row.slotIndex === null ? null : Number(row.slotIndex),
    version: Number(row.version),
  });
  if (!parsed.success) throw new StorageDataIntegrityError("live execution attempt");
  return parsed.data;
}

function parseTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new StorageDataIntegrityError("live observation timestamp");
  return value;
}
