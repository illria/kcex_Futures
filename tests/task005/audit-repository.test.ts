import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./storage-test-helpers.js";

describe("AuditRepository sensitive payload guard", () => {
  const opened: Array<Awaited<ReturnType<typeof createMemoryStorage>>> = [];

  afterEach(() => {
    for (const storage of opened.splice(0)) storage.close();
  });

  async function createStorage() {
    const storage = await createMemoryStorage(() => new Date("2026-09-25T12:34:56.789Z"));
    opened.push(storage);
    return storage;
  }

  it.each([
    { password: "secret" },
    { nested: { token: "secret" } },
    { Authorization: "Bearer hidden" },
    { values: [{ storageState: "private" }] },
    { account: "fixture@example.test" },
  ])("rejects sensitive payload keys recursively: %j", async (payload) => {
    const storage = await createStorage();
    expect(() => storage.auditEvents.appendAuditEvent({
      category: "SYSTEM",
      eventType: "FIXTURE_EVENT",
      severity: "WARN",
      message: "Safe fixture message.",
      payload,
    })).toThrow();
  });

  it("accepts safe structured metadata and validates it again when read", async () => {
    const storage = await createStorage();
    const event = storage.auditEvents.appendAuditEvent({
      category: "TRADING",
      eventType: "TRADE_RECORDED",
      severity: "INFO",
      message: "A validated lifecycle record was stored.",
      payload: { symbol: "GPS_USDT", mode: "PAPER", side: "LONG", status: "PLANNED", metadata: { attempt: 1 } },
    });
    expect(event.payload).toEqual({
      symbol: "GPS_USDT",
      mode: "PAPER",
      side: "LONG",
      status: "PLANNED",
      metadata: { attempt: 1 },
    });
    expect(storage.auditEvents.listAuditEvents()).toEqual([event]);
    expect(() => storage.auditEvents.listAuditEvents({ limit: 101 })).toThrow(RangeError);
  });
});
