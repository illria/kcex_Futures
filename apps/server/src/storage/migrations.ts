import type { DatabaseSync } from "node:sqlite";
import { DatabaseSchemaTooNewError } from "./storage-errors.js";

export interface StorageMigration {
  version: number;
  name: string;
  sql: string;
}

export const SCHEMA_VERSION = 1;

export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  {
    version: 1,
    name: "initial_trading_storage",
    sql: `
      CREATE TABLE trades (
        id TEXT PRIMARY KEY NOT NULL,
        symbol TEXT NOT NULL CHECK(length(trim(symbol)) BETWEEN 1 AND 64),
        mode TEXT NOT NULL CHECK(mode IN ('PAPER', 'LIVE')),
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        status TEXT NOT NULL CHECK(status IN ('PLANNED', 'OPEN', 'CLOSED', 'FAILED', 'UNKNOWN')),
        margin_usdt REAL CHECK(margin_usdt IS NULL OR margin_usdt >= 0),
        leverage REAL CHECK(leverage IS NULL OR leverage > 0),
        quantity REAL CHECK(quantity IS NULL OR quantity >= 0),
        entry_price REAL CHECK(entry_price IS NULL OR entry_price >= 0),
        exit_price REAL CHECK(exit_price IS NULL OR exit_price >= 0),
        realized_pnl REAL,
        fees REAL CHECK(fees IS NULL OR fees >= 0),
        planned_at TEXT,
        opened_at TEXT,
        closed_at TEXT,
        close_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
      );

      CREATE INDEX trades_created_at_idx ON trades(created_at DESC, id DESC);
      CREATE INDEX trades_status_idx ON trades(status);

      CREATE TABLE trade_events (
        id TEXT PRIMARY KEY NOT NULL,
        trade_id TEXT REFERENCES trades(id),
        event_type TEXT NOT NULL,
        event_time TEXT NOT NULL,
        payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
        created_at TEXT NOT NULL
      );

      CREATE INDEX trade_events_trade_time_idx ON trade_events(trade_id, event_time);

      CREATE TABLE daily_plans (
        date_key TEXT PRIMARY KEY NOT NULL,
        symbol TEXT NOT NULL CHECK(symbol = 'GPS_USDT'),
        daily_target INTEGER NOT NULL CHECK(daily_target BETWEEN 1 AND 10),
        completed INTEGER NOT NULL DEFAULT 0 CHECK(completed >= 0 AND completed <= daily_target),
        margin_usdt REAL NOT NULL CHECK(margin_usdt >= 0),
        leverage REAL NOT NULL CHECK(leverage > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('STORAGE', 'TRADING', 'RISK', 'SCHEDULER', 'SYSTEM')),
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('INFO', 'WARN', 'ERROR')),
        message TEXT NOT NULL CHECK(length(trim(message)) BETWEEN 1 AND 240),
        payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
        created_at TEXT NOT NULL
      );

      CREATE INDEX audit_events_created_at_idx ON audit_events(created_at DESC, id DESC);
    `,
  },
];

interface AppliedMigrationRow {
  version: number;
  name: string;
}

export class MigrationRunner {
  constructor(
    private readonly database: DatabaseSync,
    private readonly migrations: readonly StorageMigration[] = STORAGE_MIGRATIONS,
  ) {}

  run(): number {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    this.assertMigrationDefinitions();
    const applied = this.database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC")
      .all() as unknown as AppliedMigrationRow[];
    const maxApplied = applied.reduce((maximum, row) => Math.max(maximum, row.version), 0);
    const supportedVersion = this.migrations.at(-1)?.version ?? 0;
    if (maxApplied > supportedVersion) throw new DatabaseSchemaTooNewError(maxApplied, supportedVersion);

    for (let index = 0; index < applied.length; index += 1) {
      const row = applied[index];
      const expected = this.migrations[index];
      if (!expected || row.version !== expected.version || row.name !== expected.name) {
        throw new Error("DATABASE_MIGRATION_HISTORY_INVALID");
      }
    }

    for (const migration of this.migrations.slice(applied.length)) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.exec(migration.sql);
        this.database.prepare(
          "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, new Date().toISOString());
        this.database.exec("COMMIT;");
      } catch (error) {
        try {
          this.database.exec("ROLLBACK;");
        } catch {
          // Preserve the original migration error.
        }
        throw error;
      }
    }

    return this.getSchemaVersion();
  }

  getSchemaVersion(): number {
    const row = this.database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  }

  private assertMigrationDefinitions(): void {
    for (let index = 0; index < this.migrations.length; index += 1) {
      const migration = this.migrations[index];
      if (migration.version !== index + 1 || !migration.name.trim()) {
        throw new Error("DATABASE_MIGRATION_DEFINITIONS_INVALID");
      }
    }
  }
}
