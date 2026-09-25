import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaperTradingService } from "../../apps/server/src/trading/paper-trading-service.js";
import {
  PaperStateConflictError,
  PaperTradeInvalidTransitionError,
  PaperTradeModeError,
  PaperTradeSymbolError,
} from "../../apps/server/src/trading/paper-errors.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { TradeVersionConflictError } from "../../apps/server/src/storage/storage-errors.js";
import type { DashboardEvent } from "../../packages/shared/src/protocol.js";
import { plannedTradeInput } from "../task005/storage-test-helpers.js";

const FIXED_TIME = "2026-09-26T12:00:00.000Z";

describe("PaperTradingService lifecycle", () => {
  const storages: StorageService[] = [];
  const services: PaperTradingService[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    for (const storage of storages.splice(0)) storage.close();
    for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function makeStorage(databaseFile = ":memory:") {
    const storage = new StorageService({ databaseFile, now: () => new Date(FIXED_TIME) });
    await storage.initialize();
    storages.push(storage);
    return storage;
  }

  function makeService(storage: StorageService, events = new EventBus(), feeRate = 0) {
    let id = 1;
    const service = new PaperTradingService({
      storage,
      events,
      feeRate,
      clock: () => new Date(FIXED_TIME),
      idGenerator: () => `60000000-0000-4000-8000-${String(id++).padStart(12, "0")}`,
    });
    services.push(service);
    return service;
  }

  it.each([
    { side: "LONG" as const, mark: 0.011, exit: 0.011, expectedPnl: 50, expectedFees: 0.105, expectedRealized: 49.895 },
    { side: "SHORT" as const, mark: 0.009, exit: 0.009, expectedPnl: 50, expectedFees: 0.095, expectedRealized: 49.905 },
  ])("plans, opens, marks, and closes a deterministic $side paper trade", async ({ side, mark, exit, expectedPnl, expectedFees, expectedRealized }) => {
    const storage = await makeStorage();
    const events = new EventBus();
    const received: DashboardEvent[] = [];
    events.subscribe((event) => received.push(event));
    const service = makeService(storage, events, 0.0001);

    const planned = await service.planPaperTrade({
      symbol: "GPS_USDT",
      side,
      marginUsdt: 50,
      leverage: 10,
      plannedAt: "2026-09-26T12:00:00.000Z",
    });
    expect(planned).toMatchObject({ mode: "PAPER", status: "PLANNED", quantity: null, entryPrice: null });
    expect(service.getState()).toMatchObject({ status: "PLANNED", activeTradeId: planned.id, position: null });

    const opened = await service.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01, openedAt: "2026-09-26T12:00:01.000Z" });
    expect(opened).toMatchObject({ status: "OPEN", quantity: 50_000, fees: 0.05 });
    expect(service.getState().position).toMatchObject({ side, entryPrice: 0.01, quantity: 50_000, markPrice: null, unrealizedPnl: null });
    const storedVersion = opened.version;
    const markState = await service.markPaperTrade({ tradeId: planned.id, markPrice: mark, markedAt: "2026-09-26T12:00:02.000Z" });
    expect(markState.status).toBe("OPEN");
    expect(markState.position?.unrealizedPnl).toBeCloseTo(expectedPnl);
    expect(storage.trades.getTrade(planned.id)?.version).toBe(storedVersion);
    expect(storage.trades.getTrade(planned.id)?.status).toBe("OPEN");
    expect(storage.trades.listTradeEvents(planned.id).map((event) => event.eventType)).toEqual([
      "PAPER_TRADE_PLANNED",
      "PAPER_TRADE_OPENED",
    ]);

    const closed = await service.closePaperTrade({
      tradeId: planned.id,
      exitPrice: exit,
      closeReason: "SIMULATION",
      closedAt: "2026-09-26T12:00:03.000Z",
    });
    expect(closed.status).toBe("CLOSED");
    expect(closed.mode).toBe("PAPER");
    expect(closed.realizedPnl).toBeCloseTo(expectedRealized);
    expect(closed.fees).toBeCloseTo(expectedFees);
    expect(closed.closeReason).toBe("SIMULATION");
    expect(service.getState()).toMatchObject({ status: "IDLE", activeTradeId: null, position: null });
    expect(storage.trades.listTradeEvents(planned.id).map((event) => event.eventType)).toEqual([
      "PAPER_TRADE_PLANNED",
      "PAPER_TRADE_OPENED",
      "PAPER_TRADE_CLOSED",
    ]);
    expect(received.map((event) => event.type)).toContain("trade.opened");
    expect(received.map((event) => event.type)).toContain("trade.closed");
    expect(received.filter((event) => event.type === "paper.state").at(-1)?.payload).toMatchObject({ status: "IDLE" });
    expect(received.some((event) => event.type === "trade.closed" && event.payload.mode !== "PAPER")).toBe(false);
    await expect(service.closePaperTrade({ tradeId: planned.id, exitPrice: exit })).rejects.toThrow(PaperTradeInvalidTransitionError);
  });

  it("atomically rolls back plan creation when the planned event insert fails", async () => {
    const storage = await makeStorage();
    const collisionId = "70000000-0000-4000-8000-000000000001";
    storage.trades.appendTradeEvent({ id: collisionId, tradeId: null, eventType: "FIXTURE_EVENT" });
    const ids = ["70000000-0000-4000-8000-000000000002", collisionId];
    const service = new PaperTradingService({
      storage,
      events: new EventBus(),
      clock: () => new Date(FIXED_TIME),
      idGenerator: () => ids.shift()!,
    });
    services.push(service);

    await expect(service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 })).rejects.toThrow();
    expect(storage.trades.listTrades()).toEqual([]);
  });

  it("rolls open back to PLANNED when the opened event insert fails", async () => {
    const storage = await makeStorage();
    const collisionId = "71000000-0000-4000-8000-000000000001";
    storage.trades.appendTradeEvent({ id: collisionId, tradeId: null, eventType: "FIXTURE_EVENT" });
    const ids = [
      "71000000-0000-4000-8000-000000000002",
      "71000000-0000-4000-8000-000000000003",
      collisionId,
    ];
    const service = new PaperTradingService({ storage, events: new EventBus(), idGenerator: () => ids.shift()!, clock: () => new Date(FIXED_TIME) });
    services.push(service);
    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });

    await expect(service.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 })).rejects.toThrow();
    expect(storage.trades.getTrade(planned.id)).toMatchObject({ status: "PLANNED", version: 1, entryPrice: null });
    expect(service.getState().status).toBe("PLANNED");
  });

  it("rolls close back to OPEN when the closed event insert fails", async () => {
    const storage = await makeStorage();
    const collisionId = "72000000-0000-4000-8000-000000000001";
    storage.trades.appendTradeEvent({ id: collisionId, tradeId: null, eventType: "FIXTURE_EVENT" });
    const ids = [
      "72000000-0000-4000-8000-000000000002",
      "72000000-0000-4000-8000-000000000003",
      "72000000-0000-4000-8000-000000000004",
      collisionId,
    ];
    const service = new PaperTradingService({ storage, events: new EventBus(), idGenerator: () => ids.shift()!, clock: () => new Date(FIXED_TIME) });
    services.push(service);
    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await service.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 });

    await expect(service.closePaperTrade({ tradeId: planned.id, exitPrice: 0.011 })).rejects.toThrow();
    expect(storage.trades.getTrade(planned.id)).toMatchObject({ status: "OPEN", version: 2, exitPrice: null, realizedPnl: null });
    expect(service.getState().status).toBe("OPEN");
  });

  it("rejects illegal transitions without changing stored records", async () => {
    const storage = await makeStorage();
    const service = makeService(storage);
    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });

    await expect(service.planPaperTrade({ symbol: "GPS_USDT", side: "SHORT", marginUsdt: 50, leverage: 10 })).rejects.toThrow(PaperTradeInvalidTransitionError);
    await expect(service.closePaperTrade({ tradeId: planned.id, exitPrice: 0.011 })).rejects.toThrow(PaperTradeInvalidTransitionError);
    await expect(service.markPaperTrade({ tradeId: planned.id, markPrice: 0.011 })).rejects.toThrow(PaperTradeInvalidTransitionError);
    expect(storage.trades.getTrade(planned.id)).toMatchObject({ status: "PLANNED", version: 1 });

    const closed = storage.trades.createTrade(plannedTradeInput({
      id: "70000000-0000-4000-8000-000000000009",
      status: "CLOSED",
      marginUsdt: 50,
      leverage: 10,
      quantity: 50_000,
      entryPrice: 0.01,
      exitPrice: 0.011,
      realizedPnl: 50,
      fees: 0,
      closedAt: FIXED_TIME,
    }));
    await expect(service.openPaperTrade({ tradeId: closed.id, entryPrice: 0.01 })).rejects.toThrow(PaperTradeInvalidTransitionError);
    expect(storage.trades.getTrade(closed.id)?.status).toBe("CLOSED");
  });

  it("does not retry an optimistic storage conflict and rereads runtime state", async () => {
    const storage = await makeStorage();
    const service = makeService(storage);
    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    const repository = storage.trades;
    const originalTransition = repository.recordTradeTransition.bind(repository);
    let transitionAttempts = 0;
    repository.recordTradeTransition = ((_input: Parameters<typeof repository.recordTradeTransition>[0]) => {
      transitionAttempts += 1;
      repository.updateTrade(planned.id, {
        expectedVersion: 1,
        status: "CLOSED",
        exitPrice: 0.011,
        realizedPnl: 50,
        fees: 0,
        closedAt: FIXED_TIME,
      });
      throw new TradeVersionConflictError();
    }) as typeof repository.recordTradeTransition;

    await expect(service.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 })).rejects.toThrow(PaperStateConflictError);
    expect(transitionAttempts).toBe(1);
    expect(service.getState()).toMatchObject({ status: "IDLE", activeTradeId: null, position: null });
    expect(repository.getTrade(planned.id)).toMatchObject({ status: "CLOSED", version: 2 });
    repository.recordTradeTransition = originalTransition;
  });

  it("enforces PAPER mode and GPS_USDT symbol guards", async () => {
    const storage = await makeStorage();
    const service = makeService(storage);
    await expect(service.planPaperTrade({ symbol: "ETH_USDT", side: "LONG", marginUsdt: 50, leverage: 10 })).rejects.toThrow(PaperTradeSymbolError);

    const liveTrade = storage.trades.createTrade(plannedTradeInput({ mode: "LIVE", status: "PLANNED" }));
    await expect(service.openPaperTrade({ tradeId: liveTrade.id, entryPrice: 0.01 })).rejects.toThrow(PaperTradeModeError);
    const otherSymbol = storage.trades.createTrade(plannedTradeInput({ symbol: "ETH_USDT" }));
    await expect(service.openPaperTrade({ tradeId: otherSymbol.id, entryPrice: 0.01 })).rejects.toThrow(PaperTradeSymbolError);
    expect(storage.trades.getTrade(liveTrade.id)?.status).toBe("PLANNED");
    expect(storage.trades.getTrade(otherSymbol.id)?.status).toBe("PLANNED");
  });

  it("rejects non-finite or non-positive plan and simulated fill inputs before writes", async () => {
    const storage = await makeStorage();
    const service = makeService(storage);
    await expect(service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 0, leverage: 10 })).rejects.toThrow();
    await expect(service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: Number.POSITIVE_INFINITY })).rejects.toThrow();
    expect(storage.trades.listTrades()).toHaveLength(0);

    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await expect(service.openPaperTrade({ tradeId: planned.id, entryPrice: 0 })).rejects.toThrow();
    expect(storage.trades.getTrade(planned.id)).toMatchObject({ status: "PLANNED", version: 1 });
    expect(() => new PaperTradingService({ storage, events: new EventBus(), feeRate: 0.02 })).toThrow();
  });

  it("allows at most one open position during concurrent open calls", async () => {
    const storage = await makeStorage();
    const first = storage.trades.createTrade(plannedTradeInput({ id: "73000000-0000-4000-8000-000000000001", marginUsdt: 50, leverage: 10 }));
    const second = storage.trades.createTrade(plannedTradeInput({ id: "73000000-0000-4000-8000-000000000002", marginUsdt: 50, leverage: 10 }));
    const service = makeService(storage);

    const results = await Promise.allSettled([
      service.openPaperTrade({ tradeId: first.id, entryPrice: 0.01 }),
      service.openPaperTrade({ tradeId: second.id, entryPrice: 0.01 }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(storage.trades.listOpenPaperTrades({ symbol: "GPS_USDT", limit: 2 })).toHaveLength(1);
    expect([storage.trades.getTrade(first.id)?.status, storage.trades.getTrade(second.id)?.status].sort()).toEqual(["OPEN", "PLANNED"]);
    expect(service.getState()).toMatchObject({ status: "OPEN", activeTradeId: first.id });
  });

  it("halts recovery and future mutations when more than one open paper record exists", async () => {
    const storage = await makeStorage();
    storage.trades.createTrade(plannedTradeInput({ id: "74000000-0000-4000-8000-000000000001", status: "OPEN", marginUsdt: 50, leverage: 10, quantity: 50_000, entryPrice: 0.01, openedAt: FIXED_TIME }));
    storage.trades.createTrade(plannedTradeInput({ id: "74000000-0000-4000-8000-000000000002", status: "OPEN", marginUsdt: 50, leverage: 10, quantity: 50_000, entryPrice: 0.01, openedAt: FIXED_TIME }));
    const service = makeService(storage);

    await expect(service.recover()).rejects.toThrow(PaperStateConflictError);
    expect(service.getState()).toMatchObject({ status: "ERROR", activeTradeId: null, position: null });
    await expect(service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 })).rejects.toThrow(PaperStateConflictError);
  });

  it("ignores LIVE open records during paper recovery", async () => {
    const storage = await makeStorage();
    storage.trades.createTrade(plannedTradeInput({ mode: "LIVE", status: "OPEN", marginUsdt: 50, leverage: 10, quantity: 50_000, entryPrice: 0.01, openedAt: FIXED_TIME }));
    const service = makeService(storage);

    await expect(service.recover()).resolves.toMatchObject({ status: "IDLE", activeTradeId: null, position: null });
  });

  it("recovers one open trade after a persistent database restart without duplicating events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paper-recovery-"));
    temporaryDirectories.push(directory);
    const fileName = join(directory, "trading.sqlite3");
    const storageA = await makeStorage(fileName);
    const serviceA = makeService(storageA);
    const planned = await serviceA.planPaperTrade({ symbol: "GPS_USDT", side: "SHORT", marginUsdt: 50, leverage: 10 });
    await serviceA.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 });
    const eventsBeforeRestart = storageA.trades.listTradeEvents(planned.id);
    await serviceA.close();
    services.splice(services.indexOf(serviceA), 1);
    storageA.close();
    storages.splice(storages.indexOf(storageA), 1);

    const storageB = await makeStorage(fileName);
    const serviceB = makeService(storageB);
    const recovered = await serviceB.recover();
    expect(recovered).toMatchObject({ status: "OPEN", activeTradeId: planned.id });
    expect(recovered.position).toMatchObject({ side: "SHORT", entryPrice: 0.01, quantity: 50_000, marginUsdt: 50, leverage: 10, markPrice: null, unrealizedPnl: null });
    expect(storageB.trades.listTradeEvents(planned.id)).toEqual(eventsBeforeRestart);
  });

  it("uses only a bounded query for open paper positions", async () => {
    const storage = await makeStorage();
    expect(() => storage.trades.listOpenPaperTrades({ symbol: "GPS_USDT", limit: 3 })).toThrow(RangeError);
  });
});
