import type { RiskContext, RiskDecision, RiskExecutionFailureInput, RiskLimits, RiskMetrics, RiskState, RiskTradeIntent } from "../../../../packages/shared/src/risk.js";
import {
  DEFAULT_RISK_LIMITS,
  RiskExecutionFailureInputSchema,
  RiskLimitsSchema,
  RiskStateSchema,
} from "../../../../packages/shared/src/risk.js";
import { EventBus } from "../realtime/event-bus.js";
import type { StorageService } from "../storage/storage-service.js";
import { KillSwitchService } from "./kill-switch.js";
import { evaluateRisk } from "./risk-engine.js";
import { RiskBlockedError } from "./risk-errors.js";

export interface RiskServiceOptions {
  storage: StorageService;
  events: EventBus;
  killSwitch: KillSwitchService;
  limits?: RiskLimits;
  now?: () => Date;
}

interface RiskReadContext {
  context: RiskContext;
  metrics: RiskMetrics;
}

export class RiskService {
  private readonly now: () => Date;
  private readonly limits: RiskLimits;
  private initialized = false;
  private failureHistoryReliable = true;
  private consecutiveFailures = 0;
  private state: RiskState;

  constructor(private readonly options: RiskServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.limits = RiskLimitsSchema.parse(options.limits ?? DEFAULT_RISK_LIMITS);
    const timestamp = this.timestamp();
    this.state = RiskStateSchema.parse({
      status: "HALTED",
      killSwitch: "UNKNOWN",
      limits: this.limits,
      metrics: {
        mode: "PAPER",
        dateKey: timestamp.slice(0, 10),
        dailyOpenedTrades: null,
        dailyRealizedLossUsdt: null,
        consecutiveFailures: null,
      },
      reasons: ["STORAGE_DEGRADED", "KILL_SWITCH_UNKNOWN"],
      updatedAt: timestamp,
    });
  }

  async initialize(): Promise<RiskState> {
    if (this.initialized) return this.getState();
    this.initialized = true;
    try {
      if (this.options.storage.getHealth().status !== "READY") throw new Error("storage degraded");
      this.restoreConsecutiveFailures();
    } catch {
      this.failureHistoryReliable = false;
    }
    const snapshot = await this.readContext(this.state.metrics.mode);
    this.replaceState(this.stateFor(snapshot.context, snapshot.metrics), true);
    return this.getState();
  }

  getState(): RiskState {
    return RiskStateSchema.parse(this.state);
  }

  async refresh(): Promise<RiskState> {
    if (!this.initialized) return this.initialize();
    const snapshot = await this.readContext();
    this.replaceState(this.stateFor(snapshot.context, snapshot.metrics));
    return this.getState();
  }

  async evaluatePreTrade(
    intent: RiskTradeIntent,
    options: { liveTrading?: boolean; positionState?: RiskContext["positionState"] } = {},
  ): Promise<RiskDecision> {
    if (!this.initialized) await this.initialize();
    const snapshot = await this.readContext(intent.mode, options.positionState);
    snapshot.context.liveTrading = intent.mode === "LIVE" && options.liveTrading === true;
    const decision = evaluateRisk(intent, snapshot.context, this.limits, this.timestamp());
    this.replaceState(this.stateFromDecision(decision, snapshot.context.killSwitch, snapshot.metrics));

    if (!decision.allowed) {
      try {
        this.options.storage.auditEvents.appendAuditEvent({
          category: "RISK",
          eventType: "RISK_BLOCKED",
          severity: "WARN",
          message: "Trade entry blocked by risk policy.",
          payload: {
            mode: intent.mode,
            symbol: intent.symbol,
            side: intent.side,
            marginUsdt: intent.marginUsdt,
            leverage: intent.leverage,
            reasons: decision.reasons,
          },
        });
      } catch {
        this.failureHistoryReliable = false;
        const failClosed = this.stateFromDecision(
          withStorageDegraded(decision, this.timestamp()),
          snapshot.context.killSwitch,
          { ...snapshot.metrics, consecutiveFailures: null },
        );
        this.replaceState(failClosed, true);
      }
      this.options.events.publish({
        version: 1,
        type: "risk.blocked",
        timestamp: this.timestamp(),
        payload: {
          mode: intent.mode,
          symbol: intent.symbol,
          side: intent.side,
          marginUsdt: intent.marginUsdt,
          leverage: intent.leverage,
          reasons: decision.reasons,
        },
      });
      this.publishState();
    }
    return decision;
  }

  /** Read-only preflight for a live arm/slot check; unlike evaluatePreTrade it does not write audit or mutate risk state. */
  async assessPreTrade(
    intent: RiskTradeIntent,
    options: { liveTrading?: boolean; positionState?: RiskContext["positionState"] } = {},
  ): Promise<RiskDecision> {
    if (!this.initialized) await this.initialize();
    const snapshot = await this.readContext(intent.mode, options.positionState);
    snapshot.context.liveTrading = intent.mode === "LIVE" && options.liveTrading === true;
    return evaluateRisk(intent, snapshot.context, this.limits, this.timestamp());
  }

  async assertCanOpen(intent: RiskTradeIntent): Promise<void> {
    const decision = await this.evaluatePreTrade(intent);
    if (!decision.allowed) throw new RiskBlockedError(decision.reasons);
  }

  async recordExecutionFailure(input: RiskExecutionFailureInput = {}): Promise<RiskState> {
    if (!this.initialized) await this.initialize();
    const failure = RiskExecutionFailureInputSchema.parse(input);
    if (failure.executionAttemptId) {
      try {
        if (this.options.storage.auditEvents.hasRiskExecutionOutcome("RISK_EXECUTION_FAILURE", failure.executionAttemptId)) {
          return this.getState();
        }
      } catch {
        this.failureHistoryReliable = false;
      }
    }
    const nextCount = this.consecutiveFailures + 1;
    try {
      this.options.storage.auditEvents.appendAuditEvent({
        category: "RISK",
        eventType: "RISK_EXECUTION_FAILURE",
        severity: "ERROR",
        message: "Execution layer reported a failure.",
        payload: {
          failureKind: failure.failureKind ?? "EXECUTION_FAILED",
          consecutiveFailures: nextCount,
          ...(failure.executionAttemptId ? { executionAttemptId: failure.executionAttemptId } : {}),
        },
      });
      if (this.failureHistoryReliable) this.consecutiveFailures = nextCount;
    } catch {
      this.failureHistoryReliable = false;
    }
    const snapshot = await this.readContext(this.state.metrics.mode);
    this.replaceState(this.stateFor(snapshot.context, snapshot.metrics), true);
    return this.getState();
  }

  async recordExecutionSuccess(
    executionAttemptId?: string,
    livePositionState?: "FLAT" | "OPEN" | "UNKNOWN",
  ): Promise<RiskState> {
    if (!this.initialized) await this.initialize();
    if (executionAttemptId) {
      try {
        if (this.options.storage.auditEvents.hasRiskExecutionOutcome("RISK_EXECUTION_SUCCESS", executionAttemptId)) {
          return this.getState();
        }
      } catch {
        this.failureHistoryReliable = false;
      }
    }
    try {
      this.options.storage.auditEvents.appendAuditEvent({
        category: "RISK",
        eventType: "RISK_EXECUTION_SUCCESS",
        severity: "INFO",
        message: "Execution layer reported success.",
        payload: { consecutiveFailures: 0, ...(executionAttemptId ? { executionAttemptId } : {}) },
      });
      if (this.failureHistoryReliable) this.consecutiveFailures = 0;
    } catch {
      this.failureHistoryReliable = false;
    }
    const snapshot = await this.readContext(this.state.metrics.mode, livePositionState);
    this.replaceState(this.stateFor(snapshot.context, snapshot.metrics), true);
    return this.getState();
  }

  private restoreConsecutiveFailures(): void {
    const limit = Math.min(100, this.limits.maxConsecutiveFailures + 1);
    const events = this.options.storage.auditEvents.listRiskExecutionEvents({ limit });
    let count = 0;
    for (const event of events) {
      if (event.eventType === "RISK_EXECUTION_SUCCESS") break;
      if (event.eventType === "RISK_EXECUTION_FAILURE") count += 1;
    }
    this.consecutiveFailures = count;
  }

  private async readContext(
    mode: RiskMetrics["mode"] = "PAPER",
    livePositionState?: RiskContext["positionState"],
  ): Promise<RiskReadContext> {
    const now = this.clockNow();
    const dateKey = now.toISOString().slice(0, 10);
    const startAt = `${dateKey}T00:00:00.000Z`;
    const endAt = new Date(Date.parse(startAt) + 24 * 60 * 60 * 1000).toISOString();
    const killSwitch = await this.options.killSwitch.getStatus();
    let storageStatus: "READY" | "DEGRADED" = "DEGRADED";
    let positionState: RiskContext["positionState"] = mode === "LIVE" ? livePositionState ?? "UNKNOWN" : "UNKNOWN";
    let dailyOpenedTrades: number | null = null;
    let dailyRealizedLossUsdt: number | null = null;

    try {
      storageStatus = this.options.storage.getHealth().status;
      if (storageStatus === "READY") {
        if (mode === "PAPER") {
          const openTrades = this.options.storage.trades.listOpenPaperTrades({ symbol: "GPS_USDT", limit: 2 });
          positionState = openTrades.length === 0 ? "FLAT" : openTrades.length === 1 ? "OPEN" : "UNKNOWN";
        }
        dailyOpenedTrades = this.options.storage.trades.countOpenedTrades({
          mode, symbol: "GPS_USDT", startAt, endAt,
        });
        dailyRealizedLossUsdt = this.options.storage.trades.sumRealizedLossUsdt({
          mode, symbol: "GPS_USDT", startAt, endAt,
        });
      }
    } catch {
      storageStatus = "DEGRADED";
      positionState = "UNKNOWN";
      dailyOpenedTrades = null;
      dailyRealizedLossUsdt = null;
    }

    const consecutiveFailures = this.failureHistoryReliable ? this.consecutiveFailures : null;
    const context: RiskContext = {
      liveTrading: false,
      killSwitch,
      storageStatus,
      positionState,
      dailyOpenedTrades: storageStatus === "READY" ? dailyOpenedTrades : null,
      dailyRealizedLossUsdt: storageStatus === "READY" ? dailyRealizedLossUsdt : null,
      consecutiveFailures,
    };
    const metrics: RiskMetrics = {
      mode,
      dateKey,
      dailyOpenedTrades: context.dailyOpenedTrades,
      dailyRealizedLossUsdt: context.dailyRealizedLossUsdt,
      consecutiveFailures: context.consecutiveFailures,
    };
    return { context, metrics };
  }

  private stateFor(context: RiskContext, metrics: RiskMetrics): RiskState {
    const decision = evaluateRisk({
      mode: metrics.mode,
      symbol: "GPS_USDT",
      side: "LONG",
      marginUsdt: this.limits.maxMarginUsdt,
      leverage: this.limits.maxLeverage,
    }, context, this.limits, this.timestamp());
    return this.stateFromDecision(decision, context.killSwitch, metrics);
  }

  private stateFromDecision(decision: RiskDecision, killSwitch: RiskState["killSwitch"], metrics: RiskMetrics): RiskState {
    return RiskStateSchema.parse({
      status: decision.status,
      killSwitch,
      limits: this.limits,
      metrics,
      reasons: decision.reasons,
      updatedAt: this.timestamp(),
    });
  }

  private replaceState(state: RiskState, forcePublish = false): void {
    const next = RiskStateSchema.parse(state);
    const changed = stateKey(next) !== stateKey(this.state);
    this.state = next;
    if (forcePublish || changed) this.publishState();
  }

  private publishState(): void {
    this.options.events.publish({
      version: 1,
      type: "risk.state",
      timestamp: this.timestamp(),
      payload: this.getState(),
    });
  }

  private timestamp(): string {
    return this.clockNow().toISOString();
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Risk clock is invalid.");
    return value;
  }
}

function stateKey(state: RiskState): string {
  return JSON.stringify({ ...state, updatedAt: "" });
}

function withStorageDegraded(decision: RiskDecision, evaluatedAt: string): RiskDecision {
  const reasons = decision.reasons.includes("STORAGE_DEGRADED")
    ? decision.reasons
    : [...decision.reasons, "STORAGE_DEGRADED" as const];
  return {
    allowed: false,
    status: "HALTED",
    reasons,
    evaluatedAt,
  };
}
