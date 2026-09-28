import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { KillSwitchService } from "../../apps/server/src/risk/kill-switch.js";
import { RiskService } from "../../apps/server/src/risk/risk-service.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { parseDashboardEvent } from "../../packages/shared/src/protocol.js";
import { RiskStateSchema } from "../../packages/shared/src/risk.js";
import { createAuthFixture } from "../task002/helpers.js";

const NOW = "2026-09-29T12:00:00.000Z";

describe("read-only Risk API and WebSocket state", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const storages: StorageService[] = [];
  const directories: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const storage of storages.splice(0)) storage.close();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start() {
    const storage = new StorageService({ databaseFile: ":memory:", now: () => new Date(NOW) });
    await storage.initialize();
    storages.push(storage);
    const directory = await mkdtemp(join(tmpdir(), "task007-risk-api-"));
    directories.push(directory);
    const events = new EventBus();
    const risk = new RiskService({
      storage,
      events,
      killSwitch: new KillSwitchService(join(directory, "KILL_SWITCH")),
      now: () => new Date(NOW),
    });
    await risk.initialize();
    const authFixture = await createAuthFixture();
    cleanups.push(authFixture.cleanup);
    const server = createDashboardServer({
      auth: authFixture.auth,
      vault: authFixture.vault,
      events,
      storage,
      risk,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}`, directory, risk };
  }

  it("returns refreshed validated risk state and has no risk mutation routes", async () => {
    const { url, directory } = await start();
    const stateResponse = await fetch(`${url}/api/v1/risk/state`);
    expect(stateResponse.status).toBe(200);
    expect(RiskStateSchema.parse(await stateResponse.json())).toMatchObject({
      status: "READY",
      killSwitch: "CLEAR",
      limits: { maxMarginUsdt: 50, maxLeverage: 10 },
    });
    const dashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as {
      status: { killSwitch: string };
      risk: unknown;
    };
    expect(RiskStateSchema.parse(dashboard.risk).status).toBe("READY");
    expect(dashboard.status.killSwitch).toBe("CLEAR");

    await writeFile(join(directory, "KILL_SWITCH"), "ignored", { mode: 0o600 });
    expect(RiskStateSchema.parse(await (await fetch(`${url}/api/v1/risk/state`)).json()).status).toBe("HALTED");
    for (const path of ["/api/v1/risk/state", "/api/v1/risk/kill", "/api/v1/kill-switch"]) {
      expect((await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    }
    expect((await fetch(`${url}/api/v1/risk/kill`, { method: "DELETE" })).status).toBe(404);
  });

  it("sends authoritative risk.state to every new WebSocket connection", async () => {
    const { url, risk } = await start();
    const expectedState = risk.getState();
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
    const riskEvent = events.find((event) => event.type === "risk.state");
    expect(riskEvent?.type).toBe("risk.state");
    if (riskEvent?.type === "risk.state") expect(riskEvent.payload).toEqual(expectedState);
  });

  it("streams risk.blocked and then the latest authoritative risk.state", async () => {
    const { url, risk } = await start();
    const events = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/api/v1/events", { headers: { origin: url } });
      const seen: ReturnType<typeof parseDashboardEvent>[] = [];
      let blockedSeen = false;
      socket.once("error", reject);
      socket.on("open", () => {
        void risk.evaluatePreTrade({
          mode: "PAPER", symbol: "ETH_USDT", side: "LONG", marginUsdt: 50, leverage: 10,
        }).catch(reject);
      });
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          seen.push(event);
          if (event.type === "risk.blocked") blockedSeen = true;
          else if (blockedSeen && event.type === "risk.state") {
            socket.close();
            resolve(seen);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
    const blockedIndex = events.findIndex((event) => event.type === "risk.blocked");
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(blockedIndex + 1).some((event) => event.type === "risk.state")).toBe(true);
  });
});
