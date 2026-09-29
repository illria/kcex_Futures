import { z } from "zod";

export const ProtectionBasisSchema = z.enum(["PRICE_PCT", "ROI_PCT"]);
export type ProtectionBasis = z.infer<typeof ProtectionBasisSchema>;

export const ProtectionLegTypeSchema = z.enum(["TAKE_PROFIT", "STOP_LOSS"]);
export type ProtectionLegType = z.infer<typeof ProtectionLegTypeSchema>;

export const ProtectionStatusSchema = z.enum([
  "NONE",
  "PREVIEW_READY",
  "PLANNED",
  "ACTIVE",
  "TRIGGERED_TP",
  "TRIGGERED_SL",
  "UNKNOWN",
  "ERROR",
]);
export type ProtectionStatus = z.infer<typeof ProtectionStatusSchema>;

export const DurableProtectionStatusSchema = z.enum([
  "PLANNED",
  "ACTIVE",
  "TRIGGERED_TP",
  "TRIGGERED_SL",
  "UNKNOWN",
  "ERROR",
]);
export type DurableProtectionStatus = z.infer<typeof DurableProtectionStatusSchema>;

export const ProtectionBasisValueSchema = z.discriminatedUnion("basis", [
  z.object({ basis: z.literal("PRICE_PCT"), value: z.number().finite().min(0.01).max(99) }).strict(),
  z.object({ basis: z.literal("ROI_PCT"), value: z.number().finite().min(0.1).max(500) }).strict(),
]);
export type ProtectionBasisValue = z.infer<typeof ProtectionBasisValueSchema>;

export const ProtectionIntentSchema = z.object({
  executionAttemptId: z.string().uuid(),
  takeProfit: ProtectionBasisValueSchema,
  stopLoss: ProtectionBasisValueSchema,
}).strict();
export type ProtectionIntent = z.infer<typeof ProtectionIntentSchema>;

export const ProtectionPriceLegSchema = z.discriminatedUnion("basis", [
  z.object({
    basis: z.literal("PRICE_PCT"),
    value: z.number().finite().min(0.01).max(99),
    targetPrice: z.number().finite().positive(),
  }).strict(),
  z.object({
    basis: z.literal("ROI_PCT"),
    value: z.number().finite().min(0.1).max(500),
    targetPrice: z.number().finite().positive(),
  }).strict(),
]);
export type ProtectionPriceLeg = z.infer<typeof ProtectionPriceLegSchema>;

export const ProtectionPlanSchema = z.object({
  id: z.string().uuid(),
  executionAttemptId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  entryPrice: z.number().finite().positive(),
  positionSize: z.number().finite().positive(),
  leverage: z.number().finite().positive().max(10),
  takeProfit: ProtectionPriceLegSchema,
  stopLoss: ProtectionPriceLegSchema,
  status: DurableProtectionStatusSchema,
  triggeredLeg: ProtectionLegTypeSchema.nullable(),
  fixtureProtectionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  triggeredAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
}).strict().superRefine((plan, context) => {
  const directionValid = plan.side === "LONG"
    ? plan.takeProfit.targetPrice > plan.entryPrice && plan.stopLoss.targetPrice < plan.entryPrice
    : plan.takeProfit.targetPrice < plan.entryPrice && plan.stopLoss.targetPrice > plan.entryPrice;
  if (!directionValid || plan.takeProfit.targetPrice === plan.stopLoss.targetPrice) {
    context.addIssue({ code: "custom", path: ["takeProfit"], message: "Protection targets must be positive and on the correct side of entry." });
  }
  if (plan.status === "ACTIVE" && (!plan.activatedAt || !plan.fixtureProtectionId)) {
    context.addIssue({ code: "custom", path: ["status"], message: "ACTIVE requires fixture activation evidence." });
  }
  if ((plan.status === "TRIGGERED_TP" || plan.status === "TRIGGERED_SL") && (!plan.triggeredAt || !plan.triggeredLeg)) {
    context.addIssue({ code: "custom", path: ["status"], message: "TRIGGERED requires a leg and timestamp." });
  }
  if (plan.status === "TRIGGERED_TP" && plan.triggeredLeg !== "TAKE_PROFIT") {
    context.addIssue({ code: "custom", path: ["triggeredLeg"], message: "TP trigger must name TAKE_PROFIT." });
  }
  if (plan.status === "TRIGGERED_SL" && plan.triggeredLeg !== "STOP_LOSS") {
    context.addIssue({ code: "custom", path: ["triggeredLeg"], message: "SL trigger must name STOP_LOSS." });
  }
});
export type ProtectionPlan = z.infer<typeof ProtectionPlanSchema>;

export const ProtectionPreviewSchema = z.object({
  previewId: z.string().uuid(),
  executionAttemptId: z.string().uuid(),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  entryPrice: z.number().finite().positive(),
  positionSize: z.number().finite().positive(),
  leverage: z.number().finite().positive().max(10),
  takeProfit: ProtectionPriceLegSchema,
  stopLoss: ProtectionPriceLegSchema,
  expiresAt: z.string().datetime(),
}).strict().superRefine((preview, context) => {
  const directionValid = preview.side === "LONG"
    ? preview.takeProfit.targetPrice > preview.entryPrice && preview.stopLoss.targetPrice < preview.entryPrice
    : preview.takeProfit.targetPrice < preview.entryPrice && preview.stopLoss.targetPrice > preview.entryPrice;
  if (!directionValid || preview.takeProfit.targetPrice === preview.stopLoss.targetPrice) {
    context.addIssue({ code: "custom", path: ["takeProfit"], message: "Protection targets must be positive and on the correct side of entry." });
  }
});
export type ProtectionPreview = z.infer<typeof ProtectionPreviewSchema>;

export const ProtectionPreviewResponseSchema = z.object({
  preview: ProtectionPreviewSchema,
  confirmationToken: z.string().min(24).max(256),
  state: z.lazy(() => ProtectionRuntimeStateSchema),
}).strict();

export const ProtectionConfirmationInputSchema = z.object({
  previewId: z.string().uuid(),
  confirmationToken: z.string().min(24).max(256),
}).strict();
export type ProtectionConfirmationInput = z.infer<typeof ProtectionConfirmationInputSchema>;

export const ProtectionPlanEventTypeSchema = z.enum([
  "PROTECTION_PLANNED",
  "PROTECTION_ACTIVATED_FIXTURE",
  "PROTECTION_ACTIVATION_FAILED",
  "PROTECTION_OUTCOME_UNKNOWN",
  "PROTECTION_TP_TRIGGERED_FIXTURE",
  "PROTECTION_SL_TRIGGERED_FIXTURE",
  "PROTECTION_RECOVERED_FIXTURE",
]);
export type ProtectionPlanEventType = z.infer<typeof ProtectionPlanEventTypeSchema>;

export const ProtectionPlanEventSchema = z.object({
  id: z.string().uuid(),
  protectionId: z.string().uuid(),
  eventType: ProtectionPlanEventTypeSchema,
  eventTime: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type ProtectionPlanEvent = z.infer<typeof ProtectionPlanEventSchema>;

export const ProtectionRuntimeStateSchema = z.object({
  status: ProtectionStatusSchema,
  provider: z.literal("FIXTURE"),
  activePreview: ProtectionPreviewSchema.nullable(),
  activePlan: ProtectionPlanSchema.nullable(),
  lastPlan: ProtectionPlanSchema.nullable(),
  reasons: z.array(z.enum([
    "POSITION_NOT_OPEN",
    "POSITION_UNKNOWN",
    "EXECUTION_ATTEMPT_UNRESOLVED",
    "EXECUTION_ATTEMPT_NOT_CONFIRMED",
    "NOT_LATEST_CONFIRMED_ATTEMPT",
    "PROTECTION_ALREADY_EXISTS",
    "PREVIEW_EXPIRED",
    "PREVIEW_INVALID",
    "PROTECTION_BUSY",
    "STORAGE_DEGRADED",
    "PROTECTION_ACTIVATION_REJECTED",
    "PROTECTION_ACTIVATION_UNKNOWN",
    "PROTECTION_TRIGGER_AMBIGUOUS",
  ])).max(8),
  updatedAt: z.string().datetime(),
}).strict();
export type ProtectionRuntimeState = z.infer<typeof ProtectionRuntimeStateSchema>;

export const ProtectionAdapterResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ACTIVATED"), fixtureProtectionId: z.string().uuid() }).strict(),
  z.object({ status: z.literal("FAILED_NOT_ACTIVATED"), reason: z.literal("FIXTURE_REJECTED") }).strict(),
]);
export type ProtectionAdapterResult = z.infer<typeof ProtectionAdapterResultSchema>;

export const ProtectionTriggeredEventPayloadSchema = z.object({
  plan: ProtectionPlanSchema,
  leg: ProtectionLegTypeSchema,
  markPrice: z.number().finite().positive(),
  targetPrice: z.number().finite().positive(),
  positionClosed: z.literal(false),
}).strict();

export const ProtectionUnknownEventPayloadSchema = z.object({
  plan: ProtectionPlanSchema,
  reason: z.enum(["ACTIVATION_OUTCOME_UNKNOWN", "TRIGGER_AMBIGUOUS", "RECOVERY_AFTER_PLANNED"]),
}).strict();

export function deriveProtectionPrice(input: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  leverage: number;
  legType: ProtectionLegType;
  basis: ProtectionBasis;
  value: number;
}): number {
  const { side, entryPrice, leverage, legType, basis, value } = input;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new RangeError("Entry price must be finite and positive.");
  if (!Number.isFinite(leverage) || leverage <= 0) throw new RangeError("Leverage must be finite and positive.");
  const bounds = basis === "PRICE_PCT" ? { min: 0.01, max: 99 } : { min: 0.1, max: 500 };
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) throw new RangeError("Protection percentage is outside the supported range.");
  const movePct = basis === "ROI_PCT" ? value / leverage : value;
  const increasesPrice = (side === "LONG" && legType === "TAKE_PROFIT")
    || (side === "SHORT" && legType === "STOP_LOSS");
  const targetPrice = entryPrice * (increasesPrice ? 1 + movePct / 100 : 1 - movePct / 100);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) throw new RangeError("Derived protection price must be finite and positive.");
  return targetPrice;
}

export type ProtectionTriggerResult = "NONE" | "TRIGGERED_TP" | "TRIGGERED_SL" | "UNKNOWN";

export function evaluateProtectionTrigger(input: {
  side: "LONG" | "SHORT";
  markPrice: number;
  takeProfitTarget: number;
  stopLossTarget: number;
}): ProtectionTriggerResult {
  const { side, markPrice, takeProfitTarget, stopLossTarget } = input;
  if (![markPrice, takeProfitTarget, stopLossTarget].every((value) => Number.isFinite(value) && value > 0)) {
    throw new RangeError("Trigger prices must be finite and positive.");
  }
  const takeProfit = side === "LONG" ? markPrice >= takeProfitTarget : markPrice <= takeProfitTarget;
  const stopLoss = side === "LONG" ? markPrice <= stopLossTarget : markPrice >= stopLossTarget;
  if (takeProfit && stopLoss) return "UNKNOWN";
  if (takeProfit) return "TRIGGERED_TP";
  if (stopLoss) return "TRIGGERED_SL";
  return "NONE";
}
