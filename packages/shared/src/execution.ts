import { z } from "zod";

export const ExecutionProviderSchema = z.enum(["DISABLED", "FIXTURE"]);
export type ExecutionProvider = z.infer<typeof ExecutionProviderSchema>;

export const ExecutionStatusSchema = z.enum([
  "DISARMED",
  "ARMED",
  "PREVIEW_READY",
  "AWAITING_CONFIRMATION",
  "PRECHECK",
  "SUBMITTING",
  "SUBMITTED",
  "BLOCKED",
  "FAILED",
  "HALTED",
]);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const ExecutionReasonCodeSchema = z.enum([
  "EXECUTION_PROVIDER_DISABLED",
  "ARM_REQUIRED",
  "ARM_EXPIRED",
  "PREVIEW_EXPIRED",
  "PREVIEW_INVALID",
  "EXECUTION_BUSY",
  "RISK_PRECHECK_BLOCKED",
  "STORAGE_DEGRADED",
  "EXECUTION_FAILED",
]);
export type ExecutionReasonCode = z.infer<typeof ExecutionReasonCodeSchema>;

export const ExecutionFailureKindSchema = z.enum(["EXECUTION_FAILED", "TIMEOUT"]);
export type ExecutionFailureKind = z.infer<typeof ExecutionFailureKindSchema>;

export const AssistedLiveOrderIntentSchema = z.object({
  mode: z.literal("LIVE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  orderType: z.literal("MARKET"),
  marginMode: z.literal("ISOLATED"),
  marginUsdt: z.number().finite().positive().max(50),
  leverage: z.number().finite().positive().max(10),
}).strict();
export type AssistedLiveOrderIntent = z.infer<typeof AssistedLiveOrderIntentSchema>;

export const AssistedLivePreviewSchema = z.object({
  previewId: z.string().uuid(),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  orderType: z.literal("MARKET"),
  marginMode: z.literal("ISOLATED"),
  marginUsdt: z.number().finite().positive().max(50),
  leverage: z.number().finite().positive().max(10),
  provider: z.literal("FIXTURE"),
  referencePrice: z.number().finite().positive().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export type AssistedLivePreview = z.infer<typeof AssistedLivePreviewSchema>;

export const AssistedSubmissionSummarySchema = z.discriminatedUnion("status", [
  z.object({
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("SUBMITTED"),
    fixtureSubmissionId: z.string().uuid(),
    submittedAt: z.string().datetime(),
  }).strict(),
  z.object({
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("FAILED"),
    failureKind: ExecutionFailureKindSchema,
    failedAt: z.string().datetime(),
  }).strict(),
]);
export type AssistedSubmissionSummary = z.infer<typeof AssistedSubmissionSummarySchema>;

export const AssistedExecutionStateSchema = z.object({
  status: ExecutionStatusSchema,
  provider: ExecutionProviderSchema,
  armedUntil: z.string().datetime().nullable(),
  activePreview: AssistedLivePreviewSchema.nullable(),
  lastSubmission: AssistedSubmissionSummarySchema.nullable(),
  reasons: z.array(ExecutionReasonCodeSchema),
  updatedAt: z.string().datetime(),
}).strict();
export type AssistedExecutionState = z.infer<typeof AssistedExecutionStateSchema>;

export const ExecutionArmInputSchema = z.object({
  acknowledgement: z.literal("ARM ASSISTED LIVE EXECUTION"),
}).strict();
export const ExecutionDisarmInputSchema = z.object({}).strict();

export const ExecutionPreviewInputSchema = z.object({
  side: z.enum(["LONG", "SHORT"]),
  marginUsdt: z.number().finite().positive().max(50),
  leverage: z.number().finite().positive().max(10),
}).strict();
export type ExecutionPreviewInput = z.infer<typeof ExecutionPreviewInputSchema>;

export const ExecutionConfirmInputSchema = z.object({
  previewId: z.string().uuid(),
  confirmationToken: z.string().uuid(),
}).strict();
export type ExecutionConfirmInput = z.infer<typeof ExecutionConfirmInputSchema>;

export const ExecutionPreviewResponseSchema = z.object({
  preview: AssistedLivePreviewSchema,
  confirmationToken: z.string().uuid(),
  state: AssistedExecutionStateSchema,
}).strict();

export const ExecutionAdapterResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("SUBMITTED"),
    fixtureSubmissionId: z.string().uuid(),
    submittedAt: z.string().datetime(),
  }).strict(),
  z.object({
    status: z.literal("FAILED"),
    failureKind: ExecutionFailureKindSchema,
    failedAt: z.string().datetime(),
  }).strict(),
]);
export type ExecutionAdapterResult = z.infer<typeof ExecutionAdapterResultSchema>;

export const ExecutionPositionStateSchema = z.enum(["FLAT", "OPEN", "UNKNOWN"]);
export type ExecutionPositionState = z.infer<typeof ExecutionPositionStateSchema>;

export const ExecutionSubmittedPayloadSchema = z.object({
  previewId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  submittedAt: z.string().datetime(),
}).strict();
