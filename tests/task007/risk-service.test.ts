import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KillSwitchService } from "../../apps/server/src/risk/kill-switch.js";
import { RiskService } from "../../apps/server/src/risk/risk-service.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import type { DashboardEvent } from "../../packages/shared/src/protocol.js";
import { plannedTradeInput } from "../task005/storage-test-helpers.js";

const NOW = "2026-09-29T12:00:00.000Z";

describe("RiskService runtime state and durable failure history", () => {
  const storages: StorageService[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const storage of storages.splice(0)) storage.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  });

  async function setup() {
    const storage = new StorageService({ databaseFile: ":memory:", now: () => new Date(NOW) });
    await storage.initialize();
    storages.push(storage);
    const directory = await mkdtemp(join(tmpdir(), "task007-risk-"));
    directories.push(directory);
    const path = join(directory, "KILL_SWITCH");
    const events = new EventBus();
    const observed: DashboardEvent[] = [];
    events.subscribe((event) => observed.push(event));
    const makeRisk = () => new RiskService({
      storage,
      events,
      killSwitch: new KillSwitchService(path),
      now: () => new Date(NOW),
    });
    const risk = makeRisk();
    await risk.initialize();
    return { storage, path, events, observed, risk, makeRisk };
  }

  it("initializes PAPER metrics and publishes the authoritative runtime state", async () => {
    const { risk, observed } = await setup();
    expect(risk.getState()).toMatchObject({
      status: "READY",
      killSwitch: "CLEAR",
      metrics: {
        mode: "PAPER",
        dateKey: "2026-09-29",
        dailyOpenedTrades: 0,
        dailyRealizedLossUsdt: 0,
        consecutiveFailures: 0,
      },
    });
    expect(observed.some((event) => event.type === "risk.state")).toBe(true);
  });

  it("fails closed on Kill Switch presence and returns to READY after operator removal and refresh", async () => {
    const { risk, path } = await setup();
    await writeFile(path, "content is ignored", { mode: 0o600 });
    expect((await risk.refresh()).status).toBe("HALTED");
    expect(risk.getState().killSwitch).toBe("ENGAGED");
    await unlink(path);
    expect((await risk.refresh()).status).toBe("READY");
    expect(risk.getState().killSwitch).toBe("CLEAR");
  });

  it("restores consecutive failures newest-first across service recreation", async () => {
    const { risk, makeRisk } = await setup();
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    const restarted = makeRisk();
    expect((await restarted.initialize()).metrics.consecutiveFailures).toBe(2);
    await restarted.recordExecutionSuccess();
    const afterSuccess = makeRisk();
    expect((await afterSuccess.initialize()).metrics.consecutiveFailures).toBe(0);
    await afterSuccess.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    const afterNextFailure = makeRisk();
    expect((await afterNextFailure.initialize()).metrics.consecutiveFailures).toBe(1);
  });

  it("stops recovery at success and halts when the failure threshold is reached", async () => {
    const { risk, makeRisk } = await setup();
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    await risk.recordExecutionSuccess();
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    const restarted = makeRisk();
    expect((await restarted.initialize()).metrics.consecutiveFailures).toBe(2);
    await restarted.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    expect(restarted.getState()).toMatchObject({
      status: "HALTED",
      metrics: { consecutiveFailures: 3 },
      reasons: ["CONSECUTIVE_FAILURE_LIMIT"],
    });
  });

  it("blocks a LIVE intent without creating a live execution path", async () => {
    const { risk, storage } = await setup();
    const result = await risk.evaluatePreTrade({
      mode: "LIVE", symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain("LIVE_TRADING_DISABLED");
    expect(storage.trades.listTrades()).toEqual([]);
  });

  it("marks storage degradation as HALTED and never fabricates zero metrics", async () => {
    const { risk, storage } = await setup();
    storage.getHealth = () => ({ status: "DEGRADED", schemaVersion: null });
    const state = await risk.refresh();
    expect(state.status).toBe("HALTED");
    expect(state.metrics.dailyOpenedTrades).toBeNull();
    expect(state.metrics.dailyRealizedLossUsdt).toBeNull();
    expect(state.reasons).toContain("STORAGE_DEGRADED");
  });

  it("fails closed when persisted risk failure history is corrupt", async () => {
    const { risk, storage, makeRisk } = await setup();
    await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    const database = (storage as unknown as {
      database: { getConnection(): { prepare(sql: string): { run(...values: unknown[]): unknown } } };
    }).database.getConnection();
    database.prepare("UPDATE audit_events SET payload_json = ? WHERE event_type = 'RISK_EXECUTION_FAILURE'")
      .run(JSON.stringify({ password: "must-not-be-accepted" }));

    const restarted = makeRisk();
    const state = await restarted.initialize();
    expect(state.status).toBe("HALTED");
    expect(state.metrics.consecutiveFailures).toBeNull();
    expect(state.reasons).toContain("STORAGE_DEGRADED");
  });

  it("fails closed if an execution failure cannot be durably audited", async () => {
    const { risk, storage } = await setup();
    storage.auditEvents.appendAuditEvent = () => {
      throw new Error("fixture write failure");
    };
    const state = await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    expect(state.status).toBe("HALTED");
    expect(state.metrics.consecutiveFailures).toBeNull();
    expect(state.reasons).toContain("STORAGE_DEGRADED");
  });

  it("treats two open Paper records as a position conflict, not as flat", async () => {
    const { risk, storage } = await setup();
    for (let index = 0; index < 2; index += 1) {
      storage.trades.createTrade(plannedTradeInput({
        id: `76000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        status: "OPEN",
        marginUsdt: 50,
        leverage: 10,
        quantity: 1,
        entryPrice: 1,
        openedAt: NOW,
      }));
    }
    const state = await risk.refresh();
    expect(state.status).toBe("HALTED");
    expect(state.metrics.dailyOpenedTrades).toBe(2);
    expect(state.reasons).toContain("POSITION_UNKNOWN");
    expect(state.reasons).not.toContain("STORAGE_DEGRADED");
  });
});
