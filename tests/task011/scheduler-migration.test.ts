import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MigrationRunner, SCHEMA_VERSION, STORAGE_MIGRATIONS } from "../../apps/server/src/storage/migrations.js";

describe("TASK-011 SQLite v3 to v4 migration", () => {
  it("appends scheduler_slots while preserving existing trading, attempt, and protection rows", () => {
    const database = new DatabaseSync(":memory:");
    try {
      expect(new MigrationRunner(database, STORAGE_MIGRATIONS.slice(0, 3)).run()).toBe(3);
      const timestamp = "2026-10-01T00:00:00.000Z";
      const tradeId = "33000000-0000-4000-8000-000000000001";
      const attemptId = "33000000-0000-4000-8000-000000000002";
      const previewId = "33000000-0000-4000-8000-000000000003";
      const protectionId = "33000000-0000-4000-8000-000000000004";
      database.prepare(`INSERT INTO trades(id,symbol,mode,side,status,created_at,updated_at,version)
        VALUES(?, 'GPS_USDT','PAPER','LONG','OPEN',?,?,1)`).run(tradeId, timestamp, timestamp);
      database.prepare(`INSERT INTO execution_attempts(
        attempt_id,preview_id,provider,symbol,side,margin_usdt,leverage,status,created_at,updated_at
      ) VALUES(?,?,'FIXTURE','GPS_USDT','LONG',50,10,'SUBMITTING',?,?)`).run(attemptId, previewId, timestamp, timestamp);
      database.prepare(`INSERT INTO protection_plans(
        id,execution_attempt_id,provider,symbol,side,entry_price,position_size,leverage,
        tp_basis,tp_value,tp_target_price,sl_basis,sl_value,sl_target_price,status,
        created_at,updated_at,version
      ) VALUES(?,?,'FIXTURE','GPS_USDT','LONG',100,2,10,'PRICE_PCT',5,105,'PRICE_PCT',5,95,'UNKNOWN',?,?,1)
      `).run(protectionId, attemptId, timestamp, timestamp);

      expect(new MigrationRunner(database).run()).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(5);
      expect(database.prepare("SELECT status FROM trades WHERE id = ?").get(tradeId)).toEqual({ status: "OPEN" });
      expect(database.prepare("SELECT status FROM execution_attempts WHERE attempt_id = ?").get(attemptId))
        .toEqual({ status: "SUBMITTING" });
      expect(database.prepare("SELECT status FROM protection_plans WHERE id = ?").get(protectionId))
        .toEqual({ status: "UNKNOWN" });
      expect(database.prepare("SELECT id FROM scheduler_slots LIMIT 0").all()).toEqual([]);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 5 });
    } finally {
      database.close();
    }
  });

  it("enforces unique slot indexes, unique bound attempts, and status integrity", () => {
    const database = new DatabaseSync(":memory:");
    try {
      new MigrationRunner(database).run();
      const timestamp = "2026-10-01T00:00:00.000Z";
      const attemptId = "34000000-0000-4000-8000-000000000001";
      database.prepare(`INSERT INTO daily_plans(date_key,symbol,daily_target,completed,margin_usdt,leverage,created_at,updated_at)
        VALUES('2026-10-01','GPS_USDT',2,0,50,10,?,?)`).run(timestamp, timestamp);
      database.prepare(`INSERT INTO execution_attempts(
        attempt_id,preview_id,provider,symbol,side,margin_usdt,leverage,status,created_at,updated_at
      ) VALUES(?, '34000000-0000-4000-8000-000000000002','FIXTURE','GPS_USDT','LONG',50,10,'SUBMITTING',?,?)`)
        .run(attemptId, timestamp, timestamp);
      const insert = database.prepare(`INSERT INTO scheduler_slots(
        id,date_key,slot_index,symbol,side,due_at,status,execution_attempt_id,created_at,updated_at,version
      ) VALUES(?, '2026-10-01', 0, 'GPS_USDT', 'LONG', ?, 'SCHEDULED', NULL, ?, ?, 1)`);
      insert.run("34000000-0000-4000-8000-000000000003", timestamp, timestamp, timestamp);
      expect(() => database.prepare(`INSERT INTO scheduler_slots(
        id,date_key,slot_index,symbol,side,due_at,status,execution_attempt_id,created_at,updated_at,version
      ) VALUES('34000000-0000-4000-8000-000000000004','2026-10-01',0,'GPS_USDT','SHORT',?,'SCHEDULED',NULL,?,?,1)`)
        .run("2026-10-01T00:30:00.000Z", timestamp, timestamp)).toThrow();
      database.prepare(`UPDATE execution_attempts SET status='CONFIRMED', confirmed_at=?, evidence_json=? WHERE attempt_id=?`)
        .run(timestamp, JSON.stringify({ kind: "MATCHED_OPEN" }), attemptId);
      database.prepare(`UPDATE scheduler_slots SET status='COMPLETED', execution_attempt_id=?, completed_at=?
        WHERE id='34000000-0000-4000-8000-000000000003'`).run(attemptId, timestamp);
      expect(() => database.prepare(`INSERT INTO scheduler_slots(
        id,date_key,slot_index,symbol,side,due_at,status,execution_attempt_id,created_at,updated_at,version
      ) VALUES('34000000-0000-4000-8000-000000000005','2026-10-01',1,'GPS_USDT','LONG',?,'COMPLETED',?, ?, ?,1)`)
        .run("2026-10-01T00:30:00.000Z", attemptId, timestamp, timestamp)).toThrow();
      expect(() => database.prepare(`INSERT INTO scheduler_slots(
        id,date_key,slot_index,symbol,side,due_at,status,execution_attempt_id,created_at,updated_at,version
      ) VALUES('34000000-0000-4000-8000-000000000006','2026-10-01',1,'GPS_USDT','LONG',?,'MISSED',NULL,?,?,1)`)
        .run("2026-10-01T00:30:00.000Z", timestamp, timestamp)).toThrow();
    } finally {
      database.close();
    }
  });
});
