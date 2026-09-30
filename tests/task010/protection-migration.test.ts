import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MigrationRunner, STORAGE_MIGRATIONS } from "../../apps/server/src/storage/migrations.js";

describe("TASK-010 SQLite v3 migration", () => {
  it("appends v3 to v2 and preserves trade, attempt, and audit rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      expect(new MigrationRunner(database, STORAGE_MIGRATIONS.slice(0, 2)).run()).toBe(2);
      const time = "2026-09-30T12:00:00.000Z";
      const tradeId = "a3000000-0000-4000-8000-000000000001";
      const attemptId = "a3000000-0000-4000-8000-000000000002";
      const previewId = "a3000000-0000-4000-8000-000000000003";
      database.prepare("INSERT INTO trades(id,symbol,mode,side,status,created_at,updated_at,version) VALUES(?, 'GPS_USDT','PAPER','LONG','OPEN',?,?,1)")
        .run(tradeId, time, time);
      database.prepare("INSERT INTO execution_attempts(attempt_id,preview_id,provider,symbol,side,margin_usdt,leverage,status,created_at,updated_at) VALUES(?,?,'FIXTURE','GPS_USDT','LONG',50,10,'SUBMITTING',?,?)")
        .run(attemptId, previewId, time, time);
      database.prepare("INSERT INTO audit_events(id,category,event_type,severity,message,created_at) VALUES('a3000000-0000-4000-8000-000000000004','SYSTEM','FIXTURE','INFO','Migration fixture',?)")
        .run(time);

      expect(new MigrationRunner(database, STORAGE_MIGRATIONS.slice(0, 3)).run()).toBe(3);
      expect(database.prepare("SELECT status FROM trades WHERE id = ?").get(tradeId)).toEqual({ status: "OPEN" });
      expect(database.prepare("SELECT status FROM execution_attempts WHERE attempt_id = ?").get(attemptId)).toEqual({ status: "SUBMITTING" });
      expect(database.prepare("SELECT event_type FROM audit_events WHERE id = 'a3000000-0000-4000-8000-000000000004'").get())
        .toEqual({ event_type: "FIXTURE" });
      expect(database.prepare("SELECT execution_attempt_id FROM protection_plans LIMIT 0").all()).toEqual([]);
      expect(database.prepare("SELECT id, protection_id, event_type FROM protection_events LIMIT 0").all()).toEqual([]);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });
    } finally {
      database.close();
    }
  });
});
