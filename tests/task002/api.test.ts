import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_OTP_CODE } from "../../packages/shared/src/fake-auth.js";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { parseDashboardEvent } from "../../packages/shared/src/protocol.js";
import { createAuthFixture, TEST_ACCOUNT, TEST_MASTER_KEY, TEST_PASSWORD } from "./helpers.js";

describe("local credential and fake auth API", () => {
  let fixture: Awaited<ReturnType<typeof createAuthFixture>>;
  let server: ReturnType<typeof createDashboardServer>;
  let baseUrl: string;

  beforeEach(async () => {
    fixture = await createAuthFixture();
    server = createDashboardServer({ auth: fixture.auth, vault: fixture.vault, events: fixture.events });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    });
    await fixture.cleanup();
  });

  it("never returns saved credentials and completes the FakeAuth OTP flow", async () => {
    const unlockResponse = await fetch(`${baseUrl}/api/v1/vault/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ masterKey: TEST_MASTER_KEY }),
    });
    expect(unlockResponse.status).toBe(200);
    const unlockText = await unlockResponse.text();
    expect(unlockText).not.toContain(TEST_MASTER_KEY);

    const saveResponse = await fetch(`${baseUrl}/api/v1/vault/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: TEST_ACCOUNT, password: TEST_PASSWORD, save: true }),
    });
    expect(saveResponse.status).toBe(200);
    const saveText = await saveResponse.text();
    expect(JSON.parse(saveText)).toEqual({ ok: true, credentialsSaved: true });
    expect(saveText).not.toContain(TEST_PASSWORD);

    const stateText = await (await fetch(`${baseUrl}/api/v1/auth/state`)).text();
    const snapshotText = await (await fetch(`${baseUrl}/api/v1/dashboard/snapshot`)).text();
    const credentialsRead = await fetch(`${baseUrl}/api/v1/vault/credentials`);
    expect(credentialsRead.status).toBe(404);
    expect(`${stateText}${snapshotText}`).not.toContain(TEST_PASSWORD);

    const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const loginText = await loginResponse.text();
    expect(JSON.parse(loginText).status).toBe("OTP_REQUIRED");
    expect(loginText).not.toContain(TEST_PASSWORD);

    const otpResponse = await fetch(`${baseUrl}/api/v1/auth/otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: FAKE_OTP_CODE }),
    });
    const otpText = await otpResponse.text();
    expect(JSON.parse(otpText)).toMatchObject({ status: "AUTHENTICATED", liveTrading: false });
    expect(otpText).not.toContain(FAKE_OTP_CODE);

    const persisted = await readFile(fixture.filePath, "utf8");
    expect(persisted).not.toContain(TEST_MASTER_KEY);
    expect(persisted).not.toContain(TEST_ACCOUNT);
    expect(persisted).not.toContain(TEST_PASSWORD);
    expect(persisted).not.toContain(FAKE_OTP_CODE);
  });

  it("rejects non-loopback Host headers before API processing", async () => {
    const response = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/api/v1/auth/state`, {
        headers: { host: "attacker.example" },
      }, (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
      });
      request.once("error", reject);
      request.end();
    });
    expect(response).toBe(403);
  });

  it("returns to APP_LOCKED after a failed re-unlock attempt", async () => {
    await fetch(`${baseUrl}/api/v1/vault/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ masterKey: TEST_MASTER_KEY }),
    });
    await fetch(`${baseUrl}/api/v1/vault/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: TEST_ACCOUNT, password: TEST_PASSWORD, save: true }),
    });
    const invalidUnlock = await fetch(`${baseUrl}/api/v1/vault/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ masterKey: "wrong-master-key" }),
    });

    expect(invalidUnlock.status).toBe(401);
    expect(await (await fetch(`${baseUrl}/api/v1/auth/state`)).json()).toMatchObject({
      status: "APP_LOCKED",
      credentialsSaved: false,
      liveTrading: false,
    });
  });

  it("streams all initial dashboard event types over the read-only WebSocket", async () => {
    const wsUrl = baseUrl.replace(/^http:/, "ws:") + "/api/v1/events";
    const eventTypes = await new Promise<string[]>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, { headers: { origin: baseUrl } });
      const seen = new Set<string>();
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          const event = parseDashboardEvent(JSON.parse(message.toString()));
          seen.add(event.type);
          if (seen.size === 7) {
            socket.close();
            resolve([...seen].sort());
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });

    expect(eventTypes).toEqual([
      "account.balance",
      "auth.state",
      "market.snapshot",
      "position.changed",
      "scheduler.plan",
      "system.heartbeat",
      "system.log",
    ]);
  });

  it("deletes encrypted credentials without returning their contents", async () => {
    await fetch(`${baseUrl}/api/v1/vault/unlock`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ masterKey: TEST_MASTER_KEY }),
    });
    await fetch(`${baseUrl}/api/v1/vault/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: TEST_ACCOUNT, password: TEST_PASSWORD, save: true }),
    });
    const deleted = await fetch(`${baseUrl}/api/v1/vault/credentials`, { method: "DELETE" });

    expect(await deleted.json()).toEqual({ ok: true, credentialsSaved: false });
    expect(fixture.vault.hasCredentials).toBe(false);
    await expect(readFile(fixture.filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
