import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage, plannedTradeInput } from "./storage-test-helpers.js";

describe("atomic trade transitions", () => {
  const opened: Array<Awaited<ReturnType<typeof createMemoryStorage>>> = [];

  afterEach(() => {
    for (const storage of opened.splice(0)) storage.close();
  });

  async function createStorage() {
    const storage = await createMemoryStorage(() => new Date("2026-09-25T12:34:56.789Z"));
    opened.push(storage);
    return storage;
  }

  it("commits a trade update and its lifecycle event together", async () => {
    const storage = await createStorage();
    const trade = storage.trades.createTrade(plannedTradeInput());
    const updated = storage.trades.recordTradeTransition({
      tradeId: trade.id,
      patch: { expectedVersion: 1, status: "CLOSED", exitPrice: 0.013, realizedPnl: 4.25, closedAt: "2026-09-25T12:30:00.000Z" },
      event: { eventType: "TRADE_CLOSED", payload: { symbol: trade.symbol, mode: trade.mode, side: trade.side, status: "CLOSED" } },
    });

    expect(updated.status).toBe("CLOSED");
    expect(updated.version).toBe(2);
    const events = storage.trades.listTradeEvents(trade.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("TRADE_CLOSED");
  });

  it("rolls the trade update back if the event append fails", async () => {
    const storage = await createStorage();
    const trade = storage.trades.createTrade(plannedTradeInput());
    const duplicateEventId = "20000000-0000-4000-8000-000000000001";
    storage.trades.appendTradeEvent({
      id: duplicateEventId,
      tradeId: trade.id,
      eventType: "TRADE_PLANNED",
      payload: { symbol: trade.symbol, status: "PLANNED" },
    });

    expect(() => storage.trades.recordTradeTransition({
      tradeId: trade.id,
      patch: { expectedVersion: 1, status: "CLOSED" },
      event: { id: duplicateEventId, eventType: "TRADE_CLOSED", payload: { status: "CLOSED" } },
    })).toThrow();

    expect(storage.trades.getTrade(trade.id)?.status).toBe("PLANNED");
    expect(storage.trades.getTrade(trade.id)?.version).toBe(1);
    expect(storage.trades.listTradeEvents(trade.id)).toHaveLength(1);
  });
});
