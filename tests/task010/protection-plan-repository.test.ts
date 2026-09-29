import { describe, expect, it } from "vitest";
import { createTask010Setup } from "./helpers.js";

const TIME = "2026-09-30T12:00:00.000Z";

describe("TASK-010 protection plan repository", () => {
  it("creates, reads, transitions optimistically, and appends immutable lifecycle events", async () => {
    const setup = await createTask010Setup();
    try {
      const attemptId = setup.attemptId!;
      const plan = {
        id: "a3100000-0000-4000-8000-000000000001",
        executionAttemptId: attemptId,
        provider: "FIXTURE" as const,
        symbol: "GPS_USDT" as const,
        side: "LONG" as const,
        entryPrice: 100,
        positionSize: 2.5,
        leverage: 10,
        takeProfit: { basis: "PRICE_PCT" as const, value: 5, targetPrice: 105 },
        stopLoss: { basis: "PRICE_PCT" as const, value: 5, targetPrice: 95 },
        status: "PLANNED" as const,
        triggeredLeg: null,
        fixtureProtectionId: null,
        createdAt: TIME,
        activatedAt: null,
        triggeredAt: null,
        updatedAt: TIME,
        version: 1,
      };
      const audit = { category: "TRADING" as const, eventType: "PROTECTION_PLANNED", severity: "INFO" as const, message: "Fixture plan persisted.", payload: { protectionId: plan.id, attemptId } };
      const stored = setup.storage.protectionPlans.createPlanWithEventAndAudit({
        plan, eventType: "PROTECTION_PLANNED", eventPayload: { status: "PLANNED" }, audit,
      });
      expect(setup.storage.protectionPlans.getByAttemptId(attemptId)).toEqual(stored);
      expect(setup.storage.protectionPlans.getPositionGuardPlan()?.id).toBe(plan.id);

      const active = setup.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id,
        expectedVersion: 1,
        status: "ACTIVE",
        patch: { activatedAt: TIME, fixtureProtectionId: "a3100000-0000-4000-8000-000000000002" },
        eventType: "PROTECTION_ACTIVATED_FIXTURE",
        eventPayload: { provider: "FIXTURE" },
        audit: { ...audit, eventType: "PROTECTION_ACTIVATED_FIXTURE", message: "Fixture plan active." },
      });
      expect(active).toMatchObject({ status: "ACTIVE", version: 2 });
      expect(() => setup.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id, expectedVersion: 1, status: "UNKNOWN", eventType: "PROTECTION_OUTCOME_UNKNOWN",
        audit: { ...audit, eventType: "PROTECTION_OUTCOME_UNKNOWN", severity: "WARN" },
      })).toThrow(/PROTECTION_VERSION_CONFLICT/);
      expect(() => setup.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id, expectedVersion: 2, status: "PLANNED", eventType: "PROTECTION_PLANNED", audit,
      })).toThrow(/INVALID_PROTECTION_TRANSITION/);
      expect(setup.storage.protectionPlans.listEvents(plan.id)).toHaveLength(2);

      const database = (setup.storage as unknown as { database: { getConnection(): { prepare(sql: string): { run(...args: unknown[]): unknown } } } })
        .database.getConnection();
      expect(() => database.prepare("UPDATE protection_events SET event_type = 'OTHER'").run()).toThrow();
    } finally {
      await setup.cleanup();
    }
  });

  it("enforces one plan per attempt and one guarded position across attempts", async () => {
    const setup = await createTask010Setup();
    try {
      const plan = {
        id: "a3110000-0000-4000-8000-000000000001",
        executionAttemptId: setup.attemptId!,
        provider: "FIXTURE" as const,
        symbol: "GPS_USDT" as const,
        side: "LONG" as const,
        entryPrice: 100,
        positionSize: 2.5,
        leverage: 10,
        takeProfit: { basis: "PRICE_PCT" as const, value: 5, targetPrice: 105 },
        stopLoss: { basis: "PRICE_PCT" as const, value: 5, targetPrice: 95 },
        status: "PLANNED" as const,
        triggeredLeg: null,
        fixtureProtectionId: null,
        createdAt: TIME,
        activatedAt: null,
        triggeredAt: null,
        updatedAt: TIME,
        version: 1,
      };
      const audit = { category: "TRADING" as const, eventType: "PROTECTION_PLANNED", severity: "INFO" as const, message: "Fixture plan persisted.", payload: { protectionId: plan.id, attemptId: plan.executionAttemptId } };
      setup.storage.protectionPlans.createPlanWithEventAndAudit({ plan, eventType: "PROTECTION_PLANNED", audit });
      const activePlan = setup.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id,
        expectedVersion: 1,
        status: "ACTIVE",
        patch: { activatedAt: TIME, fixtureProtectionId: "a3110000-0000-4000-8000-000000000007" },
        eventType: "PROTECTION_ACTIVATED_FIXTURE",
        audit: { ...audit, eventType: "PROTECTION_ACTIVATED_FIXTURE", message: "Fixture plan active." },
      });
      expect(setup.storage.protectionPlans.getPositionGuardPlan()?.status).toBe("ACTIVE");
      expect(() => setup.storage.protectionPlans.createPlanWithEventAndAudit({
        plan: { ...plan, id: "a3110000-0000-4000-8000-000000000003" },
        eventType: "PROTECTION_PLANNED", audit,
      })).toThrow();

      const secondAttempt = "a3110000-0000-4000-8000-000000000004";
      const secondPreview = "a3110000-0000-4000-8000-000000000005";
      const database = (setup.storage as unknown as { database: { getConnection(): { prepare(sql: string): { run(...args: unknown[]): unknown } } } })
        .database.getConnection();
      database.prepare("INSERT INTO execution_attempts(attempt_id,preview_id,provider,symbol,side,margin_usdt,leverage,status,evidence_json,confirmed_at,observed_side,observed_entry_price,observed_size,observed_at,created_at,updated_at) VALUES(?,?, 'FIXTURE','GPS_USDT','LONG',50,10,'CONFIRMED',?,?,'LONG',100,2.5,?,?,?)")
        .run(secondAttempt, secondPreview, JSON.stringify({
          kind: "MATCHED_OPEN", source: "FIXTURE", symbol: "GPS_USDT", side: "LONG",
          entryPrice: 100, size: 2.5, observedAt: TIME,
        }), TIME, TIME, TIME, TIME);
      expect(() => setup.storage.protectionPlans.createPlanWithEventAndAudit({
        plan: { ...plan, id: "a3110000-0000-4000-8000-000000000006", executionAttemptId: secondAttempt, version: 1 },
        eventType: "PROTECTION_PLANNED",
        audit: { ...audit, payload: { protectionId: "a3110000-0000-4000-8000-000000000006", attemptId: secondAttempt } },
      })).toThrow();
      expect(activePlan.status).toBe("ACTIVE");
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects a corrupt persisted plan row", async () => {
    const setup = await createTask010Setup();
    try {
      const active = await setup.protection.createPreview({
        executionAttemptId: setup.attemptId!,
        takeProfit: { basis: "PRICE_PCT", value: 5 },
        stopLoss: { basis: "PRICE_PCT", value: 5 },
      });
      const state = await setup.protection.confirm({
        previewId: active.preview.previewId,
        confirmationToken: active.confirmationToken,
      });
      const planId = state.activePlan!.id;
      const database = (setup.storage as unknown as {
        database: { getConnection(): { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }).database.getConnection();
      database.exec("PRAGMA ignore_check_constraints = ON;");
      database.prepare("UPDATE protection_plans SET entry_price = -1 WHERE id = ?").run(planId);

      expect(() => setup.storage.protectionPlans.getPlan(planId)).toThrow(/failed validation/i);
    } finally {
      await setup.cleanup();
    }
  });
});
