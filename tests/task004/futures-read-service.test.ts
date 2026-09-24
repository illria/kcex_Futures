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
    expect(seen).toEqual(expect.arrayContaining(["market.snapshot", "account.balance", "futures.contract", "position.changed", "orders.snapshot", "futures.read-health"]));
  });
});
