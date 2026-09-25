import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthState } from "../../packages/shared/src/protocol.js";
import { StorageHealthSchema, TradeHistoryResponseSchema } from "../../packages/shared/src/storage.js";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import type { AuthService } from "../../apps/server/src/auth/auth-service.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { createAuthFixture } from "../task002/helpers.js";
import { plannedTradeInput } from "./storage-test-helpers.js";

describe("read-only storage APIs and dashboard history", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const storages: StorageService[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const storage of storages.splice(0)) storage.close();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function startServer() {
    let tick = 0;
    const storage = new StorageService({
      databaseFile: ":memory:",
      now: () => new Date(Date.UTC(2026, 8, 25, 12, 0, tick++)),
    });
    await storage.initialize();
    storages.push(storage);

    const fixture = await createAuthFixture();
    cleanups.push(fixture.cleanup);
    const state: AuthState = {
      status: "VAULT_UNLOCKED",
      authProvider: "FAKE",
      credentialsSaved: false,
      liveTrading: false,
      updatedAt: "2026-09-25T12:00:00.000Z",
    };
    const auth = { getState: () => state } as unknown as AuthService;
    const server = createDashboardServer({ auth, vault: fixture.vault, events: new EventBus(), storage });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}`, storage };
  }

  it("serves validated bounded history and storage health without private fields", async () => {
    const { url, storage } = await startServer();
    const emptyDashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as {
      status: { storage: string };
      history: unknown[];
    };
    expect(emptyDashboard.status.storage).toBe("READY");
    expect(emptyDashboard.history).toEqual([]);

    const older = storage.trades.createTrade(plannedTradeInput({ status: "CLOSED", exitPrice: 0.021, realizedPnl: 1.5, fees: 0.05 }));
    const newer = storage.trades.createTrade(plannedTradeInput({ side: "SHORT", mode: "LIVE", status: "OPEN", entryPrice: 0.03 }));

    const response = await fetch(`${url}/api/v1/history/trades?limit=2`);
    expect(response.status).toBe(200);
    const history = TradeHistoryResponseSchema.parse(await response.json());
    expect(history.trades).toHaveLength(2);
    expect(history.trades.map((trade) => trade.id)).toEqual([newer.id, older.id]);
    expect(history.trades[0]).toMatchObject({ mode: "LIVE", side: "SHORT", status: "OPEN" });

    const healthResponse = await fetch(`${url}/api/v1/storage/health`);
    expect(healthResponse.status).toBe(200);
    const health = StorageHealthSchema.parse(await healthResponse.json());
    expect(health).toEqual({ status: "READY", schemaVersion: 1 });
    expect(Object.keys(health)).toEqual(["status", "schemaVersion"]);

    const dashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as {
      status: { storage: string };
      history: Array<{ id: string }>;
    };
    expect(dashboard.status.storage).toBe("READY");
    expect(dashboard.history.map((trade) => trade.id)).toEqual([newer.id, older.id]);
  });

  it.each(["0", "9999", "invalid"])("returns HTTP 400 for invalid history limit %s", async (limit) => {
    const { url } = await startServer();
    const response = await fetch(`${url}/api/v1/history/trades?limit=${limit}`);
    expect(response.status).toBe(400);
  });

  it("rejects duplicate limit parameters and exposes no trade write endpoint", async () => {
    const { url } = await startServer();
    expect((await fetch(`${url}/api/v1/history/trades?limit=1&limit=2`)).status).toBe(400);
    expect((await fetch(`${url}/api/v1/trades`, { method: "POST" })).status).toBe(404);
  });

  it("returns empty degraded history when a runtime storage read is unavailable", async () => {
    const { url, storage } = await startServer();
    storage.close();

    const response = await fetch(`${url}/api/v1/dashboard/snapshot`);
    const dashboard = await response.json() as {
      status: { storage: string };
      history: unknown[];
      logs: Array<{ message: string }>;
    };
    expect(dashboard.status.storage).toBe("DEGRADED");
    expect(dashboard.history).toEqual([]);
    expect(dashboard.logs[0]?.message).toBe("Trade history storage is temporarily unavailable.");
    await expect((await fetch(`${url}/api/v1/storage/health`)).json()).resolves.toMatchObject({ status: "DEGRADED", schemaVersion: null });
    expect((await fetch(`${url}/api/v1/history/trades`)).status).toBe(503);
  });

  it.each(["schema_migrations", "trades", "trade_events", "daily_plans", "audit_events"])(
    "reports DEGRADED when required table %s is missing",
    async (table) => {
      const { url, storage } = await startServer();
      const database = (storage as unknown as {
        database: { getConnection(): { exec(sql: string): void } };
      }).database.getConnection();
      database.exec(`DROP TABLE ${table}`);

      expect(storage.getHealth()).toEqual({ status: "DEGRADED", schemaVersion: null });
      const health = await (await fetch(`${url}/api/v1/storage/health`)).json() as {
        status: string;
        schemaVersion: number | null;
      };
      expect(health).toEqual({ status: "DEGRADED", schemaVersion: null });

      const dashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as {
        status: { storage: string };
        history: unknown[];
      };
      expect(dashboard.status.storage).toBe("DEGRADED");
      expect(dashboard.history).toEqual([]);
    },
  );
});
