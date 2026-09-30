import type { Logger } from "pino";
import {
  ResilienceStateSchema,
  type AuthStatus,
  type BrowserHealthInspection,
  type ResilienceReasonCode,
  type ResilienceState,
  type ResilienceStatus,
} from "../../../../packages/shared/src/protocol.js";
import { EventBus } from "../realtime/event-bus.js";
import type { AuthService } from "../auth/auth-service.js";
import type { FuturesReadService } from "../futures/futures-read-service.js";
import type { StorageService } from "../storage/storage-service.js";
import { ResilienceRuntimeError } from "./resilience-errors.js";

export const RESILIENCE_RECOVERY_INTERVAL_MS = 5_000;
export const RESILIENCE_RECOVERY_COOLDOWN_MS = 1_000;
export const RESILIENCE_READ_FAILURE_LIMIT = 3;

export interface RuntimeResilienceServiceOptions {
  auth: AuthService;
  futuresRead?: FuturesReadService;
  storage: StorageService;
  events: EventBus;
  logger: Logger;
  intervalMs?: number;
  now?: () => Date;
  onStateChange?: (state: ResilienceState) => void | Promise<void>;
}

const safeUnavailableBrowser: BrowserHealthInspection = {
  browserConnected: false,
  pageAvailable: false,
  pageClosed: false,
  trustedPage: false,
};

function reasonsForAuth(status: AuthStatus): { status: ResilienceStatus; reasons: ResilienceReasonCode[] } | null {
  if (status === "SESSION_LOST") return { status: "MANUAL_ACTION", reasons: ["AUTH_SESSION_LOST"] };
  if (status === "OTP_REQUIRED") return { status: "MANUAL_ACTION", reasons: ["OTP_REQUIRED"] };
  if (status === "MANUAL_CHALLENGE") return { status: "MANUAL_ACTION", reasons: ["MANUAL_CHALLENGE"] };
  if (status === "AUTH_UNKNOWN") return { status: "DEGRADED", reasons: ["AUTH_UNKNOWN"] };
  return null;
}

function stateFingerprint(state: ResilienceState): string {
  return JSON.stringify({
    status: state.status,
    reasons: state.reasons,
    authStatus: state.authStatus,
    browserStatus: state.browserStatus,
    browserHealth: state.browserHealth,
    readStatus: state.readStatus,
    readHealth: state.readHealth,
    consecutiveReadFailures: state.consecutiveReadFailures,
    selectorDrift: state.selectorDrift,
    storageStatus: state.storageStatus,
    lastReadAttemptAt: state.lastReadAttemptAt,
  });
}

function substantiveFingerprint(state: ResilienceState): string {
  return JSON.stringify({
    status: state.status,
    reasons: state.reasons,
    browserStatus: state.browserStatus,
    browserHealth: state.browserHealth,
    readStatus: state.readStatus,
    readHealth: state.readHealth,
    consecutiveReadFailures: state.consecutiveReadFailures,
    selectorDrift: state.selectorDrift,
    storageStatus: state.storageStatus,
  });
}

export class RuntimeResilienceService {
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ResilienceState> | null = null;
  private previousStateFingerprint = "";
  private lastAuditFingerprint = "";
  private lastRecoveryStartMs: number | null = null;
  private lastHealthyAt: string | null = null;
  private lastRecoveryAt: string | null = null;
  private state: ResilienceState;

  constructor(private readonly options: RuntimeResilienceServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? RESILIENCE_RECOVERY_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000 || this.intervalMs > 60_000) {
      throw new RangeError("Resilience observation interval must be from one to sixty seconds.");
    }
    const now = this.clockNow().toISOString();
    const auth = options.auth.getState();
    const staleAfterMs = options.futuresRead?.staleAfterMs ?? 15_000;
    this.state = ResilienceStateSchema.parse({
      status: auth.authProvider === "FAKE" || !options.futuresRead?.enabled ? "IDLE" : "DEGRADED",
      reasons: [],
      authStatus: auth.status,
      browserStatus: options.futuresRead?.getBrowserStatus() ?? "NOT_STARTED",
      browserHealth: safeUnavailableBrowser,
      readStatus: options.futuresRead?.getReadState().status ?? null,
      readHealth: options.futuresRead?.getReadState().health ?? "UNKNOWN",
      consecutiveReadFailures: options.futuresRead?.getReadState().consecutiveReadFailures ?? 0,
      lastReadAttemptAt: options.futuresRead?.getLastReadAttemptAt() ?? null,
      lastHealthyAt: null,
      lastRecoveryAt: null,
      selectorDrift: options.futuresRead?.getSelectorDriftObservation() ?? {
        suspected: false,
        consecutiveEvidenceFailures: 0,
        missingFields: [],
      },
      storageStatus: options.storage.getHealth().status,
      readStaleAfterMs: staleAfterMs,
      automaticLogin: false,
      automaticTrading: false,
      updatedAt: now,
    });
  }

  getState(): ResilienceState {
    return ResilienceStateSchema.parse(this.state);
  }

  start(): void {
    if (this.timer) return;
    this.scheduleRecovery();
    this.timer = setInterval(() => this.scheduleRecovery(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recover(): Promise<ResilienceState> {
    if (this.inFlight) return this.inFlight;
    const nowMs = this.clockNow().getTime();
    if (this.lastRecoveryStartMs !== null && nowMs - this.lastRecoveryStartMs < RESILIENCE_RECOVERY_COOLDOWN_MS) {
      return Promise.resolve(this.getState());
    }
    this.lastRecoveryStartMs = nowMs;
    const operation = this.observeAndUpdate().finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    });
    this.inFlight = operation;
    return operation;
  }

  private async observeAndUpdate(): Promise<ResilienceState> {
    const now = this.clockNow();
    const nowIso = now.toISOString();
    this.lastRecoveryAt = nowIso;
    const auth = this.options.auth.getState();
    const read = this.options.futuresRead;
    const readState = read?.getReadState();
    const selectorDrift = read?.getSelectorDriftObservation() ?? {
      suspected: false,
      consecutiveEvidenceFailures: 0,
      missingFields: [],
    };
    const staleAfterMs = read?.staleAfterMs ?? 15_000;
    let browserHealth = safeUnavailableBrowser;
    try {
      browserHealth = this.options.auth.inspectBrowserHealth();
    } catch {
      browserHealth = safeUnavailableBrowser;
    }
    let storageStatus: "READY" | "DEGRADED" = "DEGRADED";
    try {
      storageStatus = this.options.storage.getHealth().status;
    } catch {
      storageStatus = "DEGRADED";
    }

    let status: ResilienceStatus = "IDLE";
    let reasons: ResilienceReasonCode[] = [];
    if (auth.authProvider !== "FAKE" && read?.enabled) {
      const authIssue = reasonsForAuth(auth.status);
      if (authIssue) {
        status = authIssue.status;
        reasons = authIssue.reasons;
      } else if (auth.status === "AUTHENTICATED") {
        if (storageStatus !== "READY") {
          status = "HALTED";
          reasons = ["STORAGE_DEGRADED"];
        } else if (!browserHealth.browserConnected) {
          status = "HALTED";
          reasons = ["BROWSER_DISCONNECTED"];
        } else if (browserHealth.pageClosed || !browserHealth.pageAvailable) {
          status = "HALTED";
          reasons = ["PAGE_UNAVAILABLE"];
        } else if (!browserHealth.trustedPage) {
          status = "HALTED";
          reasons = ["UNTRUSTED_HOST"];
        } else if (selectorDrift.suspected) {
          status = "MANUAL_ACTION";
          reasons = ["SELECTOR_DRIFT_SUSPECTED"];
        } else if (readState?.status === "SESSION_LOST") {
          status = "MANUAL_ACTION";
          reasons = ["AUTH_SESSION_LOST"];
        } else if (readState?.status === "MANUAL_CHALLENGE") {
          status = "MANUAL_ACTION";
          reasons = ["MANUAL_CHALLENGE"];
        } else if (readState?.status === "SYMBOL_MISMATCH") {
          status = "HALTED";
          reasons = ["SYMBOL_MISMATCH"];
        } else {
          const snapshotAt = read?.getLastSuccessfulSnapshotUpdatedAt();
          const elapsedFromSnapshot = snapshotAt ? now.getTime() - Date.parse(snapshotAt) : Number.POSITIVE_INFINITY;
          const elapsedFromAttempt = readState ? now.getTime() - Date.parse(readState.updatedAt) : Number.POSITIVE_INFINITY;
          const stale = readState?.status === "READY" || readState?.status === "PARTIAL"
            ? !Number.isFinite(elapsedFromSnapshot) || elapsedFromSnapshot >= staleAfterMs
            : elapsedFromAttempt >= staleAfterMs;
          if (!snapshotAt && read?.getBrowserStatus() === "AUTHENTICATED"
            && Number.isFinite(elapsedFromAttempt) && elapsedFromAttempt < staleAfterMs
            && (readState?.consecutiveReadFailures ?? 0) === 0) {
            status = "DEGRADED";
            reasons = [];
          } else if (readState && readState.consecutiveReadFailures >= RESILIENCE_READ_FAILURE_LIMIT) {
            status = "DEGRADED";
            reasons = ["READ_FAILURE_LIMIT"];
          } else if (readState?.status === "UNKNOWN") {
            status = "DEGRADED";
            reasons = ["READ_FAILURE"];
          } else if (!snapshotAt && stale) {
            status = "DEGRADED";
            reasons = ["READ_STALE"];
          } else if (stale) {
            status = "DEGRADED";
            reasons = ["READ_STALE"];
          } else if (readState && (readState.status === "READY" || readState.status === "PARTIAL")
            && readState.health !== "UNKNOWN") {
            status = "HEALTHY";
            reasons = [];
          } else {
            status = "DEGRADED";
            reasons = ["READ_STALE"];
          }
        }
      }
    }

    const shouldStopRead = status === "HALTED"
      || status === "MANUAL_ACTION"
      || reasons.includes("READ_FAILURE_LIMIT");
    if (shouldStopRead && read
      && read.getBrowserStatus() !== "STOPPED" && read.getBrowserStatus() !== "NOT_STARTED") {
      read.stop();
    }

    if (status === "HEALTHY" && this.state.status !== "HEALTHY") this.lastHealthyAt = nowIso;
    const next = ResilienceStateSchema.parse({
      status,
      reasons,
      authStatus: auth.status,
      browserStatus: read?.getBrowserStatus() ?? "NOT_STARTED",
      browserHealth,
      readStatus: readState?.status ?? null,
      readHealth: readState?.health ?? "UNKNOWN",
      consecutiveReadFailures: readState?.consecutiveReadFailures ?? 0,
      lastReadAttemptAt: read?.getLastReadAttemptAt() ?? null,
      lastHealthyAt: this.lastHealthyAt,
      lastRecoveryAt: this.lastRecoveryAt,
      selectorDrift,
      storageStatus,
      readStaleAfterMs: staleAfterMs,
      automaticLogin: false,
      automaticTrading: false,
      updatedAt: nowIso,
    });
    const nextFingerprint = stateFingerprint(next);
    const oldSubstantive = substantiveFingerprint(this.state);
    const nextSubstantive = substantiveFingerprint(next);
    this.state = next;
    if (nextFingerprint !== this.previousStateFingerprint) {
      this.previousStateFingerprint = nextFingerprint;
      this.options.events.publish({ version: 1, type: "resilience.state", timestamp: nowIso, payload: next });
    }
    if (nextSubstantive !== oldSubstantive) {
      this.options.logger.info({ resilienceStatus: next.status, reasonCodes: next.reasons }, "Runtime resilience state changed.");
      try {
        await this.options.onStateChange?.(next);
      } catch {
        this.options.logger.warn({ resilienceStatus: next.status }, "Scheduler did not receive the resilience state transition.");
      }
    }
    this.auditTransition(next, nextSubstantive, oldSubstantive);
    return this.getState();
  }

  private auditTransition(next: ResilienceState, fingerprint: string, previousFingerprint: string): void {
    if (fingerprint === previousFingerprint || fingerprint === this.lastAuditFingerprint) return;
    if (!this.options.storage.isReady || this.state.storageStatus !== "READY") return;
    try {
      this.options.storage.auditEvents.appendAuditEvent({
        category: "RESILIENCE",
        eventType: "RESILIENCE_STATE_CHANGED",
        severity: next.status === "HALTED" || next.status === "MANUAL_ACTION" ? "ERROR" : "INFO",
        message: "Runtime resilience state changed.",
        payload: {
          currentStatus: next.status,
          reasons: next.reasons,
          browserStatus: next.browserStatus,
          readStatus: next.readStatus,
          readHealth: next.readHealth,
          selectorDriftSuspected: next.selectorDrift.suspected,
          consecutiveEvidenceFailures: next.selectorDrift.consecutiveEvidenceFailures,
          storageStatus: next.storageStatus,
        },
      });
      this.lastAuditFingerprint = fingerprint;
    } catch (error) {
      const errorName = error instanceof Error ? error.name.slice(0, 48) : "UNKNOWN";
      this.options.logger.warn(
        { resilienceStatus: next.status, errorName },
        "Runtime resilience transition could not be audited.",
      );
    }
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ResilienceRuntimeError("RESILIENCE_CLOCK_INVALID");
    }
    return value;
  }

  private scheduleRecovery(): void {
    void this.recover().catch(() => {
      this.options.logger.warn({ errorCode: "RESILIENCE_OBSERVATION_FAILED" }, "Runtime resilience observation failed safely.");
    });
  }
}
