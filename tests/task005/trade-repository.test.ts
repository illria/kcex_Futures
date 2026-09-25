import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { MigrationRunner } from "../../apps/server/src/storage/migrations.js";
import { StorageDataIntegrityError, DuplicateTradeError, TradeVersionConflictError } from "../../apps/server/src/storage/storage-errors.js";
import { TradeRepository } from "../../apps/server/src/storage/trade-repository.js";
import { createMemoryStorage, plannedTradeInput } from "./storage-test-helpers.js";

describe("TradeRepository", () => {
  const opened: Array<Awaited<ReturnType<typeof createMemoryStorage>>> = [];
  const rawDatabases: DatabaseSync[] = [];

  afterEach(() => {
    for (const storage of opened.splice(0)) storage.close();
    for (const database of rawDatabases.splice(0)) database.close();
  });

  async function storageWithClock() {
    let tick = 0;
    const storage = await createMemoryStorage(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
    opened.push(storage);
    return storage;
  }

  it("creates, gets, lists, and version-updates validated PAPER trade records", async () => {
    const storage = await storageWithClock();
    const created = storage.trades.createTrade(plannedTradeInput({ quantity: 12, entryPrice: 0.0123, marginUsdt: 50, leverage: 10 }));
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created.mode).toBe("PAPER");
    expect(created.version).toBe(1);
    expect(storage.trades.getTrade(created.id)).toEqual(created);
    expect(storage.trades.listTrades()).toEqual([created]);

    const updated = storage.trades.updateTrade(created.id, {
      expectedVersion: 1,
      status: "OPEN",
      openedAt: "2026-01-01T00:01:00.000Z",
      marginUsdt: undefined,
    });
    expect(updated.status).toBe("OPEN");
    expect(updated.marginUsdt).toBe(50);
    expect(updated.version).toBe(2);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it("rejects stale optimistic updates and duplicate business ids", async () => {
    const storage = await storageWithClock();
    const id = "10000000-0000-4000-8000-000000000001";
    const created = storage.trades.createTrade(plannedTradeInput({ id }));
    expect(() => storage.trades.createTrade(plannedTradeInput({ id }))).toThrow(DuplicateTradeError);
    storage.trades.updateTrade(id, { expectedVersion: 1, status: "OPEN" });
    expect(() => storage.trades.updateTrade(id, { expectedVersion: 1, status: "CLOSED" })).toThrow(TradeVersionConflictError);
    expect(storage.trades.getTrade(id)?.version).toBe(created.version + 1);
  });

  it("rejects invalid enums and non-finite or negative numeric inputs", async () => {
    const storage = await storageWithClock();
    expect(() => storage.trades.createTrade(plannedTradeInput({ quantity: -1 }))).toThrow();
    expect(() => storage.trades.createTrade(plannedTradeInput({ entryPrice: Number.POSITIVE_INFINITY }))).toThrow();
    expect(() => storage.trades.createTrade(plannedTradeInput({ status: "EXECUTING" as never }))).toThrow();
    expect(() => storage.trades.createTrade(plannedTradeInput({ mode: "ARMED" as never }))).toThrow();
  });

  it("rejects a corrupted database row when reading it back", () => {
    const database = new DatabaseSync(":memory:");
    rawDatabases.push(database);
    new MigrationRunner(database).run();
    const repository = new TradeRepository(database, () => new Date("2026-01-01T00:00:00.000Z"));
    const trade = repository.createTrade(plannedTradeInput());
    database.exec("PRAGMA ignore_check_constraints = ON;");
    database.prepare("UPDATE trades SET status = ? WHERE id = ?").run("NOT_VALID", trade.id);
    expect(() => repository.getTrade(trade.id)).toThrow(StorageDataIntegrityError);
  });

  it("rejects persisted strings that are padded instead of silently trimming them", () => {
    const database = new DatabaseSync(":memory:");
    rawDatabases.push(database);
    new MigrationRunner(database).run();
    const repository = new TradeRepository(database, () => new Date("2026-01-01T00:00:00.000Z"));
    const trade = repository.createTrade(plannedTradeInput({ closeReason: "planned reason" }));

    database.prepare("UPDATE trades SET symbol = ? WHERE id = ?").run(" GPS_USDT ", trade.id);
    expect(() => repository.getTrade(trade.id)).toThrow(StorageDataIntegrityError);

    database.prepare("UPDATE trades SET symbol = ?, close_reason = ? WHERE id = ?")
      .run("GPS_USDT", " corrupted reason ", trade.id);
    expect(() => repository.getTrade(trade.id)).toThrow(StorageDataIntegrityError);
  });

  it("bounds list queries to at most 100 rows", async () => {
    const storage = await storageWithClock();
    expect(() => storage.trades.listTrades({ limit: 0 })).toThrow(RangeError);
    expect(() => storage.trades.listTrades({ limit: 101 })).toThrow(RangeError);
    expect(storage.trades.listTrades({ limit: 1 })).toEqual([]);
  });
});
