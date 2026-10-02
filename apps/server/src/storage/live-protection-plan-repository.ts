import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { SchedulerSlotConflictError, StorageDataIntegrityError } from "./storage-errors.js";

export const LiveProtectionPlanSchema = z.object({
  id: z.string().uuid(),
  executionAttemptId: z.string().uuid(),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  entryPrice: z.number().positive(),
  positionSize: z.number().positive(),
  leverage: z.literal(10),
  tpBasis: z.enum(["PRICE_PCT", "ROI_PCT"]),
  tpValue: z.number().positive(),
  tpTarget: z.number().positive(),
  slBasis: z.enum(["PRICE_PCT", "ROI_PCT"]),
  slValue: z.number().positive(),
  slTarget: z.number().positive(),
  status: z.enum(["PLANNED", "ACTIVE", "UNKNOWN", "ERROR", "TRIGGERED_TP", "TRIGGERED_SL", "CLOSED_UNKNOWN"]),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
}).strict();
export type LiveProtectionPlan = z.infer<typeof LiveProtectionPlanSchema>;

const COLUMNS = `id, execution_attempt_id AS executionAttemptId, symbol, side, entry_price AS entryPrice,
  position_size AS positionSize, leverage, tp_basis AS tpBasis, tp_value AS tpValue, tp_target AS tpTarget,
  sl_basis AS slBasis, sl_value AS slValue, sl_target AS slTarget, status, created_at AS createdAt,
  activated_at AS activatedAt, updated_at AS updatedAt, version`;
type RawRow = Record<string, unknown>;

/** Separates durable live protection state from fixture protection plans. */
export class LiveProtectionPlanRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  createPlanned(input: Omit<LiveProtectionPlan, "id" | "status" | "createdAt" | "activatedAt" | "updatedAt" | "version">): LiveProtectionPlan {
    const timestamp = this.timestamp();
    const id = randomUUID();
    this.database.prepare(`INSERT INTO live_protection_plans(
      id,execution_attempt_id,symbol,side,entry_price,position_size,leverage,tp_basis,tp_value,tp_target,
      sl_basis,sl_value,sl_target,status,created_at,activated_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?, ?,?,?, 'PLANNED', ?,NULL,?,1)`).run(
      id,input.executionAttemptId,input.symbol,input.side,input.entryPrice,input.positionSize,input.leverage,
      input.tpBasis,input.tpValue,input.tpTarget,input.slBasis,input.slValue,input.slTarget,timestamp,timestamp,
    );
    const plan = this.getById(id);
    if (!plan) throw new StorageDataIntegrityError("live protection plan");
    return plan;
  }

  getById(id: string): LiveProtectionPlan | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_protection_plans WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  getByAttemptId(attemptId: string): LiveProtectionPlan | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_protection_plans WHERE execution_attempt_id = ?`).get(attemptId) as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  getPositionGuardPlan(): LiveProtectionPlan | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM live_protection_plans
      WHERE status IN ('PLANNED','ACTIVE','UNKNOWN','ERROR') ORDER BY created_at ASC LIMIT 1`).get() as RawRow | undefined;
    return row ? parseRow(row) : null;
  }

  transition(id: string, status: LiveProtectionPlan["status"]): LiveProtectionPlan {
    const current = this.getById(id);
    if (!current || !(["PLANNED", "ACTIVE", "UNKNOWN", "ERROR"].includes(current.status))) throw new SchedulerSlotConflictError();
    if (status === "ACTIVE" && current.status !== "PLANNED") throw new SchedulerSlotConflictError();
    if ((status === "UNKNOWN" || status === "ERROR") && current.status === "ACTIVE") throw new SchedulerSlotConflictError();
    if (status === "CLOSED_UNKNOWN" && !["ACTIVE", "UNKNOWN", "ERROR"].includes(current.status)) throw new SchedulerSlotConflictError();
    const timestamp = this.timestamp();
    const changed = this.database.prepare(`UPDATE live_protection_plans SET status = ?,
      activated_at = CASE WHEN ? = 'ACTIVE' THEN ? ELSE activated_at END,
      updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`).run(
      status, status, timestamp, timestamp, id, current.version,
    );
    if (Number(changed.changes) !== 1) throw new SchedulerSlotConflictError();
    const updated = this.getById(id);
    if (!updated) throw new StorageDataIntegrityError("live protection plan");
    return updated;
  }

  getBlockingCount(): number {
    const result = this.database.prepare("SELECT COUNT(*) AS count FROM live_protection_plans WHERE status IN ('PLANNED','UNKNOWN','ERROR')").get() as { count?: number | bigint } | undefined;
    const count = Number(result?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new StorageDataIntegrityError("live protection aggregate");
    return count;
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new StorageDataIntegrityError("live protection clock");
    return date.toISOString();
  }
}

function parseRow(row: RawRow): LiveProtectionPlan {
  const numeric = { ...row, version: Number(row.version) };
  const parsed = LiveProtectionPlanSchema.safeParse(numeric);
  if (!parsed.success) throw new StorageDataIntegrityError("live protection plan");
  return parsed.data;
}
