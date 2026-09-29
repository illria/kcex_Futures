import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { parseDashboardEvent } from "../../packages/shared/src/protocol.js";
import { AssistedExecutionStateSchema, ExecutionPreviewResponseSchema } from "../../packages/shared/src/execution.js";
import { createAuthFixture } from "../task002/helpers.js";
import { createTask008Setup } from "./helpers.js";

describe("TASK-008 loopback assisted-execution API", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const setups: Awaited<ReturnType<typeof createTask008Setup>>[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const setup of setups.splice(0)) await setup.cleanup();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start() {
    const setup = await createTask008Setup();
    setups.push(setup);
    const authFixture = await createAuthFixture();
    cleanups.push(authFixture.cleanup);
    const server = createDashboardServer({
      auth: authFixture.auth,
      vault: authFixture.vault,
      events: setup.events,
      storage: setup.storage,
      risk: setup.risk,
      execution: setup.service,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, origin = url) => fetch(`${url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
    return { url, origin: url, post, ...setup };
  }

  it("exposes validated runtime state, protects writes with same-origin, and rejects extra body fields", async () => {
    const { url, origin, post } = await start();
    const initial = AssistedExecutionStateSchema.parse(await (await fetch(`${url}/api/v1/live/state`)).json());
    expect(initial).toMatchObject({ status: "DISARMED", provider: "FIXTURE", armedUntil: null, activePreview: null });

    const noOrigin = await post("/api/v1/live/arm", { acknowledgement: "ARM ASSISTED LIVE EXECUTION" }, "");
    expect(noOrigin.status).toBe(403);
    const foreignOrigin = await post("/api/v1/live/arm", { acknowledgement: "ARM ASSISTED LIVE EXECUTION" }, "https://evil.example.invalid");
    expect(foreignOrigin.status).toBe(403);
    const extraField = await post("/api/v1/live/arm", {
      acknowledgement: "ARM ASSISTED LIVE EXECUTION",
      bypassConfirmation: true,
    });
    expect(extraField.status).toBe(400);
    expect(origin).toBe(url);
  });

  it("supports a single fixture flow, Dashboard state, and authoritative WebSocket initial state", async () => {
    const { url, post, service, adapter } = await start();
    const armResponse = await post("/api/v1/live/arm", { acknowledgement: "ARM ASSISTED LIVE EXECUTION" });
    expect(AssistedExecutionStateSchema.parse(await armResponse.json()).status).toBe("ARMED");

    const previewResponse = await post("/api/v1/live/preview", { side: "LONG", marginUsdt: 50, leverage: 10 });
    const prepared = ExecutionPreviewResponseSchema.parse(await previewResponse.json());
    expect(prepared.preview.symbol).toBe("GPS_USDT");
    expect(prepared.preview.provider).toBe("FIXTURE");

    const wsState = await new Promise<ReturnType<typeof parseDashboardEvent>>((resolve, reject) => {
      const socket = new WebSocket(`${url.replace(/^http:/, "ws:")}/api/v1/events`, { headers: { origin: url } });
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          if (event.type === "execution.state") {
            socket.close();
            resolve(event);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
    expect(wsState.type).toBe("execution.state");
    if (wsState.type === "execution.state") expect(wsState.payload).toEqual(service.getState());

    const confirmResponse = await post("/api/v1/live/confirm", {
      previewId: prepared.preview.previewId,
      confirmationToken: prepared.confirmationToken,
    });
    expect(AssistedExecutionStateSchema.parse(await confirmResponse.json())).toMatchObject({
      status: "SUBMITTED",
      armedUntil: null,
      activePreview: null,
      lastSubmission: { status: "SUBMITTED", provider: "FIXTURE" },
    });
    expect(adapter.submitCalls).toBe(1);

    const dashboard = await (await fetch(`${url}/api/v1/dashboard/snapshot`)).json() as { execution: unknown };
    expect(AssistedExecutionStateSchema.parse(dashboard.execution).status).toBe("SUBMITTED");
    for (const path of ["/api/v1/kcex/order", "/api/v1/kcex/submit", "/api/v1/kcex/cancel"]) {
      expect((await post(path, {})).status).toBe(404);
    }
    expect(adapter.submitCalls).toBe(1);
  });

  it("allows manual disarm without an acknowledgement or a route that can arm", async () => {
    const { url, post } = await start();
    await post("/api/v1/live/arm", { acknowledgement: "ARM ASSISTED LIVE EXECUTION" });
    const disarm = await post("/api/v1/live/disarm", {});
    expect(AssistedExecutionStateSchema.parse(await disarm.json())).toMatchObject({
      status: "DISARMED",
      armedUntil: null,
      activePreview: null,
    });
    expect((await fetch(`${url}/api/v1/live/arm`)).status).toBe(404);
  });
});
