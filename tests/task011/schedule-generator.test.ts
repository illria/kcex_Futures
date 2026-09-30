import { describe, expect, it } from "vitest";
import { generateDailySchedule } from "../../apps/server/src/scheduler/schedule-generator.js";
import { fixedRandomSource, uuidSequence } from "./helpers.js";

const CREATED_AT = "2026-10-01T12:00:00.000Z";

describe("TASK-011 bounded UTC schedule generator", () => {
  it.each([1, 10])("generates target %i within the UTC date and five-minute grid", (target) => {
    const schedule = generateDailySchedule(
      "2026-10-01",
      new Date(CREATED_AT),
      fixedRandomSource(target, 0, 1),
      uuidSequence(1200),
    );

    expect(schedule.dailyTarget).toBe(target);
    expect(schedule.slots).toHaveLength(target);
    expect(schedule.slots.map((slot) => slot.slotIndex)).toEqual(Array.from({ length: target }, (_value, index) => index));
    expect(schedule.slots.every((slot) => slot.side === "SHORT")).toBe(true);
    expect(schedule.slots.every((slot) => slot.dueAt.startsWith("2026-10-01T"))).toBe(true);
    expect(schedule.slots.every((slot) => new Date(slot.dueAt).getUTCMinutes() % 5 === 0)).toBe(true);
    expect(schedule.slots.every((slot) => slot.status === "SCHEDULED" && slot.missReason === null)).toBe(true);
    for (let index = 1; index < schedule.slots.length; index += 1) {
      const previous = Date.parse(schedule.slots[index - 1]!.dueAt);
      const current = Date.parse(schedule.slots[index]!.dueAt);
      expect(current - previous).toBeGreaterThanOrEqual(30 * 60_000);
    }
  });

  it("draws the daily target only in the inclusive 1 through 10 range", () => {
    expect(generateDailySchedule("2026-10-01", new Date(CREATED_AT), fixedRandomSource(1)).dailyTarget).toBe(1);
    expect(generateDailySchedule("2026-10-01", new Date(CREATED_AT), fixedRandomSource(10)).dailyTarget).toBe(10);
  });

  it("draws each side independently from the injected source", () => {
    let sideDraw = 0;
    const random = {
      nextInt(minInclusive: number, maxExclusive: number) {
        if (minInclusive === 1 && maxExclusive === 11) return 4;
        if (minInclusive === 0 && maxExclusive === 2) return sideDraw++ % 2;
        return minInclusive;
      },
    };
    const schedule = generateDailySchedule("2026-10-01", new Date(CREATED_AT), random, uuidSequence(1300));
    expect(schedule.slots.map((slot) => slot.side)).toEqual(["LONG", "SHORT", "LONG", "SHORT"]);
  });

  it("rejects a random source that returns an out-of-range result", () => {
    expect(() => generateDailySchedule("2026-10-01", new Date(CREATED_AT), {
      nextInt: (_min, max) => max,
    })).toThrow(RangeError);
  });
});
