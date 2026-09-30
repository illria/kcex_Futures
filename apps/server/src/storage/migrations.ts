import type { DatabaseSync } from "node:sqlite";
import { DatabaseSchemaTooNewError } from "./storage-errors.js";

export interface StorageMigration {
  version: number;
  name: string;
  sql: string;
}

export const SCHEMA_VERSION = 4;

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
  {
    version: 2,
    name: "durable_execution_attempt_confirmation",
    sql: `
      CREATE TABLE execution_attempts (
        attempt_id TEXT PRIMARY KEY NOT NULL,
        preview_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL CHECK(provider = 'FIXTURE'),
        symbol TEXT NOT NULL CHECK(symbol = 'GPS_USDT'),
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        margin_usdt REAL NOT NULL CHECK(margin_usdt > 0 AND margin_usdt <= 50),
        leverage REAL NOT NULL CHECK(leverage > 0 AND leverage <= 10),
        status TEXT NOT NULL CHECK(status IN ('SUBMITTING', 'SUBMITTED', 'CONFIRMING', 'CONFIRMED', 'FAILED', 'UNKNOWN')),
        fixture_submission_id TEXT,
        outcome TEXT CHECK(outcome IS NULL OR outcome = 'NOT_SUBMITTED'),
        failure_kind TEXT CHECK(failure_kind IS NULL OR failure_kind IN ('EXECUTION_FAILED', 'TIMEOUT')),
        reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN (
          'EXECUTION_PROVIDER_DISABLED', 'ARM_REQUIRED', 'ARM_EXPIRED', 'PREVIEW_EXPIRED',
          'PREVIEW_INVALID', 'EXECUTION_BUSY', 'RISK_PRECHECK_BLOCKED', 'STORAGE_DEGRADED',
          'EXECUTION_FAILED', 'CONFIRMATION_SOURCE_UNKNOWN', 'CONFIRMATION_EVIDENCE_MISMATCH',
          'CONFIRMATION_TIMEOUT', 'SUBMISSION_OUTCOME_UNKNOWN'
        )),
        evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
        submitted_at TEXT,
        confirmation_started_at TEXT,
        confirmed_at TEXT,
        failed_at TEXT,
        unknown_at TEXT,
        observed_side TEXT CHECK(observed_side IS NULL OR observed_side IN ('LONG', 'SHORT')),
        observed_entry_price REAL CHECK(observed_entry_price IS NULL OR observed_entry_price > 0),
        observed_size REAL CHECK(observed_size IS NULL OR observed_size > 0),
        observed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        CHECK(status != 'CONFIRMED' OR (
          confirmed_at IS NOT NULL AND evidence_json IS NOT NULL
          AND json_extract(evidence_json, '$.kind') = 'MATCHED_OPEN'
        )),
        CHECK(status != 'SUBMITTED' OR (fixture_submission_id IS NOT NULL AND submitted_at IS NOT NULL)),
        CHECK(status != 'CONFIRMING' OR confirmation_started_at IS NOT NULL),
        CHECK(status != 'FAILED' OR (failed_at IS NOT NULL AND failure_kind IS NOT NULL AND outcome = 'NOT_SUBMITTED')),
        CHECK(outcome IS NULL OR status = 'FAILED'),
        CHECK(status != 'UNKNOWN' OR (unknown_at IS NOT NULL AND reason_code IS NOT NULL))
      );

      CREATE INDEX execution_attempts_created_at_idx ON execution_attempts(created_at DESC, attempt_id DESC);
      CREATE INDEX execution_attempts_status_idx ON execution_attempts(status);
      CREATE UNIQUE INDEX execution_attempts_one_unresolved_idx
        ON execution_attempts(symbol)
        WHERE status IN ('SUBMITTING', 'SUBMITTED', 'CONFIRMING', 'UNKNOWN');
    `,
  },
  {
    version: 3,
    name: "fixture_protection_plans",
    sql: `
      CREATE TABLE protection_plans (
        id TEXT PRIMARY KEY NOT NULL,
        execution_attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(attempt_id),
        provider TEXT NOT NULL CHECK(provider = 'FIXTURE'),
        symbol TEXT NOT NULL CHECK(symbol = 'GPS_USDT'),
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        entry_price REAL NOT NULL CHECK(entry_price > 0),
        position_size REAL NOT NULL CHECK(position_size > 0),
        leverage REAL NOT NULL CHECK(leverage > 0 AND leverage <= 10),
        tp_basis TEXT NOT NULL CHECK(tp_basis IN ('PRICE_PCT', 'ROI_PCT')),
        tp_value REAL NOT NULL CHECK(tp_value > 0),
        tp_target_price REAL NOT NULL CHECK(tp_target_price > 0),
        sl_basis TEXT NOT NULL CHECK(sl_basis IN ('PRICE_PCT', 'ROI_PCT')),
        sl_value REAL NOT NULL CHECK(sl_value > 0),
        sl_target_price REAL NOT NULL CHECK(sl_target_price > 0),
        status TEXT NOT NULL CHECK(status IN ('PLANNED', 'ACTIVE', 'TRIGGERED_TP', 'TRIGGERED_SL', 'UNKNOWN', 'ERROR')),
        triggered_leg TEXT CHECK(triggered_leg IS NULL OR triggered_leg IN ('TAKE_PROFIT', 'STOP_LOSS')),
        fixture_protection_id TEXT,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        triggered_at TEXT,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        CHECK(status != 'ACTIVE' OR (activated_at IS NOT NULL AND fixture_protection_id IS NOT NULL)),
        CHECK(status NOT IN ('TRIGGERED_TP', 'TRIGGERED_SL') OR (triggered_at IS NOT NULL AND triggered_leg IS NOT NULL)),
        CHECK(status != 'TRIGGERED_TP' OR triggered_leg = 'TAKE_PROFIT'),
        CHECK(status != 'TRIGGERED_SL' OR triggered_leg = 'STOP_LOSS')
      );

      CREATE INDEX protection_plans_status_idx ON protection_plans(status);
      CREATE INDEX protection_plans_created_at_idx ON protection_plans(created_at DESC, id DESC);
      CREATE UNIQUE INDEX protection_plans_one_position_guard_idx
        ON protection_plans(symbol)
        WHERE status IN ('PLANNED', 'ACTIVE', 'UNKNOWN');

      CREATE TABLE protection_events (
        id TEXT PRIMARY KEY NOT NULL,
        protection_id TEXT NOT NULL REFERENCES protection_plans(id),
        event_type TEXT NOT NULL CHECK(event_type IN (
          'PROTECTION_PLANNED', 'PROTECTION_ACTIVATED_FIXTURE', 'PROTECTION_ACTIVATION_FAILED',
          'PROTECTION_OUTCOME_UNKNOWN', 'PROTECTION_TP_TRIGGERED_FIXTURE', 'PROTECTION_SL_TRIGGERED_FIXTURE',
          'PROTECTION_RECOVERED_FIXTURE'
        )),
        event_time TEXT NOT NULL,
        payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX protection_events_plan_time_idx ON protection_events(protection_id, event_time, id);
      CREATE TRIGGER protection_events_no_update BEFORE UPDATE ON protection_events
        BEGIN SELECT RAISE(ABORT, 'protection_events are append-only'); END;
      CREATE TRIGGER protection_events_no_delete BEFORE DELETE ON protection_events
        BEGIN SELECT RAISE(ABORT, 'protection_events are append-only'); END;
    `,
  },
  {
    version: 4,
    name: "daily_random_scheduler_slots",
    sql: `
      CREATE TABLE scheduler_slots (
        id TEXT PRIMARY KEY NOT NULL,
        date_key TEXT NOT NULL REFERENCES daily_plans(date_key) ON DELETE RESTRICT,
        slot_index INTEGER NOT NULL CHECK(slot_index BETWEEN 0 AND 9),
        symbol TEXT NOT NULL CHECK(symbol = 'GPS_USDT'),
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        due_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('SCHEDULED', 'DUE', 'COMPLETED', 'MISSED')),
        execution_attempt_id TEXT REFERENCES execution_attempts(attempt_id),
        completed_at TEXT,
        missed_at TEXT,
        miss_reason TEXT CHECK(miss_reason IS NULL OR miss_reason IN (
          'WINDOW_EXPIRED', 'DAY_ROLLOVER', 'POSITION_NOT_FLAT', 'POSITION_UNKNOWN',
          'EXECUTION_UNRESOLVED', 'PROTECTION_UNRESOLVED', 'STORAGE_DEGRADED'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
        UNIQUE(date_key, slot_index),
        CHECK(
          (status = 'COMPLETED' AND execution_attempt_id IS NOT NULL AND completed_at IS NOT NULL AND missed_at IS NULL AND miss_reason IS NULL)
          OR (status = 'MISSED' AND execution_attempt_id IS NULL AND completed_at IS NULL AND missed_at IS NOT NULL AND miss_reason IS NOT NULL)
          OR (status IN ('SCHEDULED', 'DUE') AND execution_attempt_id IS NULL AND completed_at IS NULL AND missed_at IS NULL AND miss_reason IS NULL)
        )
      );

      CREATE UNIQUE INDEX scheduler_slots_attempt_unique_idx
        ON scheduler_slots(execution_attempt_id)
        WHERE execution_attempt_id IS NOT NULL;
      CREATE INDEX scheduler_slots_date_due_idx ON scheduler_slots(date_key, due_at, slot_index);
      CREATE INDEX scheduler_slots_status_idx ON scheduler_slots(status, due_at);
      CREATE INDEX execution_attempts_confirmed_at_idx ON execution_attempts(status, confirmed_at, side, symbol);
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
