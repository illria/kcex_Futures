import { describe, expect, it } from "vitest";
import { createSchedulerSetup } from "../task011/helpers.js";

describe("TASK-012 scheduler runtime health blocker", () => {
  it.each(["MANUAL_ACTION", "HALTED"] as const)("blocks a due slot on %s without changing its scheduled time", async (status) => {
    const setup = await createSchedulerSetup({
      startAt: "2026-10-01T00:31:00.000Z",
      target: 1,
      selectedBucket: 6,
    });
    try {
      const initiallyEligible = await setup.scheduler.recover();
      expect(initiallyEligible.status).toBe("DUE");
      const dueAt = initiallyEligible.dueSlot?.dueAt;
      setup.setResilienceStatus(status);
      const blocked = await setup.scheduler.tick();
      expect(blocked.status).toBe("BLOCKED");
      expect(blocked.blockReasons).toContain("RUNTIME_UNHEALTHY");
      expect(blocked.dueSlot?.entryEligibility).toBe("BLOCKED");
      expect(blocked.dueSlot?.dueAt).toBe(dueAt);
      expect(setup.storage.scheduler.getCurrentDueSlot("2026-10-01")?.dueAt).toBe(dueAt);
    } finally {
      await setup.cleanup();
    }
  });
});
