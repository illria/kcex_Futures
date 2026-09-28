import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { KillSwitchService } from "../../apps/server/src/risk/kill-switch.js";
import { RiskService } from "../../apps/server/src/risk/risk-service.js";
import { RiskBlockedError } from "../../apps/server/src/risk/risk-errors.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { PaperTradingService } from "../../apps/server/src/trading/paper-trading-service.js";
import type { DashboardEvent } from "../../packages/shared/src/protocol.js";
import { plannedTradeInput } from "../task005/storage-test-helpers.js";

const NOW = "2026-09-29T12:00:00.000Z";

describe("PaperTradingService risk gate", () => {
  const storages: StorageService[] = [];
  const services: PaperTradingService[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close();
    for (const storage of storages.splice(0)) storage.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function setup(options: { maxDailyTrades?: number; maxDailyLossUsdt?: number } = {}) {
    const storage = new StorageService({ databaseFile: ":memory:", now: () => new Date(NOW) });
    await storage.initialize();
    storages.push(storage);
    const directory = await mkdtemp(join(tmpdir(), "task007-paper-risk-"));
    directories.push(directory);
    const path = join(directory, "KILL_SWITCH");
    const events = new EventBus();
    const observed: DashboardEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const risk = new RiskService({
      storage,
      events,
      killSwitch: new KillSwitchService(path),
      limits: {
        maxMarginUsdt: 50,
        maxLeverage: 10,
        maxDailyTrades: options.maxDailyTrades ?? 10,
        maxDailyLossUsdt: options.maxDailyLossUsdt ?? 50,
        maxConsecutiveFailures: 3,
      },
      now: () => new Date(NOW),
    });
    await risk.initialize();
    const paper = new PaperTradingService({ storage, events, risk, clock: () => new Date(NOW) });
    services.push(paper);
    await paper.recover();
    return { storage, path, events, observed, risk, paper };
  }

  it("keeps a blocked plan byte-for-byte unchanged and records one safe audit", async () => {
    const { storage, observed, paper } = await setup();
    const planned = await paper.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50.01, leverage: 10 });
    await expect(paper.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 })).rejects.toMatchObject({
      name: "RiskBlockedError",
      reasons: ["MARGIN_LIMIT"],
    });
    expect(storage.trades.getTrade(planned.id)).toMatchObject({
      status: "PLANNED", version: 1, entryPrice: null, quantity: null,
    });
    expect(storage.trades.listTradeEvents(planned.id).map((event) => event.eventType)).toEqual(["PAPER_TRADE_PLANNED"]);
    const blockedAudits = storage.auditEvents.listAuditEvents({ limit: 10 })
      .filter((event) => event.eventType === "RISK_BLOCKED");
    expect(blockedAudits).toHaveLength(1);
    expect(blockedAudits[0]?.payload).toMatchObject({ reasons: ["MARGIN_LIMIT"], symbol: "GPS_USDT" });
    expect(observed.some((event) => event.type === "risk.blocked")).toBe(true);
    expect(observed.filter((event) => event.type === "risk.state").length).toBeGreaterThan(1);
  });

  it("allows the same planned trade after the operator clears the Kill Switch and RiskService refreshes", async () => {
    const { path, risk, paper } = await setup();
    const planned = await paper.planPaperTrade({ symbol: "GPS_USDT", side: "SHORT", marginUsdt: 50, leverage: 10 });
    await writeFile(path, "ignored", { mode: 0o600 });
    await expect(paper.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 }))
      .rejects.toBeInstanceOf(RiskBlockedError);
    expect((await risk.refresh()).killSwitch).toBe("ENGAGED");
    await unlink(path);
    expect((await risk.refresh()).killSwitch).toBe("CLEAR");
    expect((await paper.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 })).status).toBe("OPEN");
  });

  it("blocks an entry at the daily opened-trade limit", async () => {
    const { storage, paper } = await setup();
    for (let index = 0; index < 10; index += 1) {
      storage.trades.createTrade(plannedTradeInput({
        id: `73000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        status: "CLOSED",
        openedAt: `2026-09-29T0${index}:00:00.000Z`,
        closedAt: `2026-09-29T0${index}:30:00.000Z`,
        realizedPnl: 0,
      }));
    }
    const planned = await paper.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await expect(paper.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 }))
      .rejects.toMatchObject({ reasons: ["DAILY_TRADE_LIMIT"] });
    expect(storage.trades.getTrade(planned.id)).toMatchObject({ status: "PLANNED", version: 1 });
  });

  it("blocks on daily gross realized loss and on degraded storage", async () => {
    const lossFixture = await setup();
    lossFixture.storage.trades.createTrade(plannedTradeInput({
      id: "74000000-0000-4000-8000-000000000001",
      status: "CLOSED",
      openedAt: "2026-09-29T01:00:00.000Z",
      closedAt: "2026-09-29T02:00:00.000Z",
      realizedPnl: -50,
    }));
    const plannedLoss = await lossFixture.paper.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await expect(lossFixture.paper.openPaperTrade({ tradeId: plannedLoss.id, entryPrice: 0.01 }))
      .rejects.toMatchObject({ reasons: ["DAILY_LOSS_LIMIT"] });

    const degradedFixture = await setup();
    const plannedDegraded = await degradedFixture.paper.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    degradedFixture.storage.getHealth = () => ({ status: "DEGRADED", schemaVersion: null });
    await expect(degradedFixture.paper.openPaperTrade({ tradeId: plannedDegraded.id, entryPrice: 0.01 }))
      .rejects.toMatchObject({ reasons: expect.arrayContaining(["STORAGE_DEGRADED"]) });
    expect(degradedFixture.storage.trades.getTrade(plannedDegraded.id)).toMatchObject({ status: "PLANNED", version: 1 });
  });

  it("keeps mark and close available when Kill Switch and entry limits are halted", async () => {
    const { path, storage, paper } = await setup({ maxDailyTrades: 1, maxDailyLossUsdt: 1 });
    const planned = await paper.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await paper.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 });
    storage.trades.createTrade(plannedTradeInput({
      id: "75000000-0000-4000-8000-000000000001",
      status: "CLOSED",
      openedAt: "2026-09-29T01:00:00.000Z",
      closedAt: "2026-09-29T02:00:00.000Z",
      realizedPnl: -5,
    }));
    await writeFile(path, "engaged", { mode: 0o600 });
    await paper.markPaperTrade({ tradeId: planned.id, markPrice: 0.011 });
    const closed = await paper.closePaperTrade({ tradeId: planned.id, exitPrice: 0.011 });
    expect(closed.status).toBe("CLOSED");
    expect(closed.realizedPnl).toBeGreaterThan(0);
  });

  it("uses the bounded Paper position query to block another risk intent", async () => {
    const { risk, paper } = await setup();
    const planned = await paper.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await paper.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 });
    const result = await risk.evaluatePreTrade({ mode: "PAPER", symbol: "GPS_USDT", side: "SHORT", marginUsdt: 50, leverage: 10 });
    expect(result.status).toBe("BLOCKED");
    expect(result.reasons).toContain("POSITION_OPEN");
  });
});
