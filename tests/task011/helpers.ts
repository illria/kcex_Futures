import { DailySchedulerService } from "../../apps/server/src/scheduler/daily-scheduler-service.js";
import type { RandomSource } from "../../apps/server/src/scheduler/schedule-generator.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import type { ExecutionPositionState } from "../../packages/shared/src/execution.js";
import type { KillSwitchStatus } from "../../packages/shared/src/risk.js";
import type { ResilienceStatus } from "../../packages/shared/src/protocol.js";

export const TASK011_BASE_TIME = "2026-10-01T00:00:00.000Z";

export interface SchedulerSetupOptions {
  startAt?: string;
  target?: number;
  selectedBucket?: number;
  sideBit?: number;
  position?: ExecutionPositionState;
  killSwitch?: KillSwitchStatus;
  randomSource?: RandomSource;
  resilienceStatus?: ResilienceStatus;
}

export async function createSchedulerSetup(options: SchedulerSetupOptions = {}) {
  let now = new Date(options.startAt ?? TASK011_BASE_TIME);
  let position = options.position ?? "FLAT";
  let killSwitch = options.killSwitch ?? "CLEAR";
  let resilienceStatus = options.resilienceStatus ?? "IDLE";
  const storage = new StorageService({ databaseFile: ":memory:", now: () => new Date(now) });
  await storage.initialize();
  const events = new EventBus();
  const randomSource = options.randomSource ?? fixedRandomSource(
    options.target ?? 1,
    options.selectedBucket ?? 6,
    options.sideBit ?? 0,
  );
  const scheduler = new DailySchedulerService({
    storage,
    events,
    positionSource: { getPositionState: () => position },
    getKillSwitchStatus: () => killSwitch,
    getResilienceStatus: () => resilienceStatus,
    now: () => new Date(now),
    randomSource,
    idGenerator: uuidSequence(1100),
  });
  return {
    storage,
    events,
    scheduler,
    setNow(value: string) { now = new Date(value); },
    setPosition(value: ExecutionPositionState) { position = value; },
    setKillSwitch(value: KillSwitchStatus) { killSwitch = value; },
    setResilienceStatus(value: ResilienceStatus) { resilienceStatus = value; },
    async cleanup() {
      scheduler.stop();
      storage.close();
    },
  };
}

export function fixedRandomSource(target: number, selectedBucket = 0, sideBit = 0): RandomSource {
  return {
    nextInt(minInclusive, maxExclusive) {
      if (minInclusive === 1 && maxExclusive === 11) return target;
      if (minInclusive === 0 && maxExclusive === 2) return sideBit;
      return Math.max(minInclusive, Math.min(maxExclusive - 1, selectedBucket));
    },
  };
}

export function uuidSequence(start: number): () => string {
  let value = start;
  return () => `11000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

export function createConfirmedFixtureAttempt(
  storage: StorageService,
  input: { side: "LONG" | "SHORT"; confirmedAt: string; sequence?: number },
): string {
  const start = input.sequence ?? 2200;
  const [attemptId, previewId, submissionId] = [start, start + 1, start + 2].map((value) =>
    `22000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
  const submittedAt = new Date(Date.parse(input.confirmedAt) - 2_000).toISOString();
  const attempt = storage.executionAttempts.createSubmittingAttemptWithAudit({
    attemptId,
    previewId,
    symbol: "GPS_USDT",
    side: input.side,
    marginUsdt: 50,
    leverage: 10,
    auditPayload: { fixture: true },
  });
  const submitted = storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "SUBMITTED", {
    fixtureSubmissionId: submissionId,
    submittedAt,
  });
  const confirming = storage.executionAttempts.transitionAttempt(submitted.attemptId, submitted.version, "CONFIRMING");
  storage.executionAttempts.transitionAttempt(confirming.attemptId, confirming.version, "CONFIRMED", {
    confirmedAt: input.confirmedAt,
    observedSide: input.side,
    observedEntryPrice: 100,
    observedSize: 2,
    observedAt: input.confirmedAt,
    evidence: {
      kind: "MATCHED_OPEN",
      source: "FIXTURE",
      symbol: "GPS_USDT",
      side: input.side,
      entryPrice: 100,
      size: 2,
      observedAt: input.confirmedAt,
    },
  });
  return attemptId;
}
