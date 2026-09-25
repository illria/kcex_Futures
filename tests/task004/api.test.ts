import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthState } from "../../packages/shared/src/protocol.js";
import { createFakeFuturesSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { FuturesReadService } from "../../apps/server/src/futures/futures-read-service.js";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import type { AuthService } from "../../apps/server/src/auth/auth-service.js";
import { createAuthFixture } from "../task002/helpers.js";
import { parseDashboardEvent } from "../../packages/shared/src/protocol.js";

function authState(status: AuthState["status"], provider: AuthState["authProvider"] = "KCEX"): AuthState {
  return {
    status,
    authProvider: provider,
    credentialsSaved: true,
    liveTrading: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function kcexSnapshot() {
  const fixture = createFakeFuturesSnapshot(new Date().toISOString());
  return {
    ...fixture,
    source: "KCEX" as const,
    market: { ...fixture.market, source: "KCEX" as const },
    account: { ...fixture.account, source: "KCEX" as const },
    contract: { ...fixture.contract, source: "KCEX" as const },
    position: { ...fixture.position, source: "KCEX" as const },
    openOrders: {
      ...fixture.openOrders,
      source: "KCEX" as const,
      orders: fixture.openOrders.orders.map((order) => ({ ...order, source: "KCEX" as const })),
    },
  };
}

describe("TASK-004 read-only API boundaries", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function startServer(state: AuthState, futuresRead?: FuturesReadService) {
    const fixture = await createAuthFixture();
    cleanups.push(fixture.cleanup);
    const auth = { getState: () => state } as unknown as AuthService;
    const server = createDashboardServer({ auth, vault: fixture.vault, events: fixture.events, futuresRead });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  async function readInitialEvents(url: string): Promise<ReturnType<typeof parseDashboardEvent>[]> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/api/v1/events", { headers: { origin: url } });
      const eventsSeen: ReturnType<typeof parseDashboardEvent>[] = [];
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          eventsSeen.push(event);
          if (event.type === "system.heartbeat") {
            socket.close();
            resolve(eventsSeen);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
  }

  it("requires an authenticated KCEX state and never serves a mock futures snapshot", async () => {
    const unauthenticatedUrl = await startServer(authState("CREDENTIALS_REQUIRED"));
    const unauthenticated = await fetch(`${unauthenticatedUrl}/api/v1/futures/snapshot`);
    expect(unauthenticated.status).toBe(409);
    expect(await unauthenticated.json()).toEqual({ error: "Authenticated KCEX session required." });

    const authenticatedUrl = await startServer(authState("AUTHENTICATED"));
    const authenticated = await fetch(`${authenticatedUrl}/api/v1/futures/snapshot`);
    expect(authenticated.status).toBe(503);
    expect(await authenticated.json()).toEqual({ error: "KCEX read-only snapshot is not available yet." });
  });

  it("serves KCEX latest data only for an authenticated state", async () => {
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: "READY", snapshot: kcexSnapshot() }) },
      events: new EventBus(),
      logger: { info: () => undefined } as never,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5000,
    });
    await service.pollOnce();

    const authenticatedUrl = await startServer(authState("AUTHENTICATED"), service);
    const authenticated = await fetch(`${authenticatedUrl}/api/v1/futures/snapshot`);
    expect(authenticated.status).toBe(200);
    expect((await authenticated.json()).source).toBe("KCEX");

    for (const status of ["SESSION_LOST", "AUTH_UNKNOWN", "MANUAL_CHALLENGE"] as const) {
      const blockedUrl = await startServer(authState(status), service);
      const blocked = await fetch(`${blockedUrl}/api/v1/futures/snapshot`);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({ error: "Authenticated KCEX session required." });
    }
  });

  it("streams a current KCEX snapshot without mock financial events", async () => {
    const events = new EventBus();
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: "READY", snapshot: kcexSnapshot() }) },
      events,
      logger: { info: () => undefined } as never,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5000,
    });
    await service.pollOnce();

    const fixture = await createAuthFixture();
    cleanups.push(fixture.cleanup);
    const auth = { getState: () => authState("AUTHENTICATED") } as unknown as AuthService;
    const server = createDashboardServer({ auth, vault: fixture.vault, events, futuresRead: service });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    const wsUrl = `ws://127.0.0.1:${address.port}/api/v1/events`;
    const received = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { origin: `http://127.0.0.1:${address.port}` } });
      const eventsSeen: ReturnType<typeof parseDashboardEvent>[] = [];
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          eventsSeen.push(parseDashboardEvent(JSON.parse(message.toString())));
          const types = new Set(eventsSeen.map((event) => event.type));
          if ((["futures.snapshot", "market.snapshot", "account.balance", "futures.contract", "position.changed", "orders.snapshot", "futures.read-health"] as const).every((type) => types.has(type))) {
            socket.close();
            resolve(eventsSeen);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });

    const financial = received.filter((event) => [
      "futures.snapshot", "market.snapshot", "account.balance", "futures.contract", "position.changed", "orders.snapshot", "futures.read-health",
    ].includes(event.type));
    expect(financial).toHaveLength(7);
    expect(financial.every((event) => "source" in event.payload && event.payload.source === "KCEX")).toBe(true);
    expect(received.find((event) => event.type === "futures.snapshot")?.payload.source).toBe("KCEX");
    expect(received.some((event) => event.type === "market.snapshot" && event.payload.source === "MOCK")).toBe(false);
  });

  it("uses the reader state on HTTP and WebSocket reconnects after failed reads", async () => {
    let readCount = 0;
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const service = new FuturesReadService({
      adapter: {
        readSnapshot: async () => {
          readCount += 1;
          return readCount === 1
            ? { status: "READY" as const, snapshot: { ...kcexSnapshot(), updatedAt } }
            : { status: "UNKNOWN" as const, reason: "fixture evidence unavailable" };
        },
      },
      events: new EventBus(),
      logger: { info: () => undefined } as never,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5000,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });
    await service.pollOnce();
    await service.pollOnce();
    await service.pollOnce();

    const url = await startServer(authState("AUTHENTICATED"), service);
    const dashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as {
      status: { readHealth: string; browser: string };
      futures: { updatedAt: string; freshness: string; source: string };
    };
    expect(dashboard.status.readHealth).toBe("UNKNOWN");
    expect(dashboard.status.browser).toBe("DEGRADED");
    expect(dashboard.futures.source).toBe("KCEX");
    expect(dashboard.futures.updatedAt).toBe(updatedAt);
    expect(dashboard.futures.freshness).toBe("STALE");

    const address = new URL(url);
    const received = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/events`, { headers: { origin: url } });
      const eventsSeen: ReturnType<typeof parseDashboardEvent>[] = [];
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          eventsSeen.push(event);
          if (event.type === "futures.read-health") {
            socket.close();
            resolve(eventsSeen);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
    const health = received.find((event) => event.type === "futures.read-health");
    expect(health?.type).toBe("futures.read-health");
    if (health?.type === "futures.read-health") {
      expect(health.payload.status).toBe("UNKNOWN");
      expect(health.payload.health).toBe("UNKNOWN");
      expect(health.payload.consecutiveReadFailures).toBe(2);
    }
  });

  it.each(["SESSION_LOST", "AUTH_UNKNOWN", "MANUAL_CHALLENGE", "OTP_REQUIRED", "AUTH_FAILED"] as const)(
    "does not send KCEX financial events while auth state is %s",
    async (status) => {
      const service = new FuturesReadService({
        adapter: { readSnapshot: async () => ({ status: "READY", snapshot: kcexSnapshot() }) },
        events: new EventBus(),
        logger: { info: () => undefined } as never,
        authStatus: () => "AUTHENTICATED",
        enabled: true,
        pollMs: 5000,
      });
      await service.pollOnce();

      const received = await readInitialEvents(await startServer(authState(status), service));
      const financialTypes = new Set([
        "futures.snapshot",
        "market.snapshot",
        "account.balance",
        "futures.contract",
        "position.changed",
        "orders.snapshot",
      ]);
      expect(received.some((event) => financialTypes.has(event.type))).toBe(false);
      expect(received.some((event) => event.type === "futures.read-health")).toBe(true);
    },
  );

  it("sends reader health without financial data when the first KCEX read fails", async () => {
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: "UNKNOWN" as const, reason: "fixture has no trusted evidence" }) },
      events: new EventBus(),
      logger: { info: () => undefined } as never,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5000,
    });
    await service.pollOnce();
    await service.pollOnce();

    const received = await readInitialEvents(await startServer(authState("AUTHENTICATED"), service));
    const health = received.find((event) => event.type === "futures.read-health");
    expect(health?.type).toBe("futures.read-health");
    if (health?.type === "futures.read-health") {
      expect(health.payload.source).toBe("KCEX");
      expect(health.payload.status).toBe("UNKNOWN");
      expect(health.payload.health).toBe("UNKNOWN");
      expect(health.payload.consecutiveReadFailures).toBe(2);
    }
    expect(received.some((event) => [
      "futures.snapshot",
      "market.snapshot",
      "account.balance",
      "futures.contract",
      "position.changed",
      "orders.snapshot",
    ].includes(event.type))).toBe(false);
  });

  it("preserves financial updatedAt and stales cached data after a terminal read", async () => {
    const updatedAt = "2026-01-01T00:00:00.000Z";
    let readCount = 0;
    const service = new FuturesReadService({
      adapter: {
        readSnapshot: async () => {
          readCount += 1;
          return readCount === 1
            ? { status: "READY" as const, snapshot: { ...kcexSnapshot(), updatedAt } }
            : { status: "SESSION_LOST" as const };
        },
      },
      events: new EventBus(),
      logger: { info: () => undefined } as never,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5000,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
    });
    await service.pollOnce();
    await service.pollOnce();

    const url = await startServer(authState("AUTHENTICATED"), service);
    const dashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as {
      status: { browser: string; readHealth: string };
      futures: { updatedAt: string; freshness: string };
    };
    expect(dashboard.status.browser).toBe("STOPPED");
    expect(dashboard.status.readHealth).toBe("UNKNOWN");
    expect(dashboard.futures.updatedAt).toBe(updatedAt);
    expect(dashboard.futures.freshness).toBe("STALE");
  });

  it("keeps FAKE fixture mode explicit", async () => {
    const url = await startServer(authState("VAULT_UNLOCKED", "FAKE"));
    const response = await fetch(`${url}/api/v1/futures/snapshot`);
    expect(response.status).toBe(200);
    expect((await response.json()).source).toBe("MOCK");
  });

  it("does not send mock financial events before the first KCEX read", async () => {
    const url = await startServer(authState("AUTHENTICATED"));
    const received = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/api/v1/events", { headers: { origin: url } });
      const eventsSeen: ReturnType<typeof parseDashboardEvent>[] = [];
      socket.once("error", reject);
      socket.on("message", (message) => {
        eventsSeen.push(parseDashboardEvent(JSON.parse(message.toString())));
        if (eventsSeen.length === 4) {
          socket.close();
          resolve(eventsSeen);
        }
      });
    });
    expect(received.map((event) => event.type)).toEqual([
      "auth.state", "scheduler.plan", "system.log", "system.heartbeat",
    ]);
    expect(received.some((event) => ["market.snapshot", "account.balance", "futures.contract", "position.changed", "orders.snapshot", "futures.read-health"].includes(event.type))).toBe(false);
  });

  it("keeps the dashboard placeholder explicit while KCEX has no first read", async () => {
    const url = await startServer(authState("AUTHENTICATED"));
    const snapshot = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as { futures: { source: string; health: string }; logs: Array<{ message: string }> };
    expect(snapshot.futures.source).toBe("MOCK");
    expect(snapshot.futures.health).toBe("UNKNOWN");
    expect(snapshot.logs.some((entry) => entry.message.includes("Waiting for the first authenticated KCEX read-only snapshot"))).toBe(true);
  });
});
