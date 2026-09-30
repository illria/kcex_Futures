import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { createAuthFixture } from "../task002/helpers.js";
import { createTask010Setup } from "./helpers.js";
import { ProtectionPreviewResponseSchema, ProtectionRuntimeStateSchema } from "../../packages/shared/src/protection.js";
import { parseDashboardEvent } from "../../packages/shared/src/protocol.js";

describe("TASK-010 protection API and initial WebSocket state", () => {
  const servers: Array<ReturnType<typeof createDashboardServer>> = [];
  const taskSetups: Array<Awaited<ReturnType<typeof createTask010Setup>>> = [];
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    for (const setup of taskSetups.splice(0)) await setup.cleanup();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function start() {
    const setup = await createTask010Setup();
    taskSetups.push(setup);
    const authFixture = await createAuthFixture();
    cleanups.push(authFixture.cleanup);
    const server = createDashboardServer({
      auth: authFixture.auth,
      vault: authFixture.vault,
      events: setup.events,
      storage: setup.storage,
      execution: setup.service,
      protection: setup.protection,
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const url = "http://127.0.0.1:" + address.port;
    const post = (path: string, body: unknown, origin = url) => fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    });
    return { ...setup, url, post };
  }

  it("serves runtime state and requires same-origin, strict request bodies", async () => {
    const { url, post, attemptId } = await start();
    expect(ProtectionRuntimeStateSchema.parse(await (await fetch(url + "/api/v1/protection/state")).json()).status).toBe("NONE");
    const intent = {
      executionAttemptId: attemptId,
      takeProfit: { basis: "PRICE_PCT", value: 5 },
      stopLoss: { basis: "PRICE_PCT", value: 5 },
    };
    expect((await post("/api/v1/protection/preview", intent, "")).status).toBe(403);
    expect((await post("/api/v1/protection/preview", intent, "https://evil.example.invalid")).status).toBe(403);
    expect((await post("/api/v1/protection/preview", { ...intent, side: "SHORT" })).status).toBe(400);
    expect((await post("/api/v1/protection/preview", { ...intent, takeProfit: { basis: "PRICE_PCT", value: 0 } })).status).toBe(400);
  });

  it("returns an immutable preview, accepts only the one-time confirm body, and emits typed fixture state", async () => {
    const { url, post, attemptId } = await start();
    const previewResponse = await post("/api/v1/protection/preview", {
      executionAttemptId: attemptId,
      takeProfit: { basis: "ROI_PCT", value: 30 },
      stopLoss: { basis: "ROI_PCT", value: 30 },
    });
    const prepared = ProtectionPreviewResponseSchema.parse(await previewResponse.json());
    expect(prepared.preview.takeProfit.targetPrice).toBe(103);
    expect(prepared.preview.stopLoss.targetPrice).toBe(97);

    expect((await post("/api/v1/protection/confirm", {
      previewId: prepared.preview.previewId,
      confirmationToken: prepared.confirmationToken,
      takeProfit: { basis: "ROI_PCT", value: 500 },
    })).status).toBe(400);

    const socketEvent = await new Promise<ReturnType<typeof parseDashboardEvent>>((resolve, reject) => {
      const socket = new WebSocket(url.replace(/^http:/, "ws:") + "/api/v1/events", { headers: { origin: url } });
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          if (event.type === "protection.state") {
            socket.close();
            resolve(event);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
    expect(socketEvent.type).toBe("protection.state");
    if (socketEvent.type === "protection.state") expect(socketEvent.payload.status).toBe("PREVIEW_READY");

    const confirmed = await post("/api/v1/protection/confirm", {
      previewId: prepared.preview.previewId,
      confirmationToken: prepared.confirmationToken,
    });
    expect(ProtectionRuntimeStateSchema.parse(await confirmed.json()).status).toBe("ACTIVE");
    expect((await fetch(url + "/api/v1/protection/state")).status).toBe(200);
  });

  it.each([
    "/api/v1/protection/retry",
    "/api/v1/protection/force-active",
    "/api/v1/protection/clear",
    "/api/v1/protection/mark",
    "/api/v1/kcex/tp",
    "/api/v1/kcex/sl",
    "/api/v1/kcex/close",
  ])("does not expose dangerous route %s", async (path) => {
    const { post } = await start();
    expect((await post(path, {})).status).toBe(404);
  });
});
