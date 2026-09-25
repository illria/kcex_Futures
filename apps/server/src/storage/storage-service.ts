import type { Logger } from "pino";
import {
  StorageHealthSchema,
  TradeHistoryEntrySchema,
  type StorageHealth,
  type TradeHistoryEntry,
} from "../../../../packages/shared/src/storage.js";
import { AuditRepository } from "./audit-repository.js";
import { DailyPlanRepository } from "./daily-plan-repository.js";
import { SQLiteDatabase } from "./sqlite-database.js";
import { DatabaseSchemaTooNewError, StorageInitializationError } from "./storage-errors.js";
import { TradeRepository } from "./trade-repository.js";
import { SCHEMA_VERSION } from "./migrations.js";

export interface StorageServiceOptions {
  databaseFile?: string;
  now?: () => Date;
  logger?: Logger;
}

export class StorageService {
  private readonly database: SQLiteDatabase;
  private readonly now: () => Date;
  private readonly logger?: Logger;
  private initialized = false;
  private closed = false;
  private tradesRepository: TradeRepository | null = null;
  private dailyPlansRepository: DailyPlanRepository | null = null;
  private auditEventsRepository: AuditRepository | null = null;

  constructor(options: StorageServiceOptions = {}) {
    this.database = new SQLiteDatabase({ fileName: options.databaseFile });
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  get isReady(): boolean {
    return this.initialized && !this.closed;
  }

  get trades(): TradeRepository {
    this.assertReady();
    return this.tradesRepository!;
  }

  get dailyPlans(): DailyPlanRepository {
    this.assertReady();
    return this.dailyPlansRepository!;
  }

  get auditEvents(): AuditRepository {
    this.assertReady();
    return this.auditEventsRepository!;
  }

  async initialize(): Promise<void> {
    if (this.isReady) return;
    if (this.closed) throw new StorageInitializationError();
    try {
      const schemaVersion = await this.database.initialize();
      const connection = this.database.getConnection();
      this.tradesRepository = new TradeRepository(connection, this.now);
      this.dailyPlansRepository = new DailyPlanRepository(connection, this.now);
      this.auditEventsRepository = new AuditRepository(connection, this.now);
      this.initialized = true;
      this.logger?.info({ schemaVersion }, "Trading storage ready.");
    } catch (error) {
      this.database.close();
      if (error instanceof DatabaseSchemaTooNewError) throw error;
      throw new StorageInitializationError();
    }
  }

  getSchemaVersion(): number {
    this.assertReady();
    return this.database.getSchemaVersion();
  }

  getHealth(): StorageHealth {
    if (!this.isReady) return StorageHealthSchema.parse({ status: "DEGRADED", schemaVersion: null });
    try {
      const connection = this.database.getConnection();
      const readiness = connection.prepare("SELECT 1 AS ready").get() as { ready?: number } | undefined;
      const migration = connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        | { version: number | null }
        | undefined;
      if (
        readiness?.ready !== 1
        || this.database.getSchemaVersion() !== SCHEMA_VERSION
        || migration?.version !== SCHEMA_VERSION
      ) {
        return StorageHealthSchema.parse({ status: "DEGRADED", schemaVersion: null });
      }
      for (const probe of REQUIRED_STORAGE_PROBES) connection.prepare(probe).get();
      return StorageHealthSchema.parse({ status: "READY", schemaVersion: SCHEMA_VERSION });
    } catch {
      return StorageHealthSchema.parse({ status: "DEGRADED", schemaVersion: null });
    }
  }

  getRecentTradeHistory(limit = 50): TradeHistoryEntry[] {
    this.assertReady();
    return this.trades.listTrades({ limit }).map((trade) => TradeHistoryEntrySchema.parse({
      id: trade.id,
      symbol: trade.symbol,
      mode: trade.mode,
      side: trade.side,
      status: trade.status,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      realizedPnl: trade.realizedPnl,
      fees: trade.fees,
      createdAt: trade.createdAt,
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    this.tradesRepository = null;
    this.dailyPlansRepository = null;
    this.auditEventsRepository = null;
    this.database.close();
  }

  private assertReady(): void {
    if (!this.isReady) throw new StorageInitializationError();
  }
}

const REQUIRED_STORAGE_PROBES = [
  "SELECT version, name, applied_at FROM schema_migrations LIMIT 0",
  `SELECT id, symbol, mode, side, status, margin_usdt, leverage, quantity,
    entry_price, exit_price, realized_pnl, fees, planned_at, opened_at, closed_at,
    close_reason, created_at, updated_at, version FROM trades LIMIT 0`,
  "SELECT id, trade_id, event_type, event_time, payload_json, created_at FROM trade_events LIMIT 0",
  "SELECT date_key, symbol, daily_target, completed, margin_usdt, leverage, created_at, updated_at FROM daily_plans LIMIT 0",
  "SELECT id, category, event_type, severity, message, payload_json, created_at FROM audit_events LIMIT 0",
] as const;
