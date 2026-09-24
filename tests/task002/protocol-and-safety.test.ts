import { describe, expect, it } from "vitest";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, type DashboardEvent } from "../../packages/shared/src/protocol.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { getDashboardBindAddress, getDashboardPort } from "../../apps/server/src/api/http-server.js";
import { SECRET_REDACTION_PATHS, createAppLogger } from "../../src/logging/logger.js";
import { loadConfig } from "../../src/config/schema.js";

const timestamp = "2026-09-23T00:00:00.000Z";

describe("shared WebSocket event schemas", () => {
  it("accepts every required event type and rejects malformed payloads", () => {
    const snapshot = createFakeDashboardSnapshot();
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      credentialsSaved: true,
      liveTrading: false,
      authProvider: "FAKE",
      updatedAt: timestamp,
    });
    const bus = new EventBus();
    const events: DashboardEvent[] = [
      { version: 1, type: "auth.state", timestamp, payload: auth },
      { version: 1, type: "market.snapshot", timestamp, payload: snapshot.market },
      { version: 1, type: "account.balance", timestamp, payload: { asset: "USDT", available: 1000, source: "MOCK" } },
      { version: 1, type: "position.changed", timestamp, payload: snapshot.position },
      { version: 1, type: "scheduler.plan", timestamp, payload: snapshot.scheduler },
      { version: 1, type: "system.log", timestamp, payload: snapshot.logs[0] },
      { version: 1, type: "system.heartbeat", timestamp, payload: { status: "OK", liveTrading: false, uptimeSeconds: 0 } },
    ];

    expect(events.map((event) => bus.publish(event).type)).toEqual([
      "auth.state",
      "market.snapshot",
      "account.balance",
      "position.changed",
      "scheduler.plan",
      "system.log",
      "system.heartbeat",
    ]);
    expect(() => bus.publish({
      version: 1,
      type: "market.snapshot",
      timestamp,
      payload: { ...snapshot.market, symbol: "BTC_USDT" },
    })).toThrow();
  });
});

describe("logger redaction", () => {
  it("redacts secrets at nested request, header, and storage paths", () => {
    let output = "";
    const logger = createAppLogger({
      write(chunk: string) {
        output += chunk;
      },
    });
    const secrets = [
      "password-value-task002",
      "master-key-value-task002",
      "secret-value-task002",
      "otp-value-task002",
      "verification-code-task002",
      "cookie-value-task002",
      "authorization-value-task002",
      "token-value-task002",
      "access-token-value-task002",
      "refresh-token-value-task002",
      "session-value-task002",
      "session-id-value-task002",
      "storage-state-value-task002",
      "storage-state-snake-value-task002",
    ];

    logger.info({
      password: secrets[0],
      credentials: { masterKey: secrets[1], nested: { secret: secrets[2] } },
      request: { body: { otp: secrets[3], verificationCode: secrets[4] } },
      headers: { cookie: secrets[5], authorization: secrets[6] },
      context: {
        token: secrets[7],
        accessToken: secrets[8],
        refreshToken: secrets[9],
        session: secrets[10],
        sessionId: secrets[11],
        browser: { storageState: secrets[12], storage_state: secrets[13] },
      },
    }, "Redaction fixture");

    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
    for (const field of [
      "password",
      "masterKey",
      "secret",
      "otp",
      "verificationCode",
      "cookie",
      "authorization",
      "token",
      "accessToken",
      "refreshToken",
      "session",
      "sessionId",
      "storageState",
      "storage_state",
    ]) {
      expect(SECRET_REDACTION_PATHS).toContain(field);
    }
  });
});

describe("local dashboard safety defaults", () => {
  it("always binds to IPv4 loopback and defaults to port 6666", () => {
    expect(getDashboardBindAddress()).toBe("127.0.0.1");
    expect(getDashboardPort({})).toBe(6666);
    expect(getDashboardPort({ DASHBOARD_PORT: "7000" })).toBe(7000);
    expect(() => getDashboardPort({ DASHBOARD_PORT: "70000" })).toThrow();
  });

  it("keeps LIVE_TRADING false even when the environment asks to enable it", () => {
    const config = loadConfig({ LIVE_TRADING: "true" }, () => undefined);
    expect(config.LIVE_TRADING).toBe(false);
    expect(createFakeDashboardSnapshot().liveTrading).toBe(false);
  });
});
