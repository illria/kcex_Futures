import { describe, expect, it } from "vitest";
import { AssistedLiveService } from "../../apps/server/src/execution/assisted-live-service.js";
import { EXECUTION_ARM_ACKNOWLEDGEMENT } from "../../apps/server/src/execution/execution-arm.js";
import { FixturePositionConfirmationSource } from "../../apps/server/src/execution/position-confirmation-service.js";
import { createTask008Setup } from "../task008/helpers.js";
import { parseDashboardEvent } from "../../packages/shared/src/protocol.js";

const NOW = "2026-09-29T12:00:00.000Z";
const matched = (side: "LONG" | "SHORT" = "LONG") => ({
  kind: "MATCHED_OPEN",
  source: "FIXTURE",
  symbol: "GPS_USDT",
  side,
  entryPrice: 0.0123,
  size: 1.25,
  observedAt: NOW,
});
const noPosition = { kind: "NO_POSITION", source: "FIXTURE", observedAt: NOW };
const unavailable = { kind: "UNKNOWN", source: "UNKNOWN", reason: "SOURCE_UNAVAILABLE", observedAt: NOW };

describe("TASK-009 submission outcome and position confirmation", () => {
  async function prepare(setup: Awaited<ReturnType<typeof createTask008Setup>>) {
    setup.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
    return setup.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10 });
  }

  it("polls NO_POSITION without treating it as failure and confirms only matching fixture evidence", async () => {
    const setup = await createTask008Setup({ confirmationEvidence: [noPosition, noPosition, matched()] });
    try {
      const published: unknown[] = [];
      setup.events.subscribe((event) => published.push(event));
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("CONFIRMED");
      expect(result.lastSubmission).toMatchObject({ status: "CONFIRMED", evidence: { kind: "MATCHED_OPEN", side: "LONG", entryPrice: 0.0123, size: 1.25 } });
      expect(setup.fixtureConfirmationSource?.readCalls).toBe(3);
      expect(setup.adapter.submitCalls).toBe(1);
      expect(setup.storage.trades.listTrades({ limit: 100 })).toEqual([]);
      expect(setup.storage.auditEvents.listRiskExecutionEvents({ limit: 100 }).some((event) => event.eventType === "RISK_EXECUTION_SUCCESS")).toBe(true);
      expect(published.map((event) => (event as { type: string }).type)).toEqual(expect.arrayContaining([
        "execution.submitted", "execution.confirming", "execution.confirmed",
      ]));
      const confirmedEvent = published.find((event) => (event as { type: string }).type === "execution.confirmed") as {
        payload: Record<string, unknown>;
      };
      expect(confirmedEvent.payload).toMatchObject({
        provider: "FIXTURE",
        symbol: "GPS_USDT",
        side: "LONG",
        observedEntryPrice: 0.0123,
        observedSize: 1.25,
        observedAt: NOW,
      });
      for (const event of published) expect(parseDashboardEvent(event)).toBeDefined();
    } finally { await setup.cleanup(); }
  });

  it("returns UNKNOWN/SOURCE_UNAVAILABLE when the default fixture evidence source has no fixture", async () => {
    const observedNow = new Date(Date.parse(NOW) + 16_000).toISOString();
    const source = new FixturePositionConfirmationSource(undefined, () => new Date(observedNow));
    const evidence = await source.readEvidence({
      previewId: "94000000-0000-4000-8000-000000000001",
      symbol: "GPS_USDT",
      side: "LONG",
      referencePrice: 0.0123,
      createdAt: NOW,
    });
    expect(evidence).toEqual({
      kind: "UNKNOWN",
      source: "FIXTURE",
      reason: "SOURCE_UNAVAILABLE",
      observedAt: observedNow,
    });
  });

  it("accepts fresh evidence observed after the preview has aged past fifteen seconds", async () => {
    const clock = { value: Date.parse(NOW) };
    const setup = await createTask008Setup({
      now: () => new Date(clock.value),
      confirmationSource: {
        readEvidence: () => {
          clock.value += 16_000;
          return { ...matched(), observedAt: new Date(clock.value).toISOString() };
        },
      },
    });
    try {
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(Date.parse(result.lastSubmission!.evidence!.observedAt) - Date.parse(preview.preview.createdAt)).toBe(16_000);
      expect(result.status).toBe("CONFIRMED");
      expect(setup.adapter.submitCalls).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it("keeps evidence UNKNOWN when its observation is more than fifteen seconds old", async () => {
    const clock = { value: Date.parse(NOW) };
    const setup = await createTask008Setup({
      now: () => new Date(clock.value),
      confirmationSource: {
        readEvidence: () => {
          clock.value += 16_001;
          return matched();
        },
      },
    });
    try {
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("UNKNOWN");
      expect(result.lastSubmission?.evidence?.kind).toBe("UNKNOWN");
      expect(setup.adapter.submitCalls).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it.each([
    { label: "timeout", adapterOptions: { delayMs: 20, resultMode: "VALID" as const }, submitTimeoutMs: 1 },
    { label: "thrown adapter error", adapterOptions: { resultMode: "THROW" as const } },
    { label: "malformed adapter response", adapterOptions: { resultMode: "MALFORMED" as const } },
  ])("persists $label as UNKNOWN and never retries", async ({ adapterOptions, submitTimeoutMs }) => {
    const setup = await createTask008Setup({ adapterOptions, submitTimeoutMs });
    try {
      const published: unknown[] = [];
      setup.events.subscribe((event) => published.push(event));
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("UNKNOWN");
      expect(result.reasons).toContain("SUBMISSION_OUTCOME_UNKNOWN");
      expect(setup.storage.executionAttempts.getBlockingAttempt()).toMatchObject({ status: "UNKNOWN", reason: "SUBMISSION_OUTCOME_UNKNOWN" });
      expect(setup.adapter.submitCalls).toBe(1);
      expect(published.some((event) => (event as { type: string }).type === "execution.unknown")).toBe(true);
      expect(() => setup.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT)).toThrow(/UNRESOLVED_EXECUTION_ATTEMPT/);
    } finally { await setup.cleanup(); }
  });

  it("treats only explicit NOT_SUBMITTED as FAILED and allows a new arm", async () => {
    const setup = await createTask008Setup({ adapterOptions: { failureKind: "EXECUTION_FAILED" } });
    try {
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result).toMatchObject({ status: "FAILED", lastSubmission: { status: "FAILED", outcome: "NOT_SUBMITTED" } });
      expect(setup.storage.executionAttempts.getBlockingAttempt()).toBeNull();
      expect(setup.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT).status).toBe("ARMED");
      expect(setup.adapter.submitCalls).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it.each(["MISMATCH", "UNKNOWN_SOURCE", "THROWN_SOURCE"] as const)("keeps %s confirmation evidence UNKNOWN", async (kind) => {
    const confirmationSource = kind === "THROWN_SOURCE"
      ? { readEvidence: () => { throw new Error("fixture source unavailable"); } }
      : new FixturePositionConfirmationSource([kind === "MISMATCH"
        ? { kind: "MISMATCH", source: "FIXTURE", reason: "SIDE_MISMATCH", observedAt: NOW }
        : unavailable]);
    const setup = await createTask008Setup({ confirmationSource });
    try {
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("UNKNOWN");
      expect(setup.adapter.submitCalls).toBe(1);
      expect(setup.storage.trades.listTrades()).toEqual([]);
    } finally { await setup.cleanup(); }
  });

  it.each([
    { label: "wrong symbol", evidence: { ...matched(), symbol: "ETH_USDT" } },
    { label: "wrong side", evidence: matched("SHORT") },
    { label: "non-positive size", evidence: { ...matched(), size: 0 } },
    { label: "non-positive entry price", evidence: { ...matched(), entryPrice: 0 } },
    { label: "stale observation", evidence: { ...matched(), observedAt: new Date(Date.parse(NOW) - 16_000).toISOString() } },
  ])("fails closed for $label evidence", async ({ evidence }) => {
    const setup = await createTask008Setup({ confirmationEvidence: [evidence] });
    try {
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("UNKNOWN");
      expect(setup.storage.executionAttempts.getBlockingAttempt()?.status).toBe("UNKNOWN");
      expect(setup.storage.trades.listTrades()).toEqual([]);
    } finally { await setup.cleanup(); }
  });

  it("does not infer failure from repeated NO_POSITION after the bounded confirmation deadline", async () => {
    const setup = await createTask008Setup({ confirmationEvidence: [noPosition], confirmationDeadlineMs: 100, confirmationPollIntervalMs: 100 });
    try {
      const preview = await prepare(setup);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("UNKNOWN");
      expect(result.reasons).toContain("CONFIRMATION_TIMEOUT");
      expect(setup.storage.executionAttempts.getBlockingAttempt()).toMatchObject({ status: "UNKNOWN", reason: "CONFIRMATION_TIMEOUT" });
      expect(setup.risk.getState().metrics.consecutiveFailures).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it("reconciles UNKNOWN from fixture evidence without a second adapter call and accounts once", async () => {
    const setup = await createTask008Setup({ confirmationEvidence: [unavailable, matched()] });
    try {
      const preview = await prepare(setup);
      const unknown = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(unknown.status).toBe("UNKNOWN");
      const attemptId = unknown.lastSubmission?.attemptId;
      expect(attemptId).toBeTruthy();
      const confirmed = await setup.service.reconcile(attemptId!);
      expect(confirmed.status).toBe("CONFIRMED");
      expect(setup.adapter.submitCalls).toBe(1);
      const outcomes = setup.storage.auditEvents.listRiskExecutionEvents({ limit: 100 });
      expect(outcomes.filter((event) => event.eventType === "RISK_EXECUTION_FAILURE")).toHaveLength(1);
      expect(outcomes.filter((event) => event.eventType === "RISK_EXECUTION_SUCCESS")).toHaveLength(1);
    } finally { await setup.cleanup(); }
  });

  it("can confirm an ambiguous adapter outcome from later fixture evidence without inventing an acknowledgement", async () => {
    const setup = await createTask008Setup({
      adapterOptions: { resultMode: "THROW" },
      confirmationEvidence: [matched()],
    });
    try {
      const preview = await prepare(setup);
      const unknown = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      const attemptId = unknown.lastSubmission!.attemptId;
      expect(unknown.lastSubmission).toMatchObject({ status: "UNKNOWN", fixtureSubmissionId: null, submittedAt: null });
      const confirmed = await setup.service.reconcile(attemptId);
      expect(confirmed.status).toBe("CONFIRMED");
      expect(confirmed.lastSubmission).toMatchObject({ status: "CONFIRMED", fixtureSubmissionId: null, submittedAt: null });
      expect(setup.adapter.submitCalls).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it("keeps repeated UNKNOWN reconciliation idempotent and single-flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const confirmationSource = {
      readEvidence: async () => {
        reads += 1;
        if (reads === 2) await gate;
        return unavailable;
      },
    };
    const setup = await createTask008Setup({ confirmationSource });
    try {
      const preview = await prepare(setup);
      const unknown = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      const attemptId = unknown.lastSubmission!.attemptId;
      const pending = setup.service.reconcile(attemptId);
      await expect(setup.service.reconcile(attemptId)).rejects.toMatchObject({ code: "CONFIRMATION_BUSY" });
      release();
      expect((await pending).status).toBe("UNKNOWN");
      await setup.service.reconcile(attemptId);
      const failures = setup.storage.auditEvents.listRiskExecutionEvents({ limit: 100 })
        .filter((event) => event.eventType === "RISK_EXECUTION_FAILURE");
      expect(failures).toHaveLength(1);
      expect(setup.adapter.submitCalls).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it("blocks arm, preview, confirm and adapter submit while UNKNOWN is unresolved", async () => {
    const setup = await createTask008Setup({ adapterOptions: { resultMode: "THROW" } });
    try {
      const preview = await prepare(setup);
      const unknown = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(unknown.status).toBe("UNKNOWN");
      expect(() => setup.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT)).toThrow(/UNRESOLVED_EXECUTION_ATTEMPT/);
      expect(() => setup.service.createPreview({ side: "SHORT", marginUsdt: 1, leverage: 1 })).toThrow(/UNRESOLVED_EXECUTION_ATTEMPT/);
      await expect(setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken }))
        .rejects.toMatchObject({ code: "UNRESOLVED_EXECUTION_ATTEMPT" });
      expect(setup.adapter.submitCalls).toBe(1);
    } finally { await setup.cleanup(); }
  });

  it("recovers an interrupted SUBMITTING row to UNKNOWN before a restarted service can accept entries", async () => {
    const setup = await createTask008Setup();
    const interrupted = setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
      attemptId: "91000000-0000-4000-8000-000000000001",
      previewId: "91000000-0000-4000-8000-000000000002",
      symbol: "GPS_USDT",
      side: "LONG",
      marginUsdt: 50,
      leverage: 10,
      auditPayload: {},
    });
    const restarted = new AssistedLiveService({
      provider: "FIXTURE",
      adapter: setup.adapter,
      storage: setup.storage,
      risk: setup.risk,
      events: setup.events,
      positionSource: setup.positionSource,
    });
    try {
      expect(interrupted.status).toBe("SUBMITTING");
      expect((await restarted.recover()).status).toBe("UNKNOWN");
      expect(setup.storage.executionAttempts.getAttempt(interrupted.attemptId)?.status).toBe("UNKNOWN");
      expect(setup.adapter.submitCalls).toBe(0);
      expect(() => restarted.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT)).toThrow(/UNRESOLVED_EXECUTION_ATTEMPT/);
    } finally {
      restarted.close();
      await setup.cleanup();
    }
  });

  it.each(["SUBMITTING", "SUBMITTED", "CONFIRMING", "UNKNOWN"] as const)("recovers persisted %s without resubmitting", async (interruptedStatus) => {
    const setup = await createTask008Setup();
    const attempt = setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
      attemptId: "92000000-0000-4000-8000-000000000001",
      previewId: "92000000-0000-4000-8000-000000000002",
      symbol: "GPS_USDT",
      side: "SHORT",
      marginUsdt: 50,
      leverage: 10,
      auditPayload: {},
    });
    let durable = attempt;
    if (interruptedStatus !== "SUBMITTING") {
      durable = setup.storage.executionAttempts.transitionAttempt(durable.attemptId, durable.version, "SUBMITTED", {
        fixtureSubmissionId: "92000000-0000-4000-8000-000000000003",
        submittedAt: NOW,
      });
    }
    if (interruptedStatus === "CONFIRMING") {
      durable = setup.storage.executionAttempts.transitionAttempt(durable.attemptId, durable.version, "CONFIRMING");
    }
    if (interruptedStatus === "UNKNOWN") {
      durable = setup.storage.executionAttempts.transitionAttempt(durable.attemptId, durable.version, "UNKNOWN", {
        reason: "SUBMISSION_OUTCOME_UNKNOWN",
        unknownAt: NOW,
      });
    }
    const restarted = new AssistedLiveService({
      provider: "FIXTURE",
      adapter: setup.adapter,
      storage: setup.storage,
      risk: setup.risk,
      events: setup.events,
      positionSource: setup.positionSource,
    });
    try {
      expect(durable.status).toBe(interruptedStatus);
      expect((await restarted.recover()).status).toBe("UNKNOWN");
      expect(setup.storage.executionAttempts.getAttempt(attempt.attemptId)?.status).toBe("UNKNOWN");
      expect(setup.adapter.submitCalls).toBe(0);
    } finally {
      restarted.close();
      await setup.cleanup();
    }
  });

  it("halts rather than selecting a latest row when corrupted storage has multiple unresolved attempts", async () => {
    const setup = await createTask008Setup();
    const createAttempt = (attemptId: string, previewId: string) => setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
      attemptId,
      previewId,
      symbol: "GPS_USDT",
      side: "LONG",
      marginUsdt: 50,
      leverage: 10,
      auditPayload: {},
    });
    createAttempt("94000000-0000-4000-8000-000000000001", "94000000-0000-4000-8000-000000000002");
    const database = (setup.storage as unknown as { database: { getConnection(): { exec(sql: string): void } } }).database.getConnection();
    database.exec("DROP INDEX execution_attempts_one_unresolved_idx");
    createAttempt("94000000-0000-4000-8000-000000000003", "94000000-0000-4000-8000-000000000004");

    const restarted = new AssistedLiveService({
      provider: "FIXTURE",
      adapter: setup.adapter,
      storage: setup.storage,
      risk: setup.risk,
      events: setup.events,
      positionSource: setup.positionSource,
    });
    try {
      expect(setup.storage.executionAttempts.getBlockingAttemptCount()).toBe(2);
      const recovered = await restarted.recover();
      expect(recovered.status).toBe("HALTED");
      expect(recovered.lastSubmission).toBeNull();
      expect(setup.adapter.submitCalls).toBe(0);
    } finally {
      restarted.close();
      await setup.cleanup();
    }
  });

  it("does not invoke the adapter when the durable SUBMITTING transaction fails", async () => {
    const setup = await createTask008Setup();
    try {
      const preview = await prepare(setup);
      const database = (setup.storage as unknown as { database: { getConnection(): { exec(sql: string): void } } }).database.getConnection();
      database.exec(`CREATE TRIGGER fail_attempt_audit BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'LIVE_ATTEMPT_SUBMITTING' BEGIN SELECT RAISE(FAIL, 'fixture audit failure'); END;`);
      const result = await setup.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
      expect(result.status).toBe("HALTED");
      expect(setup.adapter.submitCalls).toBe(0);
      expect(setup.storage.executionAttempts.listRecentAttempts()).toEqual([]);
    } finally { await setup.cleanup(); }
  });
});
