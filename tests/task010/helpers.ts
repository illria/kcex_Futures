import { FixtureProtectionAdapter } from "../../apps/server/src/protection/protection-adapter.js";
import { ProtectionService } from "../../apps/server/src/protection/protection-service.js";
import { createTask008Setup, uuidSequence, type Task008SetupOptions } from "../task008/helpers.js";

export const TASK010_NOW = "2026-09-30T12:00:00.000Z";
export const TASK010_LONG_EVIDENCE = {
  kind: "MATCHED_OPEN",
  source: "FIXTURE",
  symbol: "GPS_USDT",
  side: "LONG",
  entryPrice: 100,
  size: 2.5,
  observedAt: TASK010_NOW,
} as const;

export interface Task010SetupOptions extends Task008SetupOptions {
  executionSide?: "LONG" | "SHORT";
  positionState?: "OPEN" | "FLAT" | "UNKNOWN";
  adapterResult?: unknown;
  adapterThrows?: boolean;
  adapterDelayMs?: number;
  activationTimeoutMs?: number;
  confirmed?: boolean;
}

export async function createTask010Setup(options: Task010SetupOptions = {}) {
  const clock = options.now ?? (() => new Date(TASK010_NOW));
  const side = options.executionSide ?? "LONG";
  const evidence = options.confirmationEvidence ?? [{
    ...TASK010_LONG_EVIDENCE,
    side,
  }];
  const base = await createTask008Setup({
    ...options,
    positionState: "FLAT",
    confirmationEvidence: evidence,
    now: clock,
  });
  let attemptId: string | null = null;
  if (options.confirmed !== false) {
    base.service.armRuntime("ARM ASSISTED LIVE EXECUTION");
    const preview = base.service.createPreview({ side, marginUsdt: 50, leverage: 10 });
    const result = await base.service.confirm({ previewId: preview.preview.previewId, confirmationToken: preview.confirmationToken });
    attemptId = result.lastSubmission?.status === "CONFIRMED" ? result.lastSubmission.attemptId : null;
  }
  if (options.positionState) base.positionSource.setPositionState(options.positionState);

  let adapterCalls = 0;
  const adapter = {
    provider: "FIXTURE" as const,
    async activate(_plan: Parameters<typeof FixtureProtectionAdapter.prototype.activate>[0]): Promise<unknown> {
      adapterCalls += 1;
      if (options.adapterDelayMs) await new Promise((resolve) => setTimeout(resolve, options.adapterDelayMs));
      if (options.adapterThrows) throw new Error("fixture activation error");
      if (options.adapterResult !== undefined) return options.adapterResult;
      return { status: "ACTIVATED", fixtureProtectionId: "00000000-0000-4000-8000-000000000701" };
    },
  };
  const protection = new ProtectionService({
    provider: "FIXTURE",
    adapter,
    storage: base.storage,
    events: base.events,
    positionSource: base.positionSource,
    setPositionState: (state) => base.positionSource.setPositionState(state),
    now: clock,
    idGenerator: uuidSequence(500),
    tokenGenerator: () => "fixture-protection-confirmation-token-0001",
    activationTimeoutMs: options.activationTimeoutMs,
  });
  await protection.recover();

  return {
    ...base,
    protection,
    attemptId,
    adapter,
    get adapterCalls() { return adapterCalls; },
    async cleanup() {
      base.service.close();
      base.storage.close();
      const { rm } = await import("node:fs/promises");
      await rm(base.directory, { recursive: true, force: true });
    },
  };
}

export function defaultProtectionIntent(executionAttemptId: string) {
  return {
    executionAttemptId,
    takeProfit: { basis: "PRICE_PCT" as const, value: 5 },
    stopLoss: { basis: "PRICE_PCT" as const, value: 5 },
  };
}

export async function createActiveProtection(setup: Awaited<ReturnType<typeof createTask010Setup>>) {
  if (!setup.attemptId) throw new Error("Fixture execution attempt was not confirmed.");
  const prepared = setup.protection.createPreview({
    executionAttemptId: setup.attemptId,
    takeProfit: { basis: "PRICE_PCT", value: 5 },
    stopLoss: { basis: "PRICE_PCT", value: 5 },
  });
  return setup.protection.confirm({ previewId: prepared.preview.previewId, confirmationToken: prepared.confirmationToken });
}
