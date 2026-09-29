import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { KillSwitchService } from "../../apps/server/src/risk/kill-switch.js";
import { RiskService } from "../../apps/server/src/risk/risk-service.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { AssistedLiveService } from "../../apps/server/src/execution/assisted-live-service.js";
import { FixtureExecutionAdapter, type FixtureExecutionAdapterOptions } from "../../apps/server/src/execution/fixture-execution-adapter.js";
import { FixtureExecutionPositionSource } from "../../apps/server/src/execution/execution-position-source.js";
import { DEFAULT_RISK_LIMITS, type RiskLimits } from "../../packages/shared/src/risk.js";
import type { ExecutionPositionState } from "../../packages/shared/src/execution.js";

export const TASK008_NOW = "2026-09-29T12:00:00.000Z";

export interface Task008SetupOptions {
  now?: () => Date;
  limits?: RiskLimits;
  positionState?: ExecutionPositionState;
  adapter?: FixtureExecutionAdapter;
  adapterOptions?: FixtureExecutionAdapterOptions;
  submitTimeoutMs?: number;
  previewTtlMs?: number;
}

export async function createTask008Setup(options: Task008SetupOptions = {}) {
  const now = options.now ?? (() => new Date(TASK008_NOW));
  const directory = await mkdtemp(join(tmpdir(), "task008-execution-"));
  const storage = new StorageService({ databaseFile: ":memory:", now });
  await storage.initialize();
  const events = new EventBus();
  const risk = new RiskService({
    storage,
    events,
    killSwitch: new KillSwitchService(join(directory, "KILL_SWITCH")),
    limits: options.limits ?? DEFAULT_RISK_LIMITS,
    now,
  });
  await risk.initialize();
  const adapter = options.adapter ?? new FixtureExecutionAdapter({ now, ...options.adapterOptions });
  const positionSource = new FixtureExecutionPositionSource(options.positionState ?? "FLAT");
  const service = new AssistedLiveService({
    provider: "FIXTURE",
    adapter,
    storage,
    risk,
    events,
    positionSource,
    now,
    idGenerator: uuidSequence(),
    confirmationTokenGenerator: uuidSequence(100),
    submitTimeoutMs: options.submitTimeoutMs,
    previewTtlMs: options.previewTtlMs,
  });

  return {
    directory,
    storage,
    events,
    risk,
    adapter,
    positionSource,
    service,
    async cleanup() {
      service.close();
      storage.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function uuidSequence(start = 1): () => string {
  let value = start;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}
