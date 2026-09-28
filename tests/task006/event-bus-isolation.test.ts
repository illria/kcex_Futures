import { describe, expect, it } from "vitest";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";

const timestamp = "2026-09-26T12:00:00.000Z";

describe("EventBus observer isolation", () => {
  it("continues to later subscribers after one listener throws", () => {
    const events = new EventBus();
    const received: string[] = [];
    events.subscribe(() => {
      throw new Error("fixture subscriber failure");
    });
    events.subscribe((event) => received.push(event.type));

    expect(() => events.publish({
      version: 1,
      type: "system.heartbeat",
      timestamp,
      payload: { status: "OK", liveTrading: false, uptimeSeconds: 0 },
    })).not.toThrow();
    expect(received).toEqual(["system.heartbeat"]);
  });

  it("still rejects an event that fails shared schema validation", () => {
    const events = new EventBus();
    const received: string[] = [];
    events.subscribe((event) => received.push(event.type));

    expect(() => events.publish({
      version: 1,
      type: "not-a-dashboard-event",
      timestamp,
      payload: {},
    })).toThrow();
    expect(received).toEqual([]);
  });
});
