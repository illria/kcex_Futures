import {
  RiskContextSchema,
  RiskDecisionSchema,
  RiskLimitsSchema,
  RiskTradeIntentSchema,
  type RiskContext,
  type RiskDecision,
  type RiskLimits,
  type RiskReasonCode,
  type RiskTradeIntent,
} from "../../../../packages/shared/src/risk.js";

const HALTING_REASONS = new Set<RiskReasonCode>([
  "POSITION_UNKNOWN",
  "CONSECUTIVE_FAILURE_LIMIT",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "STORAGE_DEGRADED",
]);

/** Deterministic policy evaluation. This module has no I/O or runtime dependencies. */
export function evaluateRisk(
  intentInput: RiskTradeIntent,
  contextInput: RiskContext,
  limitsInput: RiskLimits,
  evaluatedAt: string,
): RiskDecision {
  const intent = RiskTradeIntentSchema.parse(intentInput);
  const context = RiskContextSchema.parse(contextInput);
  const limits = RiskLimitsSchema.parse(limitsInput);
  const reasons: RiskReasonCode[] = [];
  const add = (reason: RiskReasonCode) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  if (intent.mode === "LIVE") add("LIVE_TRADING_DISABLED");
  if (intent.symbol !== "GPS_USDT") add("SYMBOL_NOT_ALLOWED");
  if (intent.marginUsdt > limits.maxMarginUsdt) add("MARGIN_LIMIT");
  if (intent.leverage > limits.maxLeverage) add("LEVERAGE_LIMIT");
  if (context.positionState === "OPEN") add("POSITION_OPEN");
  if (context.positionState === "UNKNOWN") add("POSITION_UNKNOWN");
  if (context.dailyOpenedTrades === null || context.dailyRealizedLossUsdt === null) {
    add("STORAGE_DEGRADED");
  } else {
    if (context.dailyOpenedTrades >= limits.maxDailyTrades) add("DAILY_TRADE_LIMIT");
    if (context.dailyRealizedLossUsdt >= limits.maxDailyLossUsdt) add("DAILY_LOSS_LIMIT");
  }
  if (context.consecutiveFailures === null) add("STORAGE_DEGRADED");
  else if (context.consecutiveFailures >= limits.maxConsecutiveFailures) add("CONSECUTIVE_FAILURE_LIMIT");
  if (context.killSwitch === "ENGAGED") add("KILL_SWITCH_ENGAGED");
  if (context.killSwitch === "UNKNOWN") add("KILL_SWITCH_UNKNOWN");
  if (context.storageStatus === "DEGRADED") add("STORAGE_DEGRADED");

  const allowed = reasons.length === 0;
  const halted = reasons.some((reason) => HALTING_REASONS.has(reason));
  return RiskDecisionSchema.parse({
    allowed,
    status: allowed ? "READY" : halted ? "HALTED" : "BLOCKED",
    reasons,
    evaluatedAt,
  });
}
