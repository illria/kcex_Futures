import { z } from "zod";

export const RiskStatusSchema = z.enum(["READY", "BLOCKED", "HALTED"]);
export type RiskStatus = z.infer<typeof RiskStatusSchema>;

export const KillSwitchStatusSchema = z.enum(["CLEAR", "ENGAGED", "UNKNOWN"]);
export type KillSwitchStatus = z.infer<typeof KillSwitchStatusSchema>;

export const RiskPositionStateSchema = z.enum(["FLAT", "OPEN", "UNKNOWN"]);
export type RiskPositionState = z.infer<typeof RiskPositionStateSchema>;

export const RiskReasonCodeSchema = z.enum([
  "LIVE_TRADING_DISABLED",
  "SYMBOL_NOT_ALLOWED",
  "MARGIN_LIMIT",
  "LEVERAGE_LIMIT",
  "POSITION_OPEN",
  "POSITION_UNKNOWN",
  "DAILY_TRADE_LIMIT",
  "DAILY_LOSS_LIMIT",
  "CONSECUTIVE_FAILURE_LIMIT",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "STORAGE_DEGRADED",
]);
export type RiskReasonCode = z.infer<typeof RiskReasonCodeSchema>;

export const RiskTradeIntentSchema = z.object({
  mode: z.enum(["PAPER", "LIVE"]),
  symbol: z.string().trim().min(1).max(64),
  side: z.enum(["LONG", "SHORT"]),
  marginUsdt: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
}).strict();
export type RiskTradeIntent = z.infer<typeof RiskTradeIntentSchema>;

export const RiskLimitsSchema = z.object({
  maxMarginUsdt: z.number().finite().positive().max(50),
  maxLeverage: z.number().finite().positive().max(10),
  maxDailyTrades: z.number().int().min(1).max(10),
  maxDailyLossUsdt: z.number().finite().positive().max(50),
  maxConsecutiveFailures: z.number().int().min(1).max(3),
}).strict();
export type RiskLimits = z.infer<typeof RiskLimitsSchema>;

export const RiskContextSchema = z.object({
  liveTrading: z.literal(false),
  killSwitch: KillSwitchStatusSchema,
  storageStatus: z.enum(["READY", "DEGRADED"]),
  positionState: RiskPositionStateSchema,
  dailyOpenedTrades: z.number().int().nonnegative().nullable(),
  dailyRealizedLossUsdt: z.number().finite().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative().nullable(),
}).strict();
export type RiskContext = z.infer<typeof RiskContextSchema>;

const utcDateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

export const RiskMetricsSchema = z.object({
  mode: z.literal("PAPER"),
  dateKey: utcDateKeySchema,
  dailyOpenedTrades: z.number().int().nonnegative().nullable(),
  dailyRealizedLossUsdt: z.number().finite().nonnegative().nullable(),
  consecutiveFailures: z.number().int().nonnegative().nullable(),
}).strict();
export type RiskMetrics = z.infer<typeof RiskMetricsSchema>;

export const RiskDecisionSchema = z.object({
  allowed: z.boolean(),
  status: RiskStatusSchema,
  reasons: z.array(RiskReasonCodeSchema),
  evaluatedAt: z.string().datetime(),
}).strict().superRefine((decision, context) => {
  if (decision.allowed !== (decision.reasons.length === 0)) {
    context.addIssue({ code: "custom", message: "Risk decision allow state must match its reasons." });
  }
  if ((decision.allowed && decision.status !== "READY") || (!decision.allowed && decision.status === "READY")) {
    context.addIssue({ code: "custom", message: "Risk decision status must match its allow state." });
  }
});
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

export const RiskStateSchema = z.object({
  status: RiskStatusSchema,
  killSwitch: KillSwitchStatusSchema,
  limits: RiskLimitsSchema,
  metrics: RiskMetricsSchema,
  reasons: z.array(RiskReasonCodeSchema),
  updatedAt: z.string().datetime(),
}).strict();
export type RiskState = z.infer<typeof RiskStateSchema>;

export const RiskExecutionFailureInputSchema = z.object({
  failureKind: z.enum(["EXECUTION_FAILED", "TIMEOUT", "UNKNOWN_RESULT", "STORAGE_ERROR"]).optional(),
}).strict();
export type RiskExecutionFailureInput = z.infer<typeof RiskExecutionFailureInputSchema>;

export const DEFAULT_RISK_LIMITS: RiskLimits = Object.freeze({
  maxMarginUsdt: 50,
  maxLeverage: 10,
  maxDailyTrades: 10,
  maxDailyLossUsdt: 50,
  maxConsecutiveFailures: 3,
});
