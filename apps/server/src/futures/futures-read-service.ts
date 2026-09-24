import type { Logger } from "pino";
import { applySnapshotFreshness } from "../../../../packages/shared/src/freshness.js";
import { assertFuturesSourceConsistency } from "../../../../packages/shared/src/futures-invariants.js";
import type { AuthStatus, BrowserStatus, KcexFuturesSnapshot } from "../../../../packages/shared/src/protocol.js";
import { EventBus } from "../realtime/event-bus.js";
import type { FuturesReadAdapter, FuturesSnapshotResult } from "./kcex-futures-read-adapter.js";

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

  constructor(private readonly options: FuturesReadServiceOptions) {
    this.intervalMs = normalizePollInterval(options.pollMs);
    this.now = options.now ?? (() => new Date());
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

  getBrowserStatus(): BrowserStatus {
    return this.runtimeState;
  }

  getLatestSnapshot(now: Date | number | string = this.now()): KcexFuturesSnapshot | null {
    if (!this.latest) return null;
    return applySnapshotFreshness(this.latest, now, { forceStale: this.forceLatestStale });
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

  stop(): void {
    this.lifecycleGeneration += 1;
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
      this.stop();
      return null;
    }
    this.pollInProgress = true;
    const generation = this.lifecycleGeneration;
    try {
      const adapterResult = await this.options.adapter.readSnapshot();
      if (generation !== this.lifecycleGeneration || this.options.authStatus() !== "AUTHENTICATED") return null;
      let result = adapterResult;
      if (adapterResult.snapshot) {
        try {
          assertFuturesSourceConsistency(adapterResult.snapshot);
        } catch {
          result = { status: "UNKNOWN", reason: "Mixed futures data sources were rejected." };
        }
      }
      if (result.snapshot) {
        this.latest = result.snapshot;
        this.forceLatestStale = false;
        this.consecutiveReadFailures = result.status === "READY" || result.status === "PARTIAL"
          ? 0
          : this.consecutiveReadFailures + 1;
        this.publishSnapshot(result.snapshot);
      } else {
        this.consecutiveReadFailures += 1;
      }
      const trustedHostFailure = /trusted KCEX host|official KCEX host|untrusted/i.test(result.reason ?? "");
      const terminal = result.status === "SESSION_LOST"
        || result.status === "SYMBOL_MISMATCH"
        || result.status === "MANUAL_CHALLENGE"
        || trustedHostFailure;
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
          health: result.snapshot?.health ?? "UNKNOWN",
          source: result.snapshot?.source ?? "KCEX",
          consecutiveReadFailures: this.consecutiveReadFailures,
          updatedAt: this.now().toISOString(),
        },
      });
      this.options.logger.info({
        symbol: "GPS_USDT",
        readHealth: result.snapshot?.health ?? "UNKNOWN",
        status: result.status,
        consecutiveReadFailures: this.consecutiveReadFailures,
        fieldCount: result.snapshot ? 5 : 0,
      }, "KCEX futures read-only snapshot updated.");
      return result;
    } finally {
      this.pollInProgress = false;
    }
  }

  private publishSnapshot(snapshot: KcexFuturesSnapshot): void {
    const timestamp = this.now().toISOString();
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
}
