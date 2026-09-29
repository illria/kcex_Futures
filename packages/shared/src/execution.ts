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
  "CONFIRMING",
  "CONFIRMED",
  "UNKNOWN",
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
  "CONFIRMATION_SOURCE_UNKNOWN",
  "CONFIRMATION_EVIDENCE_MISMATCH",
  "CONFIRMATION_TIMEOUT",
  "SUBMISSION_OUTCOME_UNKNOWN",
]);
export type ExecutionReasonCode = z.infer<typeof ExecutionReasonCodeSchema>;

export const ExecutionFailureKindSchema = z.enum(["EXECUTION_FAILED", "TIMEOUT"]);
export type ExecutionFailureKind = z.infer<typeof ExecutionFailureKindSchema>;

export const PositionConfirmationEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("NO_POSITION"),
    source: z.literal("FIXTURE"),
    observedAt: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.literal("MATCHED_OPEN"),
    source: z.literal("FIXTURE"),
    symbol: z.string().trim().min(1).max(64),
    side: z.enum(["LONG", "SHORT"]),
    entryPrice: z.number().finite().positive(),
    size: z.number().finite().positive(),
    observedAt: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.literal("MISMATCH"),
    source: z.literal("FIXTURE"),
    reason: z.enum(["SYMBOL_MISMATCH", "SIDE_MISMATCH", "INVALID_POSITION"]),
    observedAt: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.literal("UNKNOWN"),
    source: z.enum(["FIXTURE", "UNKNOWN"]),
    reason: z.enum(["SOURCE_UNAVAILABLE", "INVALID_EVIDENCE"]),
    observedAt: z.string().datetime(),
  }).strict(),
]);
export type PositionConfirmationEvidence = z.infer<typeof PositionConfirmationEvidenceSchema>;

export const ExecutionAttemptStatusSchema = z.enum([
  "SUBMITTING", "SUBMITTED", "CONFIRMING", "CONFIRMED", "FAILED", "UNKNOWN",
]);
export type ExecutionAttemptStatus = z.infer<typeof ExecutionAttemptStatusSchema>;

export const ExecutionAttemptRecordSchema = z.object({
  attemptId: z.string().uuid(),
  previewId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  marginUsdt: z.number().finite().positive().max(50),
  leverage: z.number().finite().positive().max(10),
  status: ExecutionAttemptStatusSchema,
  fixtureSubmissionId: z.string().uuid().nullable(),
  outcome: z.literal("NOT_SUBMITTED").nullable(),
  failureKind: ExecutionFailureKindSchema.nullable(),
  reason: ExecutionReasonCodeSchema.nullable(),
  evidence: PositionConfirmationEvidenceSchema.nullable(),
  submittedAt: z.string().datetime().nullable(),
  confirmationStartedAt: z.string().datetime().nullable(),
  confirmedAt: z.string().datetime().nullable(),
  failedAt: z.string().datetime().nullable(),
  unknownAt: z.string().datetime().nullable(),
  observedSide: z.enum(["LONG", "SHORT"]).nullable(),
  observedEntryPrice: z.number().finite().positive().nullable(),
  observedSize: z.number().finite().positive().nullable(),
  observedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
}).strict().superRefine((attempt, context) => {
  const issue = (path: string, message: string) => context.addIssue({
    code: z.ZodIssueCode.custom,
    path: [path],
    message,
  });
  if (attempt.status === "SUBMITTED" && (!attempt.fixtureSubmissionId || !attempt.submittedAt)) {
    issue("status", "SUBMITTED requires a fixture submission acknowledgement.");
  }
  if (attempt.status === "CONFIRMING" && !attempt.confirmationStartedAt) {
    issue("confirmationStartedAt", "CONFIRMING requires a durable start time.");
  }
  if (attempt.status === "CONFIRMED" && (!attempt.confirmedAt || attempt.evidence?.kind !== "MATCHED_OPEN")) {
    issue("status", "CONFIRMED requires matched position evidence and a confirmation time.");
  }
  if (attempt.status === "FAILED" && (!attempt.failedAt || !attempt.failureKind || attempt.outcome !== "NOT_SUBMITTED")) {
    issue("status", "FAILED requires an explicit NOT_SUBMITTED result.");
  }
  if (attempt.status === "UNKNOWN" && (!attempt.unknownAt || !attempt.reason)) {
    issue("status", "UNKNOWN requires a durable reason and timestamp.");
  }
  if (attempt.outcome !== null && attempt.status !== "FAILED") {
    issue("outcome", "Only FAILED attempts may have an outcome.");
  }
});
export type ExecutionAttemptRecord = z.infer<typeof ExecutionAttemptRecordSchema>;

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
    attemptId: z.string().uuid(),
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("SUBMITTING"),
  }).strict(),
  z.object({
    attemptId: z.string().uuid(),
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("SUBMITTED"),
    fixtureSubmissionId: z.string().uuid(),
    submittedAt: z.string().datetime(),
  }).strict(),
  z.object({
    attemptId: z.string().uuid(),
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("FAILED"),
    outcome: z.literal("NOT_SUBMITTED"),
    failureKind: ExecutionFailureKindSchema,
    failedAt: z.string().datetime(),
  }).strict(),
  z.object({
    attemptId: z.string().uuid(),
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("CONFIRMING"),
    fixtureSubmissionId: z.string().uuid().nullable(),
    submittedAt: z.string().datetime().nullable(),
  }).strict(),
  z.object({
    attemptId: z.string().uuid(),
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("CONFIRMED"),
    fixtureSubmissionId: z.string().uuid().nullable(),
    submittedAt: z.string().datetime().nullable(),
    confirmedAt: z.string().datetime(),
    evidence: PositionConfirmationEvidenceSchema,
  }).strict(),
  z.object({
    attemptId: z.string().uuid(),
    previewId: z.string().uuid(),
    provider: z.literal("FIXTURE"),
    symbol: z.literal("GPS_USDT"),
    side: z.enum(["LONG", "SHORT"]),
    status: z.literal("UNKNOWN"),
    fixtureSubmissionId: z.string().uuid().nullable(),
    submittedAt: z.string().datetime().nullable(),
    unknownAt: z.string().datetime(),
    reason: ExecutionReasonCodeSchema,
    evidence: PositionConfirmationEvidenceSchema.nullable(),
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

export const ExecutionReconcileInputSchema = z.object({ attemptId: z.string().uuid() }).strict();

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
    outcome: z.literal("NOT_SUBMITTED"),
    failureKind: ExecutionFailureKindSchema,
    failedAt: z.string().datetime(),
  }).strict(),
]);
export type ExecutionAdapterResult = z.infer<typeof ExecutionAdapterResultSchema>;

export const ExecutionPositionStateSchema = z.enum(["FLAT", "OPEN", "UNKNOWN"]);
export type ExecutionPositionState = z.infer<typeof ExecutionPositionStateSchema>;

export const ExecutionSubmittedPayloadSchema = z.object({
  attemptId: z.string().uuid(),
  previewId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  submittedAt: z.string().datetime(),
}).strict();

export const ExecutionConfirmingPayloadSchema = z.object({
  attemptId: z.string().uuid(),
  previewId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  submittedAt: z.string().datetime().nullable(),
}).strict();

export const ExecutionConfirmedPayloadSchema = z.object({
  attemptId: z.string().uuid(),
  previewId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  submittedAt: z.string().datetime().nullable(),
  confirmedAt: z.string().datetime(),
  observedEntryPrice: z.number().finite().positive(),
  observedSize: z.number().finite().positive(),
  observedAt: z.string().datetime(),
  evidence: PositionConfirmationEvidenceSchema,
}).strict();

export const ExecutionUnknownPayloadSchema = z.object({
  attemptId: z.string().uuid(),
  previewId: z.string().uuid(),
  provider: z.literal("FIXTURE"),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  submittedAt: z.string().datetime().nullable(),
  unknownAt: z.string().datetime(),
  reason: ExecutionReasonCodeSchema,
  evidence: PositionConfirmationEvidenceSchema.nullable(),
}).strict();
