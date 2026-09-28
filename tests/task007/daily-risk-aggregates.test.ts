import { describe, expect, it } from "vitest";
import { createMemoryStorage, plannedTradeInput } from "../task005/storage-test-helpers.js";

const START = "2026-09-29T00:00:00.000Z";
const END = "2026-09-30T00:00:00.000Z";

describe("bounded daily risk aggregates", () => {
  it("counts only records that opened inside the UTC day, excluding plans and yesterday", async () => {
    const storage = await createMemoryStorage(() => new Date("2026-09-29T12:00:00.000Z"));
    try {
      for (let index = 0; index < 9; index += 1) {
        storage.trades.createTrade(plannedTradeInput({
          id: `71000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          status: "CLOSED",
          openedAt: index === 0 ? START : `2026-09-29T01:00:${String(index).padStart(2, "0")}.000Z`,
          closedAt: `2026-09-29T02:00:${String(index).padStart(2, "0")}.000Z`,
          realizedPnl: 0,
        }));
      }
      storage.trades.createTrade(plannedTradeInput({
        id: "71000000-0000-4000-8000-000000000010",
        status: "PLANNED",
        plannedAt: "2026-09-29T03:00:00.000Z",
        openedAt: null,
      }));
      storage.trades.createTrade(plannedTradeInput({
        id: "71000000-0000-4000-8000-000000000011",
        status: "CLOSED",
        openedAt: "2026-09-28T23:59:59.999Z",
        closedAt: "2026-09-29T00:30:00.000Z",
        realizedPnl: 0,
      }));

      const query = { mode: "PAPER" as const, symbol: "GPS_USDT", startAt: START, endAt: END };
      expect(storage.trades.countOpenedTrades(query)).toBe(9);
      storage.trades.createTrade(plannedTradeInput({
        id: "71000000-0000-4000-8000-000000000012",
        status: "OPEN",
        openedAt: END,
      }));
      expect(storage.trades.countOpenedTrades(query)).toBe(9);
      storage.trades.createTrade(plannedTradeInput({
        id: "71000000-0000-4000-8000-000000000013",
        status: "OPEN",
        openedAt: "2026-09-29T23:59:59.999Z",
      }));
      expect(storage.trades.countOpenedTrades(query)).toBe(10);
    } finally {
      storage.close();
    }
  });

  it("sums gross realized losses without offsetting winners or counting open and prior-day PnL", async () => {
    const storage = await createMemoryStorage(() => new Date("2026-09-29T12:00:00.000Z"));
    try {
      const records = [
        { id: "72000000-0000-4000-8000-000000000001", pnl: -30, closedAt: "2026-09-29T01:00:00.000Z", status: "CLOSED" as const },
        { id: "72000000-0000-4000-8000-000000000002", pnl: 100, closedAt: "2026-09-29T02:00:00.000Z", status: "CLOSED" as const },
        { id: "72000000-0000-4000-8000-000000000003", pnl: -25, closedAt: "2026-09-29T03:00:00.000Z", status: "CLOSED" as const },
        { id: "72000000-0000-4000-8000-000000000004", pnl: -500, closedAt: "2026-09-28T23:59:59.999Z", status: "CLOSED" as const },
        { id: "72000000-0000-4000-8000-000000000005", pnl: -900, closedAt: null, status: "OPEN" as const },
      ];
      for (const record of records) {
        storage.trades.createTrade(plannedTradeInput({
          id: record.id,
          status: record.status,
          marginUsdt: 50,
          leverage: 10,
          quantity: 1,
          entryPrice: 1,
          exitPrice: record.status === "CLOSED" ? 1 : null,
          realizedPnl: record.pnl,
          openedAt: "2026-09-29T00:30:00.000Z",
          closedAt: record.closedAt,
        }));
      }
      expect(storage.trades.sumRealizedLossUsdt({
        mode: "PAPER", symbol: "GPS_USDT", startAt: START, endAt: END,
      })).toBe(55);
    } finally {
      storage.close();
    }
  });
});
