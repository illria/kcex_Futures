import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "./storage-test-helpers.js";

describe("DailyPlanRepository", () => {
  const opened: Array<Awaited<ReturnType<typeof createMemoryStorage>>> = [];

  afterEach(() => {
    for (const storage of opened.splice(0)) storage.close();
  });

  async function createStorage() {
    const storage = await createMemoryStorage(() => new Date("2026-09-25T12:34:56.789Z"));
    opened.push(storage);
    return storage;
  }

  it("upserts and lists validated daily plans", async () => {
    const storage = await createStorage();
    const plan = storage.dailyPlans.upsertDailyPlan({
      dateKey: "2026-09-25",
      symbol: "GPS_USDT",
      dailyTarget: 4,
      completed: 1,
      marginUsdt: 50,
      leverage: 10,
    });
    expect(storage.dailyPlans.getDailyPlan(plan.dateKey)).toEqual(plan);
    expect(storage.dailyPlans.listDailyPlans()).toEqual([plan]);

    const updated = storage.dailyPlans.upsertDailyPlan({ ...plan, dailyTarget: 5, completed: 2 });
    expect(updated.createdAt).toBe(plan.createdAt);
    expect(updated.dailyTarget).toBe(5);
    expect(updated.completed).toBe(2);
    expect(() => storage.dailyPlans.listDailyPlans({ limit: 101 })).toThrow(RangeError);
  });

  it("rejects invalid target, completion count, date, and numeric settings", async () => {
    const storage = await createStorage();
    const base = {
      dateKey: "2026-09-25",
      symbol: "GPS_USDT" as const,
      dailyTarget: 4,
      completed: 0,
      marginUsdt: 50,
      leverage: 10,
    };
    expect(() => storage.dailyPlans.upsertDailyPlan({ ...base, dailyTarget: 11 })).toThrow();
    expect(() => storage.dailyPlans.upsertDailyPlan({ ...base, completed: 5 })).toThrow();
    expect(() => storage.dailyPlans.upsertDailyPlan({ ...base, dateKey: "2026-02-30" })).toThrow();
    expect(() => storage.dailyPlans.upsertDailyPlan({ ...base, leverage: Number.POSITIVE_INFINITY })).toThrow();
  });
});
