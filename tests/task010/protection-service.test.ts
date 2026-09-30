import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProtectionService } from "../../apps/server/src/protection/protection-service.js";
import type { ProtectionPlan } from "../../packages/shared/src/protection.js";
import { createActiveProtection, createTask010Setup, TASK010_NOW } from "./helpers.js";

describe("TASK-010 fixture protection lifecycle", () => {
  const setups: Array<Awaited<ReturnType<typeof createTask010Setup>>> = [];
  afterEach(async () => {
    for (const setup of setups.splice(0)) await setup.cleanup();
  });

  async function setup(options: Parameters<typeof createTask010Setup>[0] = {}) {
    const value = await createTask010Setup(options);
    setups.push(value);
    return value;
  }

  async function preview(value: Awaited<ReturnType<typeof createTask010Setup>>) {
    if (!value.attemptId) throw new Error("Expected a confirmed execution attempt.");
    return value.protection.createPreview({
      executionAttemptId: value.attemptId,
      takeProfit: { basis: "PRICE_PCT", value: 5 },
      stopLoss: { basis: "PRICE_PCT", value: 5 },
    });
  }

  it("requires a latest CONFIRMED attempt and an OPEN position source", async () => {
    const notConfirmed = await setup({ confirmed: false, positionState: "OPEN" });
    expect(() => notConfirmed.protection.createPreview({
      executionAttemptId: "00000000-0000-4000-8000-000000000999",
      takeProfit: { basis: "PRICE_PCT", value: 5 },
      stopLoss: { basis: "PRICE_PCT", value: 5 },
    })).toThrow(/EXECUTION_ATTEMPT_NOT_CONFIRMED/);

    const staleConfirmed = await setup({ positionState: "OPEN" });
    const database = (staleConfirmed.storage as unknown as {
      database: { getConnection(): { prepare(sql: string): { run(...args: unknown[]): unknown } } };
    }).database.getConnection();
    const newerAttemptId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    const newerPreviewId = "ffffffff-ffff-4fff-8fff-fffffffffff2";
    const newerTime = "2026-09-30T12:00:01.000Z";
    database.prepare(`INSERT INTO execution_attempts(
      attempt_id, preview_id, provider, symbol, side, margin_usdt, leverage, status,
      evidence_json, confirmed_at, observed_side, observed_entry_price, observed_size, observed_at,
      created_at, updated_at
    ) VALUES(?, ?, 'FIXTURE', 'GPS_USDT', 'LONG', 50, 10, 'CONFIRMED', ?, ?, 'LONG', 100, 2.5, ?, ?, ?)`)
      .run(newerAttemptId, newerPreviewId, JSON.stringify({
        kind: "MATCHED_OPEN", source: "FIXTURE", symbol: "GPS_USDT", side: "LONG",
        entryPrice: 100, size: 2.5, observedAt: newerTime,
      }), newerTime, newerTime, newerTime, newerTime);
    expect(() => staleConfirmed.protection.createPreview({
      executionAttemptId: staleConfirmed.attemptId!,
      takeProfit: { basis: "PRICE_PCT", value: 5 },
      stopLoss: { basis: "PRICE_PCT", value: 5 },
    })).toThrow(/NOT_LATEST_CONFIRMED_ATTEMPT/);

    const notOpen = await setup({ positionState: "FLAT" });
    await expect(preview(notOpen)).rejects.toMatchObject({ code: "POSITION_NOT_OPEN" });
    notOpen.positionSource.setPositionState("UNKNOWN");
    await expect(preview(notOpen)).rejects.toMatchObject({ code: "POSITION_UNKNOWN" });
  });

  it.each(["SUBMITTING", "SUBMITTED", "CONFIRMING", "UNKNOWN", "FAILED"] as const)(
    "rejects execution attempt state %s",
    async (status) => {
      let attemptId = "";
      const value = await setup({
        confirmed: false,
        positionState: "OPEN",
        seedAttempts(storage) {
          const attempt = storage.executionAttempts.createSubmittingAttemptWithAudit({
            attemptId: "a3020000-0000-4000-8000-000000000" + String(["SUBMITTING", "SUBMITTED", "CONFIRMING", "UNKNOWN", "FAILED"].indexOf(status) + 1).padStart(3, "0"),
            previewId: "a3030000-0000-4000-8000-000000000" + String(["SUBMITTING", "SUBMITTED", "CONFIRMING", "UNKNOWN", "FAILED"].indexOf(status) + 1).padStart(3, "0"),
            symbol: "GPS_USDT",
            side: "LONG",
            marginUsdt: 50,
            leverage: 10,
            auditPayload: {},
          });
          attemptId = attempt.attemptId;
          if (status === "SUBMITTED" || status === "CONFIRMING") {
            const submitted = storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "SUBMITTED", {
              fixtureSubmissionId: "a3040000-0000-4000-8000-000000000001",
              submittedAt: TASK010_NOW,
            });
            if (status === "CONFIRMING") storage.executionAttempts.transitionAttempt(submitted.attemptId, submitted.version, "CONFIRMING");
          } else if (status === "UNKNOWN") {
            storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "UNKNOWN", {
              reason: "SUBMISSION_OUTCOME_UNKNOWN", unknownAt: TASK010_NOW,
            });
          } else if (status === "FAILED") {
            storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "FAILED", {
              failureKind: "EXECUTION_FAILED", outcome: "NOT_SUBMITTED", failedAt: TASK010_NOW,
            });
          }
        },
      });
      const expected = status === "FAILED" ? "EXECUTION_ATTEMPT_NOT_CONFIRMED" : "EXECUTION_ATTEMPT_UNRESOLVED";
      expect(() => value.protection.createPreview({
        executionAttemptId: attemptId,
        takeProfit: { basis: "PRICE_PCT", value: 5 },
        stopLoss: { basis: "PRICE_PCT", value: 5 },
      })).toThrow(new RegExp(expected));
    },
  );

  it("derives both targets from durable evidence and freezes the explicit preview", async () => {
    const value = await setup();
    const prepared = await preview(value);
    expect(prepared.preview).toMatchObject({
      symbol: "GPS_USDT",
      side: "LONG",
      entryPrice: 100,
      positionSize: 2.5,
      leverage: 10,
      takeProfit: { basis: "PRICE_PCT", value: 5, targetPrice: 105 },
      stopLoss: { basis: "PRICE_PCT", value: 5, targetPrice: 95 },
    });
    expect(Object.isFrozen(prepared.preview)).toBe(true);
    expect(Object.isFrozen(prepared.preview.takeProfit)).toBe(true);
    expect(prepared.state.status).toBe("PREVIEW_READY");
    expect(Date.parse(prepared.preview.expiresAt) - Date.parse("2026-09-30T12:00:00.000Z")).toBe(60_000);
  });

  it("commits PLANNED before one fixture activation and never writes a LIVE trade", async () => {
    const value = await setup();
    const activationStatuses: Array<string | null> = [];
    const adapter = {
      provider: "FIXTURE" as const,
      async activate(plan: ProtectionPlan) {
        activationStatuses.push(value.storage.protectionPlans.getByAttemptId(plan.executionAttemptId)?.status ?? null);
        return { status: "ACTIVATED", fixtureProtectionId: "00000000-0000-4000-8000-000000000701" };
      },
    };
    const service = new ProtectionService({
      provider: "FIXTURE", adapter, storage: value.storage, events: value.events,
      positionSource: value.positionSource, now: () => new Date("2026-09-30T12:00:00.000Z"),
    });
    await service.recover();
    const prepared = service.createPreview({
      executionAttemptId: value.attemptId!,
      takeProfit: { basis: "PRICE_PCT", value: 5 },
      stopLoss: { basis: "PRICE_PCT", value: 5 },
    });
    const result = await service.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken });
    expect(activationStatuses).toEqual(["PLANNED"]);
    expect(result.status).toBe("ACTIVE");
    expect(result.activePlan).toMatchObject({ provider: "FIXTURE", status: "ACTIVE", fixtureProtectionId: "00000000-0000-4000-8000-000000000701" });
    expect(value.storage.protectionPlans.listEvents(result.activePlan!.id).map((event) => event.eventType))
      .toEqual(["PROTECTION_PLANNED", "PROTECTION_ACTIVATED_FIXTURE"]);
    expect(value.storage.trades.listTrades()).toEqual([]);
    expect(JSON.stringify(value.storage.auditEvents.listAuditEvents({ limit: 100 }))).not.toContain(prepared.confirmationToken);
  });

  it("does not call the adapter if the durable PLANNED insert fails", async () => {
    const value = await setup();
    const prepared = await preview(value);
    const database = (value.storage as unknown as { database: { getConnection(): { exec(sql: string): void } } })
      .database.getConnection();
    database.exec(`CREATE TRIGGER fail_protection_insert BEFORE INSERT ON protection_plans
      BEGIN SELECT RAISE(ABORT, 'fixture insert blocked'); END;`);

    await expect(value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken }))
      .rejects.toMatchObject({ code: "STORAGE_DEGRADED" });
    expect(value.adapterCalls).toBe(0);
    expect(value.storage.protectionPlans.listPlans()).toEqual([]);
  });

  it.each([
    { label: "adapter timeout", options: { adapterDelayMs: 30, activationTimeoutMs: 1 } },
    { label: "adapter throw", options: { adapterThrows: true } },
    { label: "malformed adapter result", options: { adapterResult: { status: "ACTIVATED", exchangeOrderId: "fixture-invalid" } } },
  ])("stores $label as UNKNOWN without retry", async ({ options }) => {
    const value = await setup(options);
    const prepared = await preview(value);
    const result = await value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken });
    expect(result.status).toBe("UNKNOWN");
    expect(value.storage.protectionPlans.getByAttemptId(value.attemptId!)?.status).toBe("UNKNOWN");
    expect(value.adapterCalls).toBe(1);
    const restarted = new ProtectionService({
      provider: "FIXTURE", adapter: value.adapter, storage: value.storage, events: value.events,
      positionSource: value.positionSource, setPositionState: (state) => value.positionSource.setPositionState(state),
    });
    expect((await restarted.recover()).status).toBe("UNKNOWN");
    expect(value.adapterCalls).toBe(1);
    expect(() => value.protection.createPreview({
      executionAttemptId: value.attemptId!,
      takeProfit: { basis: "PRICE_PCT", value: 5 },
      stopLoss: { basis: "PRICE_PCT", value: 5 },
    })).toThrow(/PROTECTION_ALREADY_EXISTS/);
  });

  it("allows a new explicit preview after FAILED_NOT_ACTIVATED only", async () => {
    const value = await setup({ adapterResult: { status: "FAILED_NOT_ACTIVATED", reason: "FIXTURE_REJECTED" } });
    const first = await preview(value);
    expect((await value.protection.confirm({ previewId: first.preview.previewId, confirmationToken: first.confirmationToken })).status).toBe("ERROR");
    expect(value.storage.protectionPlans.getByAttemptId(value.attemptId!)?.status).toBe("ERROR");
    const second = await preview(value);
    expect(second.preview.previewId).not.toBe(first.preview.previewId);
    expect(value.adapterCalls).toBe(1);
  });

  it("expires a preview and consumes a valid confirmation token once", async () => {
    const clock = { value: Date.parse("2026-09-30T12:00:00.000Z") };
    const value = await setup({ now: () => new Date(clock.value) });
    const prepared = await preview(value);
    clock.value += 60_000;
    await expect(value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken }))
      .rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    expect(value.adapterCalls).toBe(0);
  });

  it("consumes a successful preview token exactly once", async () => {
    const value = await setup();
    const prepared = await preview(value);
    expect((await value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken })).status)
      .toBe("ACTIVE");
    await expect(value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken }))
      .rejects.toMatchObject({ code: "PREVIEW_INVALID" });
    expect(value.adapterCalls).toBe(1);
  });

  it("single-flights concurrent confirmation", async () => {
    const value = await setup({ adapterDelayMs: 20 });
    const prepared = await preview(value);
    const results = await Promise.allSettled([
      value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken }),
      value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(value.adapterCalls).toBe(1);
  });

  it("blocks adapter calls when storage is degraded", async () => {
    const value = await setup();
    const prepared = await preview(value);
    value.storage.close();
    await expect(value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken }))
      .rejects.toMatchObject({ code: "STORAGE_DEGRADED" });
    expect(value.adapterCalls).toBe(0);
  });

  it("allows protection for an OPEN confirmed fixture position while Kill Switch is ENGAGED", async () => {
    const value = await setup();
    await writeFile(join(value.directory, "KILL_SWITCH"), "engaged", { mode: 0o600 });
    expect((await value.risk.refresh()).killSwitch).toBe("ENGAGED");
    const prepared = await preview(value);
    expect((await value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken })).status).toBe("ACTIVE");
    expect(value.adapterCalls).toBe(1);
  });

  it("restores active fixture protection and never closes the position after a trigger", async () => {
    const value = await setup();
    await createActiveProtection(value);
    const restarted = new ProtectionService({
      provider: "FIXTURE", adapter: value.adapter, storage: value.storage, events: value.events,
      positionSource: value.positionSource, setPositionState: (state) => value.positionSource.setPositionState(state),
    });
    expect((await restarted.recover()).status).toBe("ACTIVE");
    expect(value.protection.evaluateFixtureMark(106).status).toBe("TRIGGERED_TP");
    expect(value.positionSource.getPositionState()).toBe("UNKNOWN");
    expect(value.storage.protectionPlans.getByAttemptId(value.attemptId!)?.status).toBe("TRIGGERED_TP");
    expect(value.storage.trades.listTrades()).toEqual([]);
    expect((await restarted.recover()).status).toBe("TRIGGERED_TP");
  });

  it("converts interrupted PLANNED to UNKNOWN on restart without adapter activation", async () => {
    const value = await setup();
    const prepared = await preview(value);
    const planned: ProtectionPlan = {
      id: "a3010000-0000-4000-8000-000000000701",
      executionAttemptId: value.attemptId!,
      provider: "FIXTURE",
      symbol: "GPS_USDT",
      side: "LONG",
      entryPrice: 100,
      positionSize: 2.5,
      leverage: 10,
      takeProfit: prepared.preview.takeProfit,
      stopLoss: prepared.preview.stopLoss,
      status: "PLANNED",
      triggeredLeg: null,
      fixtureProtectionId: null,
      createdAt: TASK010_NOW,
      activatedAt: null,
      triggeredAt: null,
      updatedAt: TASK010_NOW,
      version: 1,
    };
    const audit = {
      category: "TRADING" as const,
      eventType: "PROTECTION_PLANNED",
      severity: "INFO" as const,
      message: "Fixture plan persisted before activation.",
      payload: { protectionId: planned.id, attemptId: planned.executionAttemptId },
    };
    value.storage.protectionPlans.createPlanWithEventAndAudit({ plan: planned, eventType: "PROTECTION_PLANNED", audit });
    const recovery = new ProtectionService({
      provider: "FIXTURE", adapter: value.adapter, storage: value.storage, events: value.events,
      positionSource: value.positionSource, setPositionState: (state) => value.positionSource.setPositionState(state),
    });
    expect((await recovery.recover()).status).toBe("UNKNOWN");
    expect(value.storage.protectionPlans.getByAttemptId(value.attemptId!)?.status).toBe("UNKNOWN");
    expect(value.adapterCalls).toBe(0);
  });

  it("never broadcasts or persists the runtime confirmation token", async () => {
    const value = await setup();
    const events: unknown[] = [];
    value.events.subscribe((event) => events.push(event));
    const prepared = await preview(value);
    await value.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken });
    const durable = JSON.stringify({
      plans: value.storage.protectionPlans.listPlans(),
      events: value.storage.protectionPlans.listEvents(value.storage.protectionPlans.getLatestPlan()!.id),
      audit: value.storage.auditEvents.listAuditEvents({ limit: 100 }),
      websocket: events,
    });
    expect(durable).not.toContain(prepared.confirmationToken);
  });
});
