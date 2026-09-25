import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import type { AuthService } from "../../apps/server/src/auth/auth-service.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { PaperTradingService } from "../../apps/server/src/trading/paper-trading-service.js";
import { DashboardSnapshotSchema, parseDashboardEvent, type AuthState } from "../../packages/shared/src/protocol.js";
import { PaperTradingStateSchema } from "../../packages/shared/src/paper-trading.js";
import { createAuthFixture } from "../task002/helpers.js";

describe("read-only Paper Trading API and WebSocket state", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const storages: StorageService[] = [];
  const services: PaperTradingService[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const service of services.splice(0)) await service.close();
    for (const storage of storages.splice(0)) storage.close();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function startServer() {
    const fixture = await createAuthFixture();
    cleanups.push(fixture.cleanup);
    const storage = new StorageService({ databaseFile: ":memory:" });
    await storage.initialize();
    storages.push(storage);
    const events = new EventBus();
    const service = new PaperTradingService({ storage, events });
    services.push(service);
    const state: AuthState = {
      status: "VAULT_UNLOCKED",
      authProvider: "FAKE",
      credentialsSaved: false,
      liveTrading: false,
      updatedAt: new Date(0).toISOString(),
    };
    const auth = { getState: () => state } as unknown as AuthService;
    const server = createDashboardServer({ auth, vault: fixture.vault, events, storage, paperTrading: service });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}`, service, storage };
  }

  it("serves the paper runtime through read-only GET endpoints", async () => {
    const { url, storage } = await startServer();
    expect(storage.getSchemaVersion()).toBe(1);
    const paperResponse = await fetch(`${url}/api/v1/paper/state`);
    expect(paperResponse.status).toBe(200);
    expect(PaperTradingStateSchema.parse(await paperResponse.json())).toMatchObject({
      status: "IDLE",
      activeTradeId: null,
      position: null,
    });

    const dashboard = DashboardSnapshotSchema.parse(await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json());
    expect(dashboard.paper.status).toBe("IDLE");
    expect(dashboard.position).toMatchObject({
      symbol: "GPS_USDT",
      side: "NONE",
      entryPrice: null,
      size: null,
      unrealizedPnl: null,
      source: "MOCK",
      health: "READY",
      freshness: "FRESH",
    });
  });

  it.each([
    "/api/v1/paper/plan",
    "/api/v1/paper/open",
    "/api/v1/paper/close",
    "/api/v1/orders",
  ])("does not expose a paper or order write endpoint at %s", async (path) => {
    const { url } = await startServer();
    expect((await fetch(`${url}${path}`, { method: "POST" })).status).toBe(404);
  });

  it("serves closed paper trades through the existing SQLite Dashboard history", async () => {
    const { url, service } = await startServer();
    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "LONG", marginUsdt: 50, leverage: 10 });
    await service.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 });
    await service.closePaperTrade({ tradeId: planned.id, exitPrice: 0.011 });

    const dashboard = DashboardSnapshotSchema.parse(await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json());
    expect(dashboard.paper.status).toBe("IDLE");
    expect(dashboard.history[0]).toMatchObject({
      id: planned.id,
      mode: "PAPER",
      status: "CLOSED",
      entryPrice: 0.01,
      exitPrice: 0.011,
      fees: 0,
    });
    expect(dashboard.history[0]?.realizedPnl).toBeCloseTo(50);
  });

  it("sends authoritative paper.state on each new WebSocket connection", async () => {
    const { url, service } = await startServer();
    const planned = await service.planPaperTrade({ symbol: "GPS_USDT", side: "SHORT", marginUsdt: 50, leverage: 10 });
    await service.openPaperTrade({ tradeId: planned.id, entryPrice: 0.01 });
    const events = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/api/v1/events", { headers: { origin: url } });
      const seen: ReturnType<typeof parseDashboardEvent>[] = [];
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          seen.push(event);
          if (event.type === "system.heartbeat") {
            socket.close();
            resolve(seen);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
    const paper = events.find((event) => event.type === "paper.state");
    expect(paper?.type).toBe("paper.state");
    if (paper?.type === "paper.state") {
      expect(paper.payload).toMatchObject({
        status: "OPEN",
        activeTradeId: planned.id,
        position: { tradeId: planned.id, side: "SHORT", markPrice: null, unrealizedPnl: null },
      });
    }
  });
});
