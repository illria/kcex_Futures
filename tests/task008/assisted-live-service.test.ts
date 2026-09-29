import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AssistedLiveService } from "../../apps/server/src/execution/assisted-live-service.js";
import { EXECUTION_ARM_ACKNOWLEDGEMENT } from "../../apps/server/src/execution/execution-arm.js";
import { AssistedExecutionError } from "../../apps/server/src/execution/execution-errors.js";
import { DisabledKcexExecutionAdapter } from "../../apps/server/src/execution/disabled-kcex-execution-adapter.js";
import { AssistedLiveOrderIntentSchema, type ExecutionConfirmInput } from "../../packages/shared/src/execution.js";
import type { DashboardEvent } from "../../packages/shared/src/protocol.js";
import { createTask008Setup } from "./helpers.js";

describe("TASK-008 assisted single submission service", () => {
  const setups: Awaited<ReturnType<typeof createTask008Setup>>[] = [];

  afterEach(async () => {
    for (const setup of setups.splice(0)) await setup.cleanup();
  });

  async function setup(options: Parameters<typeof createTask008Setup>[0] = {}) {
    const value = await createTask008Setup(options);
    setups.push(value);
    return value;
  }

  async function armAndPreview(service: AssistedLiveService, side: "LONG" | "SHORT" = "LONG") {
    service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    return service.createPreview({ side, marginUsdt: 50, leverage: 10 });
  }

  function confirmation(previewId: string, confirmationToken: string): ExecutionConfirmInput {
    return { previewId, confirmationToken };
  }

  it("starts disarmed and defaults to fixture-only fields with no resumable preview", async () => {
    const value = await setup();
    expect(value.service.getState()).toMatchObject({
      status: "DISARMED",
      provider: "FIXTURE",
      armedUntil: null,
      activePreview: null,
      lastSubmission: null,
    });
    value.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    value.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10 });

    const restarted = new AssistedLiveService({
      provider: "FIXTURE",
      adapter: value.adapter,
      storage: value.storage,
      risk: value.risk,
      events: value.events,
      positionSource: value.positionSource,
    });
    expect(restarted.getState()).toMatchObject({ status: "DISARMED", armedUntil: null, activePreview: null });
    restarted.close();
  });

  it("requires the exact acknowledgement, uses a five-minute runtime arm, and disarms manually", async () => {
    const value = await setup();
    expect(() => value.service.armRuntime("ARM")).toThrow(AssistedExecutionError);
    const state = value.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    expect(state.status).toBe("ARMED");
    expect(Date.parse(state.armedUntil!)).toBe(Date.parse("2026-09-29T12:00:00.000Z") + 300_000);
    expect(value.service.disarm()).toMatchObject({ status: "DISARMED", armedUntil: null, activePreview: null });
  });

  it("expires the service arm and invalidates its pending preview without a background timer", async () => {
    const clock = { value: Date.parse("2026-09-29T12:00:00.000Z") };
    const value = await setup({ now: () => new Date(clock.value) });
    const prepared = await armAndPreview(value.service);
    clock.value += 5 * 60_000;
    expect(value.service.getState()).toMatchObject({ status: "DISARMED", armedUntil: null, activePreview: null, reasons: ["ARM_EXPIRED"] });
    await expect(value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken)))
      .rejects.toMatchObject({ code: "ARM_REQUIRED" });
    expect(value.adapter.submitCalls).toBe(0);
  });

  it("rejects a DISABLED provider rather than silently falling back to fixture", async () => {
    const value = await setup();
    const disabled = new AssistedLiveService({
      provider: "DISABLED",
      adapter: new DisabledKcexExecutionAdapter(),
      storage: value.storage,
      risk: value.risk,
      events: value.events,
      positionSource: value.positionSource,
    });
    expect(disabled.getState().provider).toBe("DISABLED");
    expect(() => disabled.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT)).toThrow(/EXECUTION_PROVIDER_DISABLED/);
    expect(disabled.getState().status).toBe("DISARMED");
    const prepared = await armAndPreview(value.service);
    await expect(new DisabledKcexExecutionAdapter().submit(prepared.preview))
      .rejects.toMatchObject({ code: "KCEX_LIVE_EXECUTION_DEFERRED" });
    disabled.close();
  });

  it("creates a fixed MARKET/ISOLATED GPS_USDT immutable preview with a 60-second expiry", async () => {
    const value = await setup({
      now: () => new Date("2026-09-29T12:00:00.000Z"),
    });
    value.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    const result = value.service.createPreview({ side: "SHORT", marginUsdt: 50, leverage: 10 });
    expect(result.state.status).toBe("AWAITING_CONFIRMATION");
    expect(result.preview).toMatchObject({
      symbol: "GPS_USDT",
      side: "SHORT",
      orderType: "MARKET",
      marginMode: "ISOLATED",
      marginUsdt: 50,
      leverage: 10,
      provider: "FIXTURE",
      createdAt: "2026-09-29T12:00:00.000Z",
      expiresAt: "2026-09-29T12:01:00.000Z",
    });
    expect(Object.isFrozen(result.preview)).toBe(true);
    expect(Object.keys(result.preview)).not.toContain("confirmationToken");
    expect(() => AssistedLiveOrderIntentSchema.parse({
      mode: "LIVE",
      symbol: "ETH_USDT",
      side: result.preview.side,
      orderType: result.preview.orderType,
      marginMode: result.preview.marginMode,
      marginUsdt: result.preview.marginUsdt,
      leverage: result.preview.leverage,
    })).toThrow();
  });

  it("rejects values above the ceilings without clamping and invalidates an older preview", async () => {
    const value = await setup();
    value.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    expect(() => value.service.createPreview({ side: "LONG", marginUsdt: 50.01, leverage: 10 })).toThrow();
    expect(() => value.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10.01 })).toThrow();
    const first = value.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10 });
    const second = value.service.createPreview({ side: "SHORT", marginUsdt: 25, leverage: 5 });
    await expect(value.service.confirm(confirmation(first.preview.previewId, first.confirmationToken)))
      .rejects.toMatchObject({ code: "PREVIEW_INVALID" });
    expect(value.service.getState().activePreview?.previewId).toBe(second.preview.previewId);
    expect(value.adapter.submitCalls).toBe(0);
  });

  it("rejects missing arm, wrong token, expired preview, disarm, and token reuse before adapter invocation", async () => {
    const value = await setup();
    expect(() => value.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10 }))
      .toThrow(AssistedExecutionError);

    const prepared = await armAndPreview(value.service);
    await expect(value.service.confirm(confirmation(prepared.preview.previewId, "30000000-0000-4000-8000-000000000999")))
      .rejects.toMatchObject({ code: "PREVIEW_INVALID" });
    expect(value.adapter.submitCalls).toBe(0);

    // Advance an injected clock to expire the preview without waiting.
    const clock = { value: Date.parse("2026-09-29T12:00:00.000Z") };
    const timeTravel = await setup({ now: () => new Date(clock.value) });
    const expiring = await armAndPreview(timeTravel.service);
    clock.value += 60_000;
    await expect(timeTravel.service.confirm(confirmation(expiring.preview.previewId, expiring.confirmationToken)))
      .rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    expect(timeTravel.adapter.submitCalls).toBe(0);
    expect(expiring.preview.expiresAt).toBe("2026-09-29T12:01:00.000Z");

    value.service.disarm();
    await expect(value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken)))
      .rejects.toMatchObject({ code: "ARM_REQUIRED" });
  });

  it("durably records one fixture attempt, confirms fixture evidence, and never persists a LIVE trade or token", async () => {
    const value = await setup({ confirmationEvidence: [{
      kind: "MATCHED_OPEN",
      source: "FIXTURE",
      symbol: "GPS_USDT",
      side: "LONG",
      entryPrice: 0.0123,
      size: 1.25,
      observedAt: "2026-09-29T12:00:00.000Z",
    }] });
    const published: DashboardEvent[] = [];
    value.events.subscribe((event) => published.push(event));
    const prepared = await armAndPreview(value.service);
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result).toMatchObject({ status: "CONFIRMED", provider: "FIXTURE", armedUntil: null, activePreview: null });
    expect(result.lastSubmission).toMatchObject({ status: "CONFIRMED", symbol: "GPS_USDT", side: "LONG" });
    expect(value.adapter.submitCalls).toBe(1);
    expect(value.storage.trades.listTrades()).toEqual([]);
    await expect(value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken)))
      .rejects.toMatchObject({ code: "ARM_REQUIRED" });
    expect(value.adapter.submitCalls).toBe(1);
    const audits = JSON.stringify(value.storage.auditEvents.listAuditEvents({ limit: 100 }));
    expect(audits).toContain("LIVE_ARMED");
    expect(audits).toContain("LIVE_PREVIEW_CREATED");
    expect(audits).toContain("LIVE_ATTEMPT_SUBMITTING");
    expect(audits).toContain("LIVE_ATTEMPT_SUBMITTED");
    expect(audits).toContain("LIVE_POSITION_CONFIRMED_FIXTURE");
    expect(audits).not.toContain(prepared.confirmationToken);
    const submitted = published.find((event) => event.type === "execution.submitted");
    expect(submitted?.type).toBe("execution.submitted");
    if (submitted?.type === "execution.submitted") {
      expect(submitted.payload).toMatchObject({ provider: "FIXTURE", symbol: "GPS_USDT", side: "LONG" });
      expect(submitted.payload.attemptId).toBeTruthy();
      expect(submitted.payload).not.toHaveProperty("exchangeOrderId");
    }
    expect(published.some((event) => event.type === "execution.confirming")).toBe(true);
    expect(published.some((event) => event.type === "execution.confirmed")).toBe(true);
  });

  it("single-flights concurrent confirm requests and enters the adapter once", async () => {
    const value = await setup({ adapterOptions: { delayMs: 25 } });
    const prepared = await armAndPreview(value.service);
    const attempts = await Promise.allSettled([
      value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken)),
      value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken)),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: { code: "EXECUTION_BUSY" },
    });
    expect(value.adapter.submitCalls).toBe(1);
  });

  it("honors manual disarm during precheck before entering the adapter", async () => {
    const value = await setup();
    const prepared = await armAndPreview(value.service);
    const evaluate = value.risk.evaluatePreTrade.bind(value.risk);
    let releasePrecheck!: () => void;
    const precheckGate = new Promise<void>((resolve) => { releasePrecheck = resolve; });
    value.risk.evaluatePreTrade = async (intent, options) => {
      await precheckGate;
      return evaluate(intent, options);
    };

    const pending = value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(value.service.getState().status).toBe("PRECHECK");
    value.service.disarm();
    releasePrecheck();
    await expect(pending).resolves.toMatchObject({ status: "DISARMED", armedUntil: null, activePreview: null });
    expect(value.adapter.submitCalls).toBe(0);
  });

  it.each([
    { positionState: "OPEN" as const, status: "BLOCKED" as const, reason: "POSITION_OPEN" },
    { positionState: "UNKNOWN" as const, status: "HALTED" as const, reason: "POSITION_UNKNOWN" },
  ])("fails closed for $positionState live position evidence", async ({ positionState, status, reason }) => {
    const value = await setup({ positionState });
    const prepared = await armAndPreview(value.service);
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result.status).toBe(status);
    expect(value.risk.getState().reasons).toContain(reason);
    expect(value.adapter.submitCalls).toBe(0);
    expect(value.risk.getState().metrics.consecutiveFailures).toBe(0);
  });

  it("blocks an engaged Kill Switch without counting it as an execution failure", async () => {
    const value = await setup();
    await writeFile(`${value.directory}/KILL_SWITCH`, "", { mode: 0o600 });
    const prepared = await armAndPreview(value.service);
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result.status).toBe("BLOCKED");
    expect(value.risk.getState().killSwitch).toBe("ENGAGED");
    expect(value.adapter.submitCalls).toBe(0);
    expect(value.risk.getState().metrics.consecutiveFailures).toBe(0);
  });

  it("uses the explicit live position source and live aggregates, never an open PAPER record", async () => {
    const value = await setup({
      positionState: "FLAT",
      confirmationEvidence: [{
        kind: "MATCHED_OPEN",
        source: "FIXTURE",
        symbol: "GPS_USDT",
        side: "LONG",
        entryPrice: 0.0123,
        size: 1.25,
        observedAt: "2026-09-29T12:00:00.000Z",
      }],
    });
    value.storage.trades.createTrade({
      id: "40000000-0000-4000-8000-000000000001",
      symbol: "GPS_USDT",
      mode: "PAPER",
      side: "LONG",
      status: "OPEN",
      marginUsdt: 50,
      leverage: 10,
      quantity: 1,
      entryPrice: 0.01,
      fees: 0,
      openedAt: "2026-09-29T11:00:00.000Z",
    });
    const prepared = await armAndPreview(value.service);
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result.status).toBe("CONFIRMED");
    expect(value.risk.getState().metrics).toMatchObject({ mode: "LIVE", dailyOpenedTrades: 0, dailyRealizedLossUsdt: 0 });
    expect(value.adapter.submitCalls).toBe(1);
    expect(value.storage.trades.listTrades()).toHaveLength(1);
  });

  it.each([
    { marginUsdt: 50, leverage: 10, limits: { maxMarginUsdt: 25, maxLeverage: 10 }, reason: "MARGIN_LIMIT" },
    { marginUsdt: 50, leverage: 10, limits: { maxMarginUsdt: 50, maxLeverage: 5 }, reason: "LEVERAGE_LIMIT" },
  ])("applies configured $reason ceilings at confirmation", async ({ marginUsdt, leverage, limits, reason }) => {
    const value = await setup({ limits: { ...limits, maxDailyTrades: 10, maxDailyLossUsdt: 50, maxConsecutiveFailures: 3 } });
    value.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    const prepared = value.service.createPreview({ side: "LONG", marginUsdt, leverage });
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result.status).toBe("BLOCKED");
    expect(value.risk.getState().reasons).toContain(reason);
    expect(value.adapter.submitCalls).toBe(0);
    expect(value.risk.getState().metrics.consecutiveFailures).toBe(0);
  });

  it("halts before risk or adapter when storage is degraded", async () => {
    const value = await setup();
    const prepared = await armAndPreview(value.service);
    value.storage.getHealth = () => ({ status: "DEGRADED", schemaVersion: 1 });
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result.status).toBe("HALTED");
    expect(result.reasons).toContain("STORAGE_DEGRADED");
    expect(value.adapter.submitCalls).toBe(0);
  });

  it("records adapter failure once, increments Risk failures, and does not retry", async () => {
    const value = await setup({ adapterOptions: { failureKind: "EXECUTION_FAILED" } });
    const prepared = await armAndPreview(value.service);
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result).toMatchObject({ status: "FAILED", armedUntil: null, reasons: ["EXECUTION_FAILED"] });
    expect(value.adapter.submitCalls).toBe(1);
    expect(value.risk.getState().metrics.consecutiveFailures).toBe(1);
    expect(value.storage.auditEvents.listAuditEvents({ limit: 100 }).map((event) => event.eventType)).toContain("LIVE_ATTEMPT_NOT_SUBMITTED");
  });

  it("maps a fixture adapter timeout to durable UNKNOWN without retry", async () => {
    const value = await setup({ adapterOptions: { delayMs: 25 }, submitTimeoutMs: 1 });
    const prepared = await armAndPreview(value.service);
    const result = await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(result).toMatchObject({ status: "UNKNOWN", lastSubmission: { status: "UNKNOWN", reason: "SUBMISSION_OUTCOME_UNKNOWN" } });
    expect(value.adapter.submitCalls).toBe(1);
    expect(value.risk.getState().metrics.consecutiveFailures).toBe(1);
    expect(() => value.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT)).toThrow(/UNRESOLVED_EXECUTION_ATTEMPT/);
  });

  it("resets failure accounting only after fixture position confirmation", async () => {
    const value = await setup({ confirmationEvidence: [{
      kind: "MATCHED_OPEN",
      source: "FIXTURE",
      symbol: "GPS_USDT",
      side: "LONG",
      entryPrice: 0.0123,
      size: 1.25,
      observedAt: "2026-09-29T12:00:00.000Z",
    }] });
    await value.risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
    const prepared = await armAndPreview(value.service);
    await value.service.confirm(confirmation(prepared.preview.previewId, prepared.confirmationToken));
    expect(value.risk.getState().metrics.consecutiveFailures).toBe(0);
    expect(value.storage.trades.listTrades()).toEqual([]);
  });
});
