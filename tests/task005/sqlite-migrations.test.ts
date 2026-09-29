import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MigrationRunner, SCHEMA_VERSION, STORAGE_MIGRATIONS, type StorageMigration } from "../../apps/server/src/storage/migrations.js";
import { DatabaseSchemaTooNewError } from "../../apps/server/src/storage/storage-errors.js";
import { SQLiteDatabase } from "../../apps/server/src/storage/sqlite-database.js";

describe("SQLite schema migrations", () => {
  const databases: DatabaseSync[] = [];
  const sqliteDatabases: SQLiteDatabase[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
    for (const database of sqliteDatabases.splice(0)) database.close();
  });

  it("initializes a fresh database at the current schema version with safe pragmas", async () => {
    const database = new SQLiteDatabase({ fileName: ":memory:" });
    sqliteDatabases.push(database);
    expect(await database.initialize()).toBe(SCHEMA_VERSION);
    expect(database.getSchemaVersion()).toBe(2);

    const connection = database.getConnection();
    expect(connection.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(connection.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 1 });
    expect(connection.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5000 });
    const journalMode = connection.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["wal", "memory"]).toContain(journalMode.journal_mode.toLowerCase());
  });

  it("applies migrations once and returns version 2 on repeated initialization", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const migrations = new MigrationRunner(database);
    expect(migrations.run()).toBe(2);
    expect(migrations.run()).toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 2 });
    expect(database.prepare("SELECT attempt_id FROM execution_attempts LIMIT 0").all()).toEqual([]);
  });

  it("upgrades an existing schema v1 database without changing stored trade rows", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    expect(new MigrationRunner(database, STORAGE_MIGRATIONS.slice(0, 1)).run()).toBe(1);
    const tradeId = "70000000-0000-4000-8000-000000000001";
    database.prepare(`INSERT INTO trades (
      id, symbol, mode, side, status, created_at, updated_at, version
    ) VALUES (?, 'GPS_USDT', 'PAPER', 'LONG', 'OPEN', '2026-09-29T12:00:00.000Z', '2026-09-29T12:00:00.000Z', 1)`).run(tradeId);

    // Re-run the supported migration list; applied v1 stays intact and v2 is appended.
    expect(new MigrationRunner(database).run()).toBe(2);
    expect(database.prepare("SELECT id, symbol, mode, status FROM trades WHERE id = ?").get(tradeId))
      .toEqual({ id: tradeId, symbol: "GPS_USDT", mode: "PAPER", status: "OPEN" });
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toMatchObject({ version: 2 });
  });

  it("rejects a database schema newer than the supported version", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version, name, applied_at) VALUES (5, 'future', '2026-01-01T00:00:00.000Z');
    `);

    expect(() => new MigrationRunner(database).run()).toThrow(DatabaseSchemaTooNewError);
    expect(() => new MigrationRunner(database).run()).toThrow("DATABASE_SCHEMA_TOO_NEW");
  });

  it("rolls back a partially executed migration and can retry cleanly", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const brokenMigration: StorageMigration[] = [{
      version: 1,
      name: "broken_fixture",
      sql: "CREATE TABLE rollback_probe(id TEXT); INVALID SQL;",
    }];

    expect(() => new MigrationRunner(database, brokenMigration).run()).toThrow();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rollback_probe'").get()).toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toMatchObject({ count: 0 });
    expect(new MigrationRunner(database).run()).toBe(2);
  });
});
