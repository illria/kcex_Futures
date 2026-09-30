import type { Logger } from "pino";
import { applySnapshotFreshness } from "../../../../packages/shared/src/freshness.js";
import { assertFuturesSourceConsistency } from "../../../../packages/shared/src/futures-invariants.js";
import type {
  AuthStatus,
  BrowserStatus,
  FuturesReadStatus,
  KcexFuturesSnapshot,
  ReadHealth,
  SelectorEvidenceField,
} from "../../../../packages/shared/src/protocol.js";
import { EventBus } from "../realtime/event-bus.js";
import type { FuturesReadAdapter, FuturesReadDiagnostics, FuturesSnapshotResult } from "./kcex-futures-read-adapter.js";

export const FUTURES_READ_POLL_MIN_MS = 2_000;
export const FUTURES_READ_POLL_MAX_MS = 60_000;

export function normalizePollInterval(value: number): number {
  if (!Number.isFinite(value)) return 5_000;
  return Math.min(FUTURES_READ_POLL_MAX_MS, Math.max(FUTURES_READ_POLL_MIN_MS, Math.trunc(value)));
}

export interface FuturesReadServiceOptions {
  adapter: FuturesReadAdapter;
  events: EventBus;
  logger: Logger;
  authStatus: () => AuthStatus;
  enabled: boolean;
  pollMs: number;
  now?: () => Date;
  onRuntimeSignal?: (signal: "SESSION_LOST" | "MANUAL_CHALLENGE") => void | Promise<void>;
}

export interface FuturesReadState {
  status: FuturesReadStatus;
  health: ReadHealth;
  browserStatus: BrowserStatus;
  consecutiveReadFailures: number;
  updatedAt: string;
}

export interface SelectorDriftObservation {
  suspected: boolean;
  consecutiveEvidenceFailures: number;
  missingFields: SelectorEvidenceField[];
}

const emptyDiagnostics: FuturesReadDiagnostics = {
  authenticated: false,
  trustedPage: false,
  loginControlsVisible: false,
  challengeVisible: false,
  evidence: { symbol: false, market: false, account: false, contract: false, position: false, openOrders: false },
  missingFields: [],
};

function readStatusForAuth(status: AuthStatus): FuturesReadStatus {
  if (status === "SESSION_LOST") return "SESSION_LOST";
  if (status === "MANUAL_CHALLENGE") return "MANUAL_CHALLENGE";
  return "UNKNOWN";
}

export class FuturesReadService {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private pollInProgress = false;
  private latest: KcexFuturesSnapshot | null = null;
  private consecutiveReadFailures = 0;
  private runtimeState: BrowserStatus = "NOT_STARTED";
  private forceLatestStale = false;
  private lifecycleGeneration = 0;
  private lastReadStatus: FuturesReadStatus = "UNKNOWN";
  private lastReadHealth: ReadHealth = "UNKNOWN";
  private lastReadAttemptAt: string;
  private hasPerformedRead = false;
  private latestDiagnostics: FuturesReadDiagnostics = emptyDiagnostics;
  private selectorDrift: SelectorDriftObservation = { suspected: false, consecutiveEvidenceFailures: 0, missingFields: [] };
  private lastMissingEvidenceKey = "";

  constructor(private readonly options: FuturesReadServiceOptions) {
    this.intervalMs = normalizePollInterval(options.pollMs);
    this.now = options.now ?? (() => new Date());
    this.lastReadAttemptAt = this.now().toISOString();
    this.runtimeState = options.enabled && options.authStatus() === "AUTHENTICATED"
      ? "AUTHENTICATED"
      : "NOT_STARTED";
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get pollIntervalMs(): number {
    return this.intervalMs;
  }

  get staleAfterMs(): number {
    return Math.max(15_000, this.intervalMs * 3);
  }

  getBrowserStatus(): BrowserStatus {
    return this.runtimeState;
  }

  getReadState(): FuturesReadState {
    return {
      status: this.lastReadStatus,
      health: this.lastReadHealth,
      browserStatus: this.runtimeState,
      consecutiveReadFailures: this.consecutiveReadFailures,
      updatedAt: this.lastReadAttemptAt,
    };
  }

  getReadDiagnostics(): FuturesReadDiagnostics {
    return {
      ...this.latestDiagnostics,
      evidence: { ...this.latestDiagnostics.evidence },
      missingFields: [...this.latestDiagnostics.missingFields],
    };
  }

  getSelectorDriftObservation(): SelectorDriftObservation {
    return {
      suspected: this.selectorDrift.suspected,
      consecutiveEvidenceFailures: this.selectorDrift.consecutiveEvidenceFailures,
      missingFields: [...this.selectorDrift.missingFields],
    };
  }

  getLastSuccessfulSnapshotUpdatedAt(): string | null {
    return this.latest?.updatedAt ?? null;
  }

  getLastReadAttemptAt(): string | null {
    return this.hasPerformedRead ? this.lastReadAttemptAt : null;
  }

  getLatestSnapshot(now: Date | number | string = this.now()): KcexFuturesSnapshot | null {
    if (!this.latest) return null;
    return applySnapshotFreshness(this.latest, now, {
      forceStale: this.forceLatestStale,
      staleAfterMs: this.staleAfterMs,
    });
  }

  start(): void {
    if (!this.options.enabled) {
      this.runtimeState = "NOT_STARTED";
      return;
    }
    if (this.options.authStatus() !== "AUTHENTICATED" || this.timer) return;
    this.runtimeState = "AUTHENTICATED";
    this.forceLatestStale = this.latest !== null;
    this.lifecycleGeneration += 1;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(status?: FuturesReadStatus): void {
    this.lifecycleGeneration += 1;
    if (status) this.updateReadState(status, "UNKNOWN", this.lastReadAttemptAt);
    const wasRunning = this.timer !== null
      || this.runtimeState === "AUTHENTICATED"
      || this.runtimeState === "READING"
      || this.runtimeState === "DEGRADED"
      || this.latest !== null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.options.enabled) {
      this.runtimeState = wasRunning ? "STOPPED" : "NOT_STARTED";
      if (this.latest) this.forceLatestStale = true;
    } else {
      this.runtimeState = "NOT_STARTED";
    }
  }

  async pollOnce(): Promise<FuturesSnapshotResult | null> {
    if (!this.options.enabled || this.pollInProgress) return null;
    if (this.options.authStatus() !== "AUTHENTICATED") {
      this.stop(readStatusForAuth(this.options.authStatus()));
      return null;
    }
    this.pollInProgress = true;
    this.hasPerformedRead = true;
    this.lastReadAttemptAt = this.now().toISOString();
    const generation = this.lifecycleGeneration;
    try {
      let adapterResult: FuturesSnapshotResult;
      try {
        adapterResult = await this.options.adapter.readSnapshot();
      } catch {
        adapterResult = {
          status: "UNKNOWN",
          reason: "Read-only futures read failed.",
          diagnostics: emptyDiagnostics,
        };
      }
      if (generation !== this.lifecycleGeneration || this.options.authStatus() !== "AUTHENTICATED") return null;
      let result = adapterResult;
      if (adapterResult.snapshot) {
        try {
          assertFuturesSourceConsistency(adapterResult.snapshot);
        } catch {
          result = { status: "UNKNOWN", reason: "Mixed futures data sources were rejected.", diagnostics: emptyDiagnostics };
        }
      }
      this.latestDiagnostics = result.diagnostics ?? emptyDiagnostics;
      this.updateSelectorDrift(result);
      if (result.snapshot) {
        this.latest = result.snapshot;
        this.forceLatestStale = false;
        this.consecutiveReadFailures = result.status === "READY" || result.status === "PARTIAL"
          ? 0
          : this.consecutiveReadFailures + 1;
        this.publishSnapshot(result.snapshot);
      } else {
        this.consecutiveReadFailures += 1;
        if (result.status === "UNKNOWN") this.forceLatestStale = this.latest !== null;
      }
      const readHealth = result.snapshot?.health ?? "UNKNOWN";
      const readStateUpdatedAt = this.lastReadAttemptAt;
      this.updateReadState(result.status, readHealth, readStateUpdatedAt);
      const terminal = result.status === "SESSION_LOST"
        || result.status === "SYMBOL_MISMATCH"
        || result.status === "MANUAL_CHALLENGE"
        || this.selectorDrift.suspected;
      if (terminal) {
        this.stop();
      } else if (result.status === "READY") {
        this.runtimeState = "READING";
      } else {
        this.runtimeState = "DEGRADED";
      }
      this.options.events.publish({
        version: 1,
        type: "futures.read-health",
        timestamp: this.now().toISOString(),
        payload: {
          symbol: "GPS_USDT",
          status: result.status,
          health: readHealth,
          browserStatus: this.getBrowserStatus(),
          source: result.snapshot?.source ?? "KCEX",
          consecutiveReadFailures: this.consecutiveReadFailures,
          updatedAt: readStateUpdatedAt,
        },
      });
      this.options.logger.info({
        symbol: "GPS_USDT",
        readHealth: result.snapshot?.health ?? "UNKNOWN",
        status: result.status,
        consecutiveReadFailures: this.consecutiveReadFailures,
        fieldCount: result.snapshot ? 5 : 0,
      }, "KCEX futures read-only snapshot updated.");
      if (result.status === "SESSION_LOST") await this.options.onRuntimeSignal?.("SESSION_LOST");
      if (result.status === "MANUAL_CHALLENGE") await this.options.onRuntimeSignal?.("MANUAL_CHALLENGE");
      return result;
    } finally {
      this.pollInProgress = false;
    }
  }

  private publishSnapshot(snapshot: KcexFuturesSnapshot): void {
    const timestamp = this.now().toISOString();
    this.options.events.publish({ version: 1, type: "futures.snapshot", timestamp, payload: snapshot });
    this.options.events.publish({ version: 1, type: "market.snapshot", timestamp, payload: snapshot.market });
    this.options.events.publish({
      version: 1,
      type: "account.balance",
      timestamp,
      payload: {
        asset: "USDT",
        available: snapshot.account.availableUsdt,
        source: snapshot.account.source,
        health: snapshot.account.health,
        updatedAt: snapshot.account.updatedAt,
      },
    });
    this.options.events.publish({ version: 1, type: "futures.contract", timestamp, payload: snapshot.contract });
    this.options.events.publish({ version: 1, type: "position.changed", timestamp, payload: snapshot.position });
    this.options.events.publish({ version: 1, type: "orders.snapshot", timestamp, payload: snapshot.openOrders });
  }

  private updateReadState(status: FuturesReadStatus, health: ReadHealth, updatedAt: string): void {
    this.lastReadStatus = status;
    this.lastReadHealth = health;
    this.lastReadAttemptAt = updatedAt;
  }

  private updateSelectorDrift(result: FuturesSnapshotResult): void {
    const diagnostics = result.diagnostics;
    const missingFields = diagnostics?.missingFields ?? [];
    const safeToCount = diagnostics?.authenticated === true
      && diagnostics.trustedPage === true
      && diagnostics.loginControlsVisible === false
      && diagnostics.challengeVisible === false
      && missingFields.length > 0;
    if (!safeToCount) {
      if (missingFields.length === 0 && (result.status === "READY" || result.status === "PARTIAL")) {
        this.selectorDrift = { suspected: false, consecutiveEvidenceFailures: 0, missingFields: [] };
      } else if (!this.selectorDrift.suspected) {
        this.selectorDrift = { suspected: false, consecutiveEvidenceFailures: 0, missingFields: [] };
      }
      this.lastMissingEvidenceKey = "";
      return;
    }
    const ordered = [...missingFields].sort();
    const key = ordered.join(",");
    const consecutiveEvidenceFailures = key === this.lastMissingEvidenceKey
      ? this.selectorDrift.consecutiveEvidenceFailures + 1
      : 1;
    this.lastMissingEvidenceKey = key;
    this.selectorDrift = {
      suspected: this.selectorDrift.suspected || consecutiveEvidenceFailures >= 3,
      consecutiveEvidenceFailures,
      missingFields: ordered,
    };
  }
}
