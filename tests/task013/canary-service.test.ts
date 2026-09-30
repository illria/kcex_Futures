import { describe, expect, it } from "vitest";
import { KcexCanaryService } from "../../apps/server/src/kcex-live/kcex-canary-service.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { createMemoryStorage } from "../task005/storage-test-helpers.js";
import { LIVE_CANARY_CONFIRMATION_PHRASE } from "../../packages/shared/src/live-launch.js";
import { verifiedProfile } from "./helpers.js";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";

describe("TASK-013 isolated one-time Canary", () => {
  it("requires explicit side/margin, preview and exact confirmation; it never consults the scheduler", async () => {
    const storage = await createMemoryStorage(() => new Date("2026-10-01T00:00:00.000Z"));
    try {
      let executions = 0;
      let failures = 0;
      const service = new KcexCanaryService({
        attempts: storage.liveExecutionAttempts,
        events: new EventBus(),
        profile: () => verifiedProfile(),
        markPrice: () => 2,
        getBlockReasons: async () => [],
        isVerified: () => false,
        recordFailure: async () => { failures += 1; },
        executeOnce: async (_input, attemptId) => {
          executions += 1;
          expect(attemptId).not.toBe("");
          return "UNKNOWN";
        },
        now: () => new Date("2026-10-01T00:00:00.000Z"),
      });
      const preview = await service.createPreview({
        side: "SHORT",
        marginUsdt: 12,
        takeProfit: { basis: "PRICE_PCT", value: 1 },
        stopLoss: { basis: "ROI_PCT", value: 10 },
      });
      expect(preview.status).toBe("PREVIEWED");
      expect(preview.side).toBe("SHORT");
      expect(preview.marginUsdt).toBe(12);
      expect(preview.quantity).toBe(60);
      const outcome = await service.confirm({ previewId: preview.previewId, confirmation: LIVE_CANARY_CONFIRMATION_PHRASE });
      expect(outcome.status).toBe("UNKNOWN");
      expect(outcome.attemptId).not.toBeNull();
      expect(storage.liveExecutionAttempts.getCanaryAttempt()).toMatchObject({
        attemptType: "CANARY",
        side: "SHORT",
        marginUsdt: 12,
        dateKey: null,
        slotIndex: null,
      });
      expect(executions).toBe(1);
      expect(failures).toBe(1);
      expect((await service.createPreview({
        side: "LONG",
        marginUsdt: 1,
        takeProfit: { basis: "PRICE_PCT", value: 1 },
        stopLoss: { basis: "PRICE_PCT", value: 1 },
      })).blockReasons).toContain("CANARY_ALREADY_ATTEMPTED");
      expect(executions).toBe(1);
    } finally {
      storage.close();
    }
  });

  it("marks a Canary pass only when the durable attempt is confirmed and the verification report is independently verified", async () => {
    const storage = await createMemoryStorage(() => new Date("2026-10-01T00:00:00.000Z"));
    try {
      const service = new KcexCanaryService({
        attempts: storage.liveExecutionAttempts,
        events: new EventBus(),
        profile: () => verifiedProfile(),
        markPrice: () => 2,
        getBlockReasons: async () => [],
        isVerified: () => true,
        executeOnce: async (_input, attemptId) => {
          storage.liveExecutionAttempts.markSubmitted({ attemptId, quantity: 5, notionalUsdt: 100 });
          storage.liveExecutionAttempts.markConfirming(attemptId);
          storage.liveExecutionAttempts.markConfirmed({
            attemptId,
            entryPrice: 2,
            size: 5,
            observedAt: "2026-10-01T00:00:01.000Z",
            tradeId: "22222222-2222-4222-8222-222222222222",
          });
          return "PASSED";
        },
        now: () => new Date("2026-10-01T00:00:00.000Z"),
      });
      const preview = await service.createPreview({
        side: "LONG",
        marginUsdt: 10,
        takeProfit: { basis: "PRICE_PCT", value: 1 },
        stopLoss: { basis: "PRICE_PCT", value: 1 },
      });
      const result = await service.confirm({ previewId: preview.previewId, confirmation: LIVE_CANARY_CONFIRMATION_PHRASE });
      expect(result.status).toBe("PASSED");
      expect(storage.liveExecutionAttempts.getCanaryAttempt()?.status).toBe("CONFIRMED");
    } finally {
      storage.close();
    }
  });

  it("invalidates a preview if fresh market evidence changes the derived quantity", async () => {
    const storage = await createMemoryStorage();
    try {
      let markPrice = 2;
      let executions = 0;
      const service = new KcexCanaryService({
        attempts: storage.liveExecutionAttempts,
        events: new EventBus(),
        profile: () => verifiedProfile(),
        markPrice: () => markPrice,
        getBlockReasons: async () => [],
        executeOnce: async () => { executions += 1; return "UNKNOWN"; },
      });
      const preview = await service.createPreview({
        side: "LONG",
        marginUsdt: 10,
        takeProfit: { basis: "PRICE_PCT", value: 1 },
        stopLoss: { basis: "PRICE_PCT", value: 1 },
      });
      expect(preview.quantity).toBe(50);
      markPrice = 4;
      const result = await service.confirm({ previewId: preview.previewId, confirmation: LIVE_CANARY_CONFIRMATION_PHRASE });
      expect(result.status).toBe("NOT_STARTED");
      expect(result.blockReasons).toContain("PREVIEW_QUANTITY_CHANGED");
      expect(storage.liveExecutionAttempts.getCanaryAttempt()).toBeNull();
      expect(executions).toBe(0);
    } finally {
      storage.close();
    }
  });

  it("rejects an incorrect confirmation phrase without creating an attempt", async () => {
    const storage = await createMemoryStorage();
    try {
      const service = new KcexCanaryService({
        attempts: storage.liveExecutionAttempts,
        events: new EventBus(),
        profile: () => verifiedProfile(),
        markPrice: () => 2,
        getBlockReasons: async () => [],
        executeOnce: async () => "UNKNOWN",
      });
      const preview = await service.createPreview({
        side: "LONG",
        marginUsdt: 10,
        takeProfit: { basis: "PRICE_PCT", value: 1 },
        stopLoss: { basis: "PRICE_PCT", value: 1 },
      });
      await expect(service.confirm({ previewId: preview.previewId, confirmation: "CONFIRM" })).rejects.toThrow();
      expect(storage.liveExecutionAttempts.getCanaryAttempt()).toBeNull();
    } finally {
      storage.close();
    }
  });
});
