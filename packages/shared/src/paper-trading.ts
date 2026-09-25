import { z } from "zod";
import { TradeSideSchema } from "./storage.js";

const utcTimestampSchema = z.string().datetime();

export const PaperRuntimeStatusSchema = z.enum(["IDLE", "PLANNED", "OPEN", "ERROR"]);
export type PaperRuntimeStatus = z.infer<typeof PaperRuntimeStatusSchema>;

export const PaperCloseReasonSchema = z.enum(["MANUAL", "SIMULATION", "EXTERNAL_SIGNAL"]);
export type PaperCloseReason = z.infer<typeof PaperCloseReasonSchema>;

export const PaperPositionSchema = z.object({
  tradeId: z.string().uuid(),
  symbol: z.literal("GPS_USDT"),
  side: TradeSideSchema,
  marginUsdt: z.number().finite().positive(),
  leverage: z.number().finite().positive(),
  quantity: z.number().finite().positive(),
  entryPrice: z.number().finite().positive(),
  markPrice: z.number().finite().positive().nullable(),
  unrealizedPnl: z.number().finite().nullable(),
  openedAt: utcTimestampSchema,
}).strict();
export type PaperPosition = z.infer<typeof PaperPositionSchema>;

export const PaperTradingStateSchema = z.object({
  status: PaperRuntimeStatusSchema,
  activeTradeId: z.string().uuid().nullable(),
  position: PaperPositionSchema.nullable(),
  updatedAt: utcTimestampSchema,
}).strict().superRefine((state, context) => {
  if (state.status === "OPEN" && (!state.position || state.activeTradeId !== state.position.tradeId)) {
    context.addIssue({ code: "custom", message: "OPEN paper state requires the matching active position." });
  }
  if (state.status === "PLANNED" && (!state.activeTradeId || state.position !== null)) {
    context.addIssue({ code: "custom", message: "PLANNED paper state requires an id and no position." });
  }
  if ((state.status === "IDLE" || state.status === "ERROR") && (state.activeTradeId !== null || state.position !== null)) {
    context.addIssue({ code: "custom", message: "IDLE and ERROR paper states cannot expose an active position." });
  }
});
export type PaperTradingState = z.infer<typeof PaperTradingStateSchema>;

export const TradeOpenedPayloadSchema = z.object({
  tradeId: z.string().uuid(),
  mode: z.literal("PAPER"),
  symbol: z.literal("GPS_USDT"),
  side: TradeSideSchema,
  entryPrice: z.number().finite().positive(),
  quantity: z.number().finite().positive(),
  openedAt: utcTimestampSchema,
}).strict();
export type TradeOpenedPayload = z.infer<typeof TradeOpenedPayloadSchema>;

export const TradeClosedPayloadSchema = z.object({
  tradeId: z.string().uuid(),
  mode: z.literal("PAPER"),
  symbol: z.literal("GPS_USDT"),
  side: TradeSideSchema,
  entryPrice: z.number().finite().positive(),
  exitPrice: z.number().finite().positive(),
  quantity: z.number().finite().positive(),
  realizedPnl: z.number().finite(),
  fees: z.number().finite().nonnegative(),
  closeReason: PaperCloseReasonSchema,
  closedAt: utcTimestampSchema,
}).strict();
export type TradeClosedPayload = z.infer<typeof TradeClosedPayloadSchema>;

export function createIdlePaperTradingState(now = new Date().toISOString()): PaperTradingState {
  return PaperTradingStateSchema.parse({
    status: "IDLE",
    activeTradeId: null,
    position: null,
    updatedAt: now,
  });
}
