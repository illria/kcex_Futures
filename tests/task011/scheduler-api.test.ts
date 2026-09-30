import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { createSchedulerSetup } from "./helpers.js";
import { createAuthFixture } from "../task002/helpers.js";
import { DashboardSnapshotSchema, parseDashboardEvent } from "../../packages/shared/src/protocol.js";
import { SchedulerStateSchema } from "../../packages/shared/src/scheduler.js";

describe("TASK-011 read-only scheduler API and WebSocket", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const cleanups: Array<() => Promise<void>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start() {
    const authFixture = await createAuthFixture();
    cleanups.push(authFixture.cleanup);
    const schedulerSetup = await createSchedulerSetup({ startAt: "2026-10-01T00:01:00.000Z" });
    cleanups.push(schedulerSetup.cleanup);
    await schedulerSetup.scheduler.recover();
    const server = createDashboardServer({
      auth: authFixture.auth,
      vault: authFixture.vault,
      events: schedulerSetup.events,
      storage: schedulerSetup.storage,
      scheduler: schedulerSetup.scheduler,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }

  it("serves the real local state through GET and the dashboard snapshot", async () => {
    const { url } = await start();
    const state = SchedulerStateSchema.parse(await (await fetch(`${url}/api/v1/scheduler/state`)).json());
    expect(state).toMatchObject({ source: "LOCAL", status: "READY", timezone: "UTC", autoSubmit: false });
    const dashboard = DashboardSnapshotSchema.parse(await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json());
    expect(dashboard.scheduler).toEqual(state);
    expect(dashboard.liveTrading).toBe(false);
  });

  it.each([
    "/api/v1/scheduler/run",
    "/api/v1/scheduler/regenerate",
    "/api/v1/scheduler/execute",
    "/api/v1/scheduler/skip",
    "/api/v1/scheduler/force-due",
  ])
  ("does not expose a scheduler write route at %s", async (path) => {
    const { url } = await start();
    expect((await fetch(`${url}${path}`, { method: "POST" })).status).toBe(404);
  });

  it("sends the current local scheduler state to each WebSocket connection", async () => {
    const { url } = await start();
    const events = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/api/v1/events", { headers: { origin: url } });
      sockets.push(socket);
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
    const schedulerEvent = events.find((event) => event.type === "scheduler.plan");
    expect(schedulerEvent?.type).toBe("scheduler.plan");
    if (schedulerEvent?.type === "scheduler.plan") {
      expect(schedulerEvent.payload).toMatchObject({ source: "LOCAL", status: "READY", autoSubmit: false });
    }
  });
});
