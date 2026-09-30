import { describe, expect, it } from "vitest";
import { AutoLiveOrchestrator } from "../../apps/server/src/kcex-live/auto-live-orchestrator.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { LIVE_AUTOMATION_CONFIRMATION_PHRASE } from "../../packages/shared/src/live-launch.js";
import { readyLivePreflight } from "./helpers.js";

const NOW = "2026-10-01T00:30:00.000Z";
const SLOT = {
  id: "11111111-1111-4111-8111-111111111111",
  dateKey: "2026-10-01",
  slotIndex: 0,
  side: "LONG" as const,
  dueAt: NOW,
  status: "DUE" as const,
};

function configured(options: Partial<ConstructorParameters<typeof AutoLiveOrchestrator>[0]> = {}) {
  const events = options.events ?? new EventBus();
  const service = new AutoLiveOrchestrator({
    events,
    getPreflight: () => readyLivePreflight(),
    now: () => new Date(NOW),
    ...options,
  });
  service.configureProtection({
    takeProfit: { basis: "PRICE_PCT", value: 1 },
    stopLoss: { basis: "ROI_PCT", value: 10 },
  });
  return service;
}

describe("TASK-013 Auto Live runtime gate", () => {
  it("starts disarmed, requires the exact phrase, and only processes an armed DUE slot", async () => {
    let claims = 0;
    let executions = 0;
    const service = configured({
      claimSlotOnce: async () => { claims += 1; return "22222222-2222-4222-8222-222222222222"; },
      executeDueSlot: async (slot) => { executions += 1; expect(slot.side).toBe("LONG"); return "POSITION_OPEN"; },
    });
    expect(service.getState().status).toBe("DISARMED");
    expect(service.getState().canArm).toBe(true);
    expect(() => service.arm("start" )).toThrow("LIVE_AUTOMATION_CONFIRMATION_MISMATCH");
    service.arm(LIVE_AUTOMATION_CONFIRMATION_PHRASE);
    await service.onSchedulerSlot({ ...SLOT, dueAt: "2026-10-01T00:30:01.000Z" });
    expect(executions).toBe(0);
    const opened = await service.onSchedulerSlot(SLOT);
    expect(opened.status).toBe("POSITION_OPEN");
    expect(claims).toBe(1);
    expect(executions).toBe(1);
    service.stop();
    expect(service.getState().status).toBe("DISARMED");
  });

  it("never catches up after the bounded due grace and never claims the slot", async () => {
    let claims = 0;
    let executions = 0;
    const service = configured({
      claimSlotOnce: async () => { claims += 1; return "22222222-2222-4222-8222-222222222222"; },
      executeDueSlot: async () => { executions += 1; return "POSITION_OPEN"; },
      graceMs: 60_000,
      now: () => new Date("2026-10-01T00:31:00.001Z"),
    });
    service.arm(LIVE_AUTOMATION_CONFIRMATION_PHRASE);
    const state = await service.onSchedulerSlot(SLOT);
    expect(state.status).toBe("BLOCKED");
    expect(claims).toBe(0);
    expect(executions).toBe(0);
  });

  it("a Stop request during preflight prevents claiming or submitting a due slot", async () => {
    let releaseRefresh: (() => void) | null = null;
    let claims = 0;
    let executions = 0;
    const refresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const service = configured({
      refreshPreflight: async () => refresh,
      claimSlotOnce: async () => { claims += 1; return "44444444-4444-4444-8444-444444444444"; },
      executeDueSlot: async () => { executions += 1; return "POSITION_OPEN"; },
    });
    service.arm(LIVE_AUTOMATION_CONFIRMATION_PHRASE);
    const run = service.onSchedulerSlot(SLOT);
    service.stop();
    releaseRefresh?.();
    expect((await run).status).toBe("DISARMED");
    expect(claims).toBe(0);
    expect(executions).toBe(0);
    expect(service.isRuntimeAuthorized()).toBe(false);
  });

  it("blocks degraded resilience, open orders, unresolved state, and Kill Switch before any claim", async () => {
    for (const override of [
      { resilienceStatus: "DEGRADED" },
      { openOrdersClear: false },
      { unresolvedExecution: true },
      { unresolvedProtection: true },
      { killSwitch: "ENGAGED" },
      { positionStatus: "UNKNOWN" },
      { automationAuthorized: false },
    ] as const) {
      let claims = 0;
      const service = new AutoLiveOrchestrator({
        events: new EventBus(),
        getPreflight: () => readyLivePreflight(override),
        claimSlotOnce: async () => { claims += 1; return "22222222-2222-4222-8222-222222222222"; },
        executeDueSlot: async () => "POSITION_OPEN",
        now: () => new Date(NOW),
      });
      service.configureProtection({ takeProfit: { basis: "PRICE_PCT", value: 1 }, stopLoss: { basis: "PRICE_PCT", value: 1 } });
      expect(service.getState().canArm).toBe(false);
      expect(claims).toBe(0);
    }
  });

  it("restarts disarmed and UNKNOWN permanently stops later scheduler execution", async () => {
    let executions = 0;
    const options = {
      events: new EventBus(),
      getPreflight: () => readyLivePreflight(),
      claimSlotOnce: async () => "33333333-3333-4333-8333-333333333333",
      executeDueSlot: async () => { executions += 1; return "UNKNOWN" as const; },
      now: () => new Date(NOW),
    };
    const firstProcess = configured(options);
    firstProcess.arm(LIVE_AUTOMATION_CONFIRMATION_PHRASE);
    expect((await firstProcess.onSchedulerSlot(SLOT)).status).toBe("HALTED");
    expect(firstProcess.isRuntimeAuthorized()).toBe(false);
    const restarted = configured(options);
    expect(restarted.getState().status).toBe("DISARMED");
    expect(restarted.isRuntimeAuthorized()).toBe(false);
    expect(executions).toBe(1);
  });
});
