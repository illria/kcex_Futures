import { describe, expect, it } from "vitest";
import { createConfirmedFixtureAttempt, createSchedulerSetup, TASK011_BASE_TIME } from "./helpers.js";

describe("TASK-011 durable daily scheduler", () => {
  it("applies the inclusive due/grace boundaries and does not shift an expired slot", async () => {
    const setup = await createSchedulerSetup({ selectedBucket: 6 });
    try {
      const ready = await setup.scheduler.recover();
      const scheduled = setup.storage.scheduler.listSlots("2026-10-01")[0]!;
      expect(ready.status).toBe("READY");
      expect(ready.nextTradeAt).toBe("2026-10-01T00:30:00.000Z");

      setup.setNow("2026-10-01T00:29:59.999Z");
      expect((await setup.scheduler.tick()).status).toBe("READY");
      setup.setNow("2026-10-01T00:30:00.000Z");
      expect((await setup.scheduler.tick()).status).toBe("DUE");
      setup.setNow("2026-10-01T00:45:00.000Z");
      expect((await setup.scheduler.tick()).status).toBe("DUE");
      setup.setNow("2026-10-01T00:45:00.001Z");
      const expired = await setup.scheduler.tick();
      expect(expired.status).toBe("COMPLETE");
      expect(expired.dueSlot).toBeNull();
      expect(setup.storage.scheduler.getSlot(scheduled.id)).toMatchObject({
        status: "MISSED",
        missReason: "WINDOW_EXPIRED",
        dueAt: scheduled.dueAt,
      });
    } finally {
      await setup.cleanup();
    }
  });

  it("marks elapsed slots MISSED on a late first start and exposes at most one current DUE slot", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T02:00:00.000Z", target: 10, selectedBucket: 0 });
    try {
      const state = await setup.scheduler.recover();
      const slots = setup.storage.scheduler.listSlots("2026-10-01");
      expect(slots.filter((slot) => slot.status === "MISSED").length).toBeGreaterThan(0);
      expect(slots.filter((slot) => slot.status === "DUE")).toHaveLength(1);
      expect(state.status).toBe("DUE");
      expect(state.missed).toBeGreaterThan(0);
      expect(state.dueSlot?.dueAt).toBe("2026-10-01T02:00:00.000Z");
    } finally {
      await setup.cleanup();
    }
  });

  it("reuses the original plan after restart even with a different random source", async () => {
    const setup = await createSchedulerSetup({ target: 4, selectedBucket: 4 });
    try {
      await setup.scheduler.recover();
      const before = setup.storage.scheduler.listSlots("2026-10-01").map((slot) => ({ id: slot.id, dueAt: slot.dueAt, side: slot.side }));
      const { DailySchedulerService } = await import("../../apps/server/src/scheduler/daily-scheduler-service.js");
      const restarted = new DailySchedulerService({
        storage: setup.storage,
        events: setup.events,
        positionSource: { getPositionState: () => "FLAT" },
        getKillSwitchStatus: () => "CLEAR",
        now: () => new Date(TASK011_BASE_TIME),
        randomSource: { nextInt: (_min, max) => max - 1 },
        idGenerator: () => "55000000-0000-4000-8000-000000000001",
      });
      await restarted.recover();
      restarted.stop();
      expect(setup.storage.scheduler.listSlots("2026-10-01").map((slot) => ({ id: slot.id, dueAt: slot.dueAt, side: slot.side })))
        .toEqual(before);
    } finally {
      await setup.cleanup();
    }
  });

  it("marks unfinished prior-day slots MISSED at UTC rollover and retains their history", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T12:00:00.000Z", selectedBucket: 200 });
    try {
      await setup.scheduler.recover();
      const original = setup.storage.scheduler.getDailySchedule("2026-10-01");
      expect(original?.slots[0]?.status).toBe("SCHEDULED");
      setup.setNow("2026-10-02T00:00:00.000Z");
      const next = await setup.scheduler.tick();
      const retained = setup.storage.scheduler.getDailySchedule("2026-10-01");
      expect(retained?.slots[0]).toMatchObject({ status: "MISSED", missReason: "DAY_ROLLOVER" });
      expect(retained?.slots[0]?.dueAt).toBe(original?.slots[0]?.dueAt);
      expect(next.dateKey).toBe("2026-10-02");
      expect(setup.storage.scheduler.getDailySchedule("2026-10-02")).not.toBeNull();
    } finally {
      await setup.cleanup();
    }
  });

  it("marks a slot completed only for a same-side confirmed fixture attempt inside the grace window", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:45:00.000Z" });
    try {
      await setup.scheduler.recover();
      const due = setup.storage.scheduler.getCurrentDueSlot("2026-10-01")!;
      const attemptId = createConfirmedFixtureAttempt(setup.storage, {
        side: due.side,
        confirmedAt: "2026-10-01T00:45:00.000Z",
      });
      const state = await setup.scheduler.tick();
      expect(state.status).toBe("COMPLETE");
      expect(state.completed).toBe(1);
      expect(setup.storage.scheduler.getSlot(due.id)).toMatchObject({ status: "COMPLETED", executionAttemptId: attemptId });
      expect(setup.storage.scheduler.getDailySchedule("2026-10-01")?.completed).toBe(1);
    } finally {
      await setup.cleanup();
    }
  });

  it.each([
    { name: "wrong side", side: "SHORT" as const, confirmedAt: "2026-10-01T00:35:00.000Z", startAt: "2026-10-01T00:40:00.000Z", status: "DUE" },
    { name: "outside the due window", side: "LONG" as const, confirmedAt: "2026-10-01T00:46:00.000Z", startAt: "2026-10-01T00:46:00.000Z", status: "COMPLETE" },
  ])("does not count a confirmed entry that is $name", async ({ side, confirmedAt, startAt, status }) => {
    const setup = await createSchedulerSetup({ startAt });
    try {
      await setup.scheduler.recover();
      createConfirmedFixtureAttempt(setup.storage, { side, confirmedAt });
      const state = await setup.scheduler.tick();
      expect(state.status).toBe(status);
      expect(state.completed).toBe(0);
      expect(setup.storage.scheduler.getDailySchedule("2026-10-01")?.slots[0]?.status).not.toBe("COMPLETED");
    } finally {
      await setup.cleanup();
    }
  });

  it("records the blocking reason when a blocked due slot exhausts its grace window", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:31:00.000Z", position: "OPEN" });
    try {
      expect((await setup.scheduler.recover()).status).toBe("BLOCKED");
      setup.setNow("2026-10-01T00:45:00.001Z");
      await setup.scheduler.tick();
      expect(setup.storage.scheduler.listSlots("2026-10-01")[0]).toMatchObject({
        status: "MISSED",
        missReason: "POSITION_NOT_FLAT",
      });
    } finally {
      await setup.cleanup();
    }
  });

  it("degrades rather than choosing between multiple matching confirmed attempts", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:36:00.000Z" });
    try {
      await setup.scheduler.recover();
      const due = setup.storage.scheduler.getCurrentDueSlot("2026-10-01")!;
      createConfirmedFixtureAttempt(setup.storage, { side: due.side, confirmedAt: "2026-10-01T00:35:00.000Z", sequence: 2500 });
      createConfirmedFixtureAttempt(setup.storage, { side: due.side, confirmedAt: "2026-10-01T00:36:00.000Z", sequence: 2600 });
      const state = await setup.scheduler.tick();
      expect(state.status).toBe("DEGRADED");
      expect(state.blockReasons).toContain("AMBIGUOUS_EXECUTION_MATCH");
      expect(state.dueSlot?.entryEligibility).toBe("BLOCKED");
      expect(setup.storage.scheduler.getCurrentDueSlot("2026-10-01")?.status).toBe("DUE");
      const auditCount = setup.storage.auditEvents.listAuditEvents({ limit: 100 }).filter((event) =>
        event.eventType === "SCHEDULER_DEGRADED").length;
      await setup.scheduler.tick();
      expect(setup.storage.auditEvents.listAuditEvents({ limit: 100 }).filter((event) =>
        event.eventType === "SCHEDULER_DEGRADED")).toHaveLength(auditCount);
    } finally {
      await setup.cleanup();
    }
  });

  it.each([
    { position: "OPEN" as const, reason: "POSITION_NOT_FLAT" },
    { position: "UNKNOWN" as const, reason: "POSITION_UNKNOWN" },
  ])("blocks due eligibility for position state $position", async ({ position, reason }) => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:31:00.000Z", position });
    try {
      const state = await setup.scheduler.recover();
      expect(state.status).toBe("BLOCKED");
      expect(state.blockReasons).toContain(reason);
      expect(state.dueSlot?.entryEligibility).toBe("BLOCKED");
    } finally {
      await setup.cleanup();
    }
  });

  it.each([
    { killSwitch: "ENGAGED" as const, reason: "KILL_SWITCH_ENGAGED" },
    { killSwitch: "UNKNOWN" as const, reason: "KILL_SWITCH_UNKNOWN" },
  ])("blocks due eligibility for Kill Switch $killSwitch", async ({ killSwitch, reason }) => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:31:00.000Z", killSwitch });
    try {
      const state = await setup.scheduler.recover();
      expect(state.status).toBe("BLOCKED");
      expect(state.blockReasons).toContain(reason);
    } finally {
      await setup.cleanup();
    }
  });

  it("blocks while an unresolved execution attempt or active protection guard exists", async () => {
    const setup = await createSchedulerSetup({ startAt: "2026-10-01T00:31:00.000Z" });
    try {
      await setup.scheduler.recover();
      const unresolved = setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
        attemptId: "66000000-0000-4000-8000-000000000001",
        previewId: "66000000-0000-4000-8000-000000000002",
        symbol: "GPS_USDT",
        side: "LONG",
        marginUsdt: 50,
        leverage: 10,
        auditPayload: {},
      });
      setup.storage.executionAttempts.transitionAttempt(unresolved.attemptId, unresolved.version, "UNKNOWN", {
        reason: "SUBMISSION_OUTCOME_UNKNOWN",
        unknownAt: "2026-10-01T00:01:00.000Z",
      });
      expect((await setup.scheduler.tick()).blockReasons).toContain("EXECUTION_UNRESOLVED");
    } finally {
      await setup.cleanup();
    }

    const protectedSetup = await createSchedulerSetup({ startAt: "2026-10-01T00:31:00.000Z" });
    try {
      await protectedSetup.scheduler.recover();
      const attemptId = createConfirmedFixtureAttempt(protectedSetup.storage, {
        side: "LONG",
        confirmedAt: "2026-10-01T00:10:00.000Z",
        sequence: 2700,
      });
      const database = (protectedSetup.storage as unknown as {
        database: { getConnection(): { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }).database.getConnection();
      database.prepare(`INSERT INTO protection_plans(
        id,execution_attempt_id,provider,symbol,side,entry_price,position_size,leverage,
        tp_basis,tp_value,tp_target_price,sl_basis,sl_value,sl_target_price,status,fixture_protection_id,
        created_at,activated_at,updated_at,version
      ) VALUES('66000000-0000-4000-8000-000000000003',?,'FIXTURE','GPS_USDT','LONG',100,2,10,
        'PRICE_PCT',5,105,'PRICE_PCT',5,95,'ACTIVE','66000000-0000-4000-8000-000000000004',?,?,?,1)`)
        .run(attemptId, "2026-10-01T00:10:00.000Z", "2026-10-01T00:10:00.000Z", "2026-10-01T00:10:00.000Z");
      const state = await protectedSetup.scheduler.tick();
      expect(state.status).toBe("BLOCKED");
      expect(state.blockReasons).toContain("PROTECTION_UNRESOLVED");
    } finally {
      await protectedSetup.cleanup();
    }
  });

  it("fails closed as DEGRADED when storage is unavailable", async () => {
    const setup = await createSchedulerSetup({ startAt: TASK011_BASE_TIME });
    setup.storage.close();
    try {
      const state = await setup.scheduler.tick();
      expect(state.status).toBe("DEGRADED");
      expect(state.blockReasons).toContain("STORAGE_DEGRADED");
    } finally {
      setup.scheduler.stop();
    }
  });
});
