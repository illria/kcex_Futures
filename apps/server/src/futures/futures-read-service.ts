import type { Logger } from "pino";
import type { AuthStatus, KcexFuturesSnapshot } from "../../../../packages/shared/src/protocol.js";
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

  constructor(private readonly options: FuturesReadServiceOptions) {
    this.intervalMs = normalizePollInterval(options.pollMs);
    this.now = options.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get pollIntervalMs(): number {
    return this.intervalMs;
  }

  getLatestSnapshot(): KcexFuturesSnapshot | null {
    return this.latest;
  }

  start(): void {
    if (!this.options.enabled || this.options.authStatus() !== "AUTHENTICATED" || this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<FuturesSnapshotResult | null> {
    if (!this.options.enabled || this.options.authStatus() !== "AUTHENTICATED" || this.pollInProgress) return null;
    this.pollInProgress = true;
    try {
      const result = await this.options.adapter.readSnapshot();
      if (result.snapshot) {
        this.latest = result.snapshot;
        this.consecutiveReadFailures = result.status === "READY" || result.status === "PARTIAL"
          ? 0
          : this.consecutiveReadFailures + 1;
        this.publishSnapshot(result.snapshot);
      } else {
        this.consecutiveReadFailures += 1;
      }
      this.options.events.publish({
        version: 1,
        type: "futures.read-health",
        timestamp: this.now().toISOString(),
        payload: {
          symbol: "GPS_USDT",
          status: result.status,
          health: result.snapshot?.health ?? "UNKNOWN",
          source: "KCEX",
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
      const trustedHostFailure = /trusted KCEX host|official KCEX host|untrusted/i.test(result.reason ?? "");
      if (result.status === "SESSION_LOST" || result.status === "SYMBOL_MISMATCH" || result.status === "MANUAL_CHALLENGE" || trustedHostFailure) {
        this.stop();
      }
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
        source: "KCEX",
        health: snapshot.account.health,
        updatedAt: snapshot.account.updatedAt,
      },
    });
    this.options.events.publish({ version: 1, type: "futures.contract", timestamp, payload: snapshot.contract });
    this.options.events.publish({ version: 1, type: "position.changed", timestamp, payload: snapshot.position });
    this.options.events.publish({ version: 1, type: "orders.snapshot", timestamp, payload: snapshot.openOrders });
  }
}
