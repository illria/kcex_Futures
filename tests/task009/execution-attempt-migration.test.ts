import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MigrationRunner, STORAGE_MIGRATIONS } from "../../apps/server/src/storage/migrations.js";

describe("TASK-009 execution attempt migration", () => {
  it("appends schema v2 to v1, preserves existing trades, and creates the unresolved-attempt guard", () => {
    const database = new DatabaseSync(":memory:");
    try {
      expect(new MigrationRunner(database, STORAGE_MIGRATIONS.slice(0, 1)).run()).toBe(1);
      const tradeId = "93000000-0000-4000-8000-000000000001";
      database.prepare(`INSERT INTO trades (
        id, symbol, mode, side, status, created_at, updated_at, version
      ) VALUES (?, 'GPS_USDT', 'PAPER', 'LONG', 'OPEN', '2026-09-29T12:00:00.000Z', '2026-09-29T12:00:00.000Z', 1)`)
        .run(tradeId);

      expect(new MigrationRunner(database).run()).toBe(2);
      expect(database.prepare("SELECT id, mode, status FROM trades WHERE id = ?").get(tradeId))
        .toEqual({ id: tradeId, mode: "PAPER", status: "OPEN" });
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
        .toMatchObject({ version: 2 });
      expect(database.prepare("SELECT attempt_id FROM execution_attempts LIMIT 0").all()).toEqual([]);

      const insertAttempt = database.prepare(`INSERT INTO execution_attempts (
        attempt_id, preview_id, provider, symbol, side, margin_usdt, leverage, status, created_at, updated_at
      ) VALUES (?, ?, 'FIXTURE', 'GPS_USDT', 'LONG', 50, 10, 'SUBMITTING', ?, ?)`);
      insertAttempt.run(
        "93000000-0000-4000-8000-000000000002",
        "93000000-0000-4000-8000-000000000003",
        "2026-09-29T12:00:00.000Z",
        "2026-09-29T12:00:00.000Z",
      );
      expect(() => insertAttempt.run(
        "93000000-0000-4000-8000-000000000004",
        "93000000-0000-4000-8000-000000000005",
        "2026-09-29T12:00:01.000Z",
        "2026-09-29T12:00:01.000Z",
      )).toThrow();
    } finally {
      database.close();
    }
  });
});
