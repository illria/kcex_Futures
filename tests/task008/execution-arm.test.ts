import { describe, expect, it } from "vitest";
import { ExecutionArmService, EXECUTION_ARM_ACKNOWLEDGEMENT } from "../../apps/server/src/execution/execution-arm.js";

describe("TASK-008 runtime execution arm", () => {
  it("starts disarmed, requires the exact phrase, expires, and can be manually disarmed", () => {
    let now = 1_000;
    const arm = new ExecutionArmService(() => now);

    expect(arm.isArmed()).toBe(false);
    expect(() => arm.arm("arm it")).toThrow("INVALID_ARM_ACKNOWLEDGEMENT");
    expect(arm.arm(EXECUTION_ARM_ACKNOWLEDGEMENT)).toBe(new Date(now + 5 * 60_000).toISOString());
    expect(arm.isArmed()).toBe(true);

    now += 5 * 60_000;
    expect(arm.isArmed()).toBe(false);

    arm.arm(EXECUTION_ARM_ACKNOWLEDGEMENT);
    arm.disarm();
    expect(arm.isArmed()).toBe(false);
  });

  it("consumes the arm once and never persists it", () => {
    let now = 10_000;
    const arm = new ExecutionArmService(() => now);
    arm.arm(EXECUTION_ARM_ACKNOWLEDGEMENT);
    expect(arm.consume()).toBe(true);
    expect(arm.consume()).toBe(false);
    expect(arm.isArmed()).toBe(false);
    now += 1;
    expect(arm.getArmedUntil()).toBeNull();
  });
});
