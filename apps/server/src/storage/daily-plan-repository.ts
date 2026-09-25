import type { DatabaseSync } from "node:sqlite";
import {
  DailyPlanRecordSchema,
  UpsertDailyPlanInputSchema,
  type DailyPlanRecord,
  type UpsertDailyPlanInput,
} from "../../../../packages/shared/src/storage.js";
import { StorageDataIntegrityError } from "./storage-errors.js";

type RawRow = Record<string, unknown>;
type Clock = () => Date;

export class DailyPlanRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: Clock = () => new Date()) {}

  upsertDailyPlan(input: UpsertDailyPlanInput): DailyPlanRecord {
    const validated = UpsertDailyPlanInputSchema.parse(input);
    const timestamp = this.now().toISOString();
    this.database.prepare(`
      INSERT INTO daily_plans(date_key, symbol, daily_target, completed, margin_usdt, leverage, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date_key) DO UPDATE SET
        symbol = excluded.symbol,
        daily_target = excluded.daily_target,
        completed = excluded.completed,
        margin_usdt = excluded.margin_usdt,
        leverage = excluded.leverage,
        updated_at = excluded.updated_at
    `).run(
      validated.dateKey,
      validated.symbol,
      validated.dailyTarget,
      validated.completed,
      validated.marginUsdt,
      validated.leverage,
      timestamp,
      timestamp,
    );
    const record = this.getDailyPlan(validated.dateKey);
    if (!record) throw new StorageDataIntegrityError("daily plan");
    return record;
  }

  getDailyPlan(dateKey: string): DailyPlanRecord | null {
    const row = this.database.prepare(`
      SELECT
        date_key AS dateKey,
        symbol,
        daily_target AS dailyTarget,
        completed,
        margin_usdt AS marginUsdt,
        leverage,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM daily_plans
      WHERE date_key = ?
    `).get(dateKey) as RawRow | undefined;
    return row ? parseDailyPlanRow(row) : null;
  }

  listDailyPlans(options: { limit?: number } = {}): DailyPlanRecord[] {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("List limit must be an integer from 1 to 100.");
    }
    const rows = this.database.prepare(`
      SELECT
        date_key AS dateKey,
        symbol,
        daily_target AS dailyTarget,
        completed,
        margin_usdt AS marginUsdt,
        leverage,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM daily_plans
      ORDER BY date_key DESC
      LIMIT ?
    `).all(limit) as unknown as RawRow[];
    return rows.map(parseDailyPlanRow);
  }
}

function parseDailyPlanRow(row: RawRow): DailyPlanRecord {
  const parsed = DailyPlanRecordSchema.safeParse(row);
  if (!parsed.success) throw new StorageDataIntegrityError("daily plan");
  return parsed.data;
}
