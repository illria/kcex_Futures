import { describe, expect, it } from "vitest";
import { DailySchedulerService } from "../../apps/server/src/scheduler/daily-scheduler-service.js";
import { generateDailySchedule } from "../../apps/server/src/scheduler/schedule-generator.js";
import { createConfirmedFixtureAttempt, createSchedulerSetup, fixedRandomSource, TASK011_BASE_TIME, uuidSequence } from "./helpers.js";

describe("TASK-011 scheduler repository", () => {
  it("creates the daily header, all slots, and audit once, without rerandomizing an existing date", async () => {
    const setup = await createSchedulerSetup({ startAt: TASK011_BASE_TIME, target: 3 });
    try {
      await setup.scheduler.recover();
      const first = setup.storage.scheduler.getDailySchedule("2026-10-01");
      expect(first?.slots).toHaveLength(3);
      expect(first?.completed).toBe(0);
      expect(setup.storage.auditEvents.listAuditEvents({ limit: 100 }).filter((event) =>
        event.eventType === "SCHEDULER_DAILY_PLAN_CREATED")).toHaveLength(1);

      const restart = new DailySchedulerService({
        storage: setup.storage,
        events: setup.events,
        positionSource: { getPositionState: () => "FLAT" as const },
        getKillSwitchStatus: () => "CLEAR" as const,
        now: () => new Date(TASK011_BASE_TIME),
        randomSource: fixedRandomSource(9, 200),
        idGenerator: uuidSequence(9000),
      });
      await restart.recover();
      restart.stop();

      const regenerated = generateDailySchedule("2026-10-01", new Date(TASK011_BASE_TIME), fixedRandomSource(9, 200), uuidSequence(9000));
      const originalDueTimes = first!.slots.map((slot) => slot.dueAt);
      expect(regenerated.slots.map((slot) => slot.dueAt)).not.toEqual(originalDueTimes);
      expect(setup.storage.scheduler.getDailySchedule("2026-10-01")?.slots.map((slot) => slot.dueAt)).toEqual(originalDueTimes);
    } finally {
      await setup.cleanup();
    }
  });

  it("rolls back the header and first slot if a later slot insert fails", async () => {
    const setup = await createSchedulerSetup({ target: 2 });
    try {
      const generated = generateDailySchedule("2026-10-01", new Date(TASK011_BASE_TIME), fixedRandomSource(2), uuidSequence(1400));
      const duplicate = [generated.slots[0]!, { ...generated.slots[1]!, id: generated.slots[0]!.id }];
      expect(() => setup.storage.scheduler.createDailySchedule({
        dateKey: generated.dateKey,
        dailyTarget: generated.dailyTarget,
        createdAt: TASK011_BASE_TIME,
        slots: duplicate,
      })).toThrow();
      expect(setup.storage.scheduler.getDailySchedule("2026-10-01")).toBeNull();
      expect(setup.storage.auditEvents.listAuditEvents({ limit: 100 }).some((event) =>
        event.eventType === "SCHEDULER_DAILY_PLAN_CREATED")).toBe(false);
    } finally {
      await setup.cleanup();
    }
  });

  it("allows no more than one DUE slot for a UTC date", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:00:00.000Z", target: 2, selectedBucket: 0 });
    try {
      await setup.scheduler.recover();
      const slots = setup.storage.scheduler.listSlots("2026-10-01");
      expect(setup.storage.scheduler.getCurrentDueSlot("2026-10-01")?.id).toBe(slots[0]?.id);
      expect(() => setup.storage.scheduler.transitionSlot({
        id: slots[1]!.id,
        expectedVersion: slots[1]!.version,
        status: "DUE",
        at: slots[1]!.dueAt,
      })).toThrow();
      expect(setup.storage.scheduler.listSlots("2026-10-01").filter((slot) => slot.status === "DUE")).toHaveLength(1);
    } finally {
      await setup.cleanup();
    }
  });

  it("atomically completes a due slot, binds its confirmed attempt, and synchronizes the daily count", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:35:00.000Z" });
    try {
      await setup.scheduler.recover();
      const due = setup.storage.scheduler.getCurrentDueSlot("2026-10-01");
      expect(due?.status).toBe("DUE");
      const attemptId = createConfirmedFixtureAttempt(setup.storage, {
        side: due!.side,
        confirmedAt: "2026-10-01T00:35:00.000Z",
      });
      await setup.scheduler.tick();
      expect(setup.storage.scheduler.getSlot(due!.id)).toMatchObject({
        status: "COMPLETED",
        executionAttemptId: attemptId,
        completedAt: "2026-10-01T00:35:00.000Z",
      });
      expect(setup.storage.scheduler.getDailySchedule("2026-10-01")?.completed).toBe(1);
      expect(setup.storage.scheduler.hasExecutionAttemptBinding(attemptId)).toBe(true);
      expect(setup.storage.auditEvents.listAuditEvents({ limit: 100 }).some((event) =>
        event.eventType === "SCHEDULER_SLOT_COMPLETED")).toBe(true);
    } finally {
      await setup.cleanup();
    }
  });

  it("prevents a confirmed attempt from binding to more than one slot", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:01:00.000Z", target: 2, selectedBucket: 0 });
    try {
      await setup.scheduler.recover();
      const due = setup.storage.scheduler.getCurrentDueSlot("2026-10-01");
      const attemptId = createConfirmedFixtureAttempt(setup.storage, {
        side: due!.side,
        confirmedAt: "2026-10-01T00:05:00.000Z",
      });
      setup.storage.scheduler.completeSlotWithAttempt({
        slotId: due!.id,
        expectedVersion: due!.version,
        executionAttemptId: attemptId,
      });
      const slots = setup.storage.scheduler.listSlots("2026-10-01");
      const secondSlot = slots[1]!;
      const database = (setup.storage as unknown as {
        database: { getConnection(): { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }).database.getConnection();
      expect(() => database.prepare(`UPDATE scheduler_slots SET status='COMPLETED', execution_attempt_id=?, completed_at=?
        WHERE id=?`).run(attemptId, "2026-10-01T00:05:00.000Z", secondSlot.id)).toThrow();
    } finally {
      await setup.cleanup();
    }
  });
});
