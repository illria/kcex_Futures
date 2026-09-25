import type { Logger } from "pino";
import { describe, expect, it } from "vitest";
import { createFakeFuturesSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { FuturesReadService, normalizePollInterval } from "../../apps/server/src/futures/futures-read-service.js";

const silentLogger = { info: () => undefined } as unknown as Logger;

describe("FuturesReadService", () => {
  it("clamps polling to the safe bounds and requires authenticated state", async () => {
    expect(normalizePollInterval(1)).toBe(2000);
    expect(normalizePollInterval(100000)).toBe(60000);
    let auth: "AUTHENTICATED" | "SESSION_LOST" = "SESSION_LOST";
    let calls = 0;
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => { calls += 1; return { status: "READY", snapshot: createFakeFuturesSnapshot() }; } },
      events: new EventBus(), logger: silentLogger, authStatus: () => auth,
      enabled: true, pollMs: 5000,
    });
    expect(await service.pollOnce()).toBeNull();
    expect(calls).toBe(0);
    auth = "AUTHENTICATED";
    await service.pollOnce();
    expect(calls).toBe(1);
  });

  it("prevents concurrent reads and publishes the shared event schema", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const events = new EventBus();
    const seen: string[] = [];
    events.subscribe((event) => seen.push(event.type));
    const service = new FuturesReadService({
      adapter: {
        readSnapshot: () => {
          calls += 1;
          return new Promise((resolve) => { release = () => resolve({ status: "READY", snapshot: createFakeFuturesSnapshot() }); });
        },
      },
      events, logger: silentLogger, authStatus: () => "AUTHENTICATED", enabled: true, pollMs: 5000,
    });
    const first = service.pollOnce();
    expect(await service.pollOnce()).toBeNull();
    expect(calls).toBe(1);
    release?.();
    await first;
    expect(seen).toEqual(expect.arrayContaining(["futures.snapshot", "market.snapshot", "account.balance", "futures.contract", "position.changed", "orders.snapshot", "futures.read-health"]));
  });

  it("reports browser runtime state and stales cached data after a stop", async () => {
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: "READY", snapshot: createFakeFuturesSnapshot(timestamp.toISOString()) }) },
      events: new EventBus(), logger: silentLogger, authStatus: () => "AUTHENTICATED", enabled: true, pollMs: 5000,
      now: () => timestamp,
    });
    expect(service.getBrowserStatus()).toBe("AUTHENTICATED");
    await service.pollOnce();
    expect(service.getBrowserStatus()).toBe("READING");
    expect(service.getLatestSnapshot(timestamp)?.freshness).toBe("FRESH");
    service.stop();
    expect(service.getBrowserStatus()).toBe("STOPPED");
    expect(service.getLatestSnapshot(timestamp)?.freshness).toBe("STALE");
  });

  it("stales the last snapshot when authentication is lost", async () => {
    let auth: "AUTHENTICATED" | "SESSION_LOST" = "AUTHENTICATED";
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: "READY", snapshot: createFakeFuturesSnapshot() }) },
      events: new EventBus(), logger: silentLogger, authStatus: () => auth, enabled: true, pollMs: 5000,
    });
    await service.pollOnce();
    auth = "SESSION_LOST";
    await service.pollOnce();
    expect(service.getBrowserStatus()).toBe("STOPPED");
    expect(service.getLatestSnapshot()?.freshness).toBe("STALE");
  });

  it("maps partial reads to DEGRADED and terminal reads to STOPPED", async () => {
    let result: "PARTIAL" | "UNKNOWN" = "PARTIAL";
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: result, snapshot: result === "PARTIAL" ? createFakeFuturesSnapshot() : undefined }) },
      events: new EventBus(), logger: silentLogger, authStatus: () => "AUTHENTICATED", enabled: true, pollMs: 5000,
    });
    await service.pollOnce();
    expect(service.getBrowserStatus()).toBe("DEGRADED");
    result = "UNKNOWN";
    await service.pollOnce();
    expect(service.getBrowserStatus()).toBe("DEGRADED");
  });

  it("keeps reader health and failure count across reconnect state", async () => {
    let readCount = 0;
    const readTimestamp = new Date("2026-01-01T00:00:00.000Z");
    const events = new EventBus();
    const service = new FuturesReadService({
      adapter: {
        readSnapshot: async () => {
          readCount += 1;
          return readCount === 1
            ? { status: "READY" as const, snapshot: createFakeFuturesSnapshot(readTimestamp.toISOString()) }
            : { status: "UNKNOWN" as const, reason: "fixture evidence unavailable" };
        },
      },
      events,
      logger: silentLogger,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5000,
      now: () => readTimestamp,
    });

    await service.pollOnce();
    const originalUpdatedAt = service.getLatestSnapshot(readTimestamp)?.updatedAt;
    await service.pollOnce();
    await service.pollOnce();

    expect(service.getReadState()).toEqual({
      status: "UNKNOWN",
      health: "UNKNOWN",
      browserStatus: "DEGRADED",
      consecutiveReadFailures: 2,
      updatedAt: readTimestamp.toISOString(),
    });
    expect(service.getLatestSnapshot(readTimestamp)?.updatedAt).toBe(originalUpdatedAt);
    expect(service.getLatestSnapshot(readTimestamp)?.freshness).toBe("STALE");
  });

  it.each(["SESSION_LOST", "SYMBOL_MISMATCH", "MANUAL_CHALLENGE"] as const)("stops polling on %s", async (terminalStatus) => {
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: terminalStatus }) },
      events: new EventBus(), logger: silentLogger, authStatus: () => "AUTHENTICATED", enabled: true, pollMs: 5000,
    });
    service.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.getBrowserStatus()).toBe("STOPPED");
  });
});
