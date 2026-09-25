import { z } from "zod";

export const TradeModeSchema = z.enum(["PAPER", "LIVE"]);
export type TradeMode = z.infer<typeof TradeModeSchema>;

export const TradeSideSchema = z.enum(["LONG", "SHORT"]);
export type TradeSide = z.infer<typeof TradeSideSchema>;

export const TradeStatusSchema = z.enum(["PLANNED", "OPEN", "CLOSED", "FAILED", "UNKNOWN"]);
export type TradeStatus = z.infer<typeof TradeStatusSchema>;

const utcTimestampSchema = z.string().datetime();
const nullableNonnegative = z.number().finite().nonnegative().nullable();
const nullableFinite = z.number().finite().nullable();

export const TradeHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  symbol: z.string().trim().min(1).max(64),
  mode: TradeModeSchema,
  side: TradeSideSchema,
  status: TradeStatusSchema,
  entryPrice: nullableNonnegative,
  exitPrice: nullableNonnegative,
  realizedPnl: nullableFinite,
  fees: nullableNonnegative,
  createdAt: utcTimestampSchema,
}).strict();
export type TradeHistoryEntry = z.infer<typeof TradeHistoryEntrySchema>;

export const TradeRecordSchema = z.object({
  id: z.string().uuid(),
  symbol: z.string().trim().min(1).max(64),
  mode: TradeModeSchema,
  side: TradeSideSchema,
  status: TradeStatusSchema,
  marginUsdt: nullableNonnegative,
  leverage: z.number().finite().positive().nullable(),
  quantity: nullableNonnegative,
  entryPrice: nullableNonnegative,
  exitPrice: nullableNonnegative,
  realizedPnl: nullableFinite,
  fees: nullableNonnegative,
  plannedAt: utcTimestampSchema.nullable(),
  openedAt: utcTimestampSchema.nullable(),
  closedAt: utcTimestampSchema.nullable(),
  closeReason: z.string().trim().min(1).max(240).nullable(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  version: z.number().int().positive(),
}).strict();
export type TradeRecord = z.infer<typeof TradeRecordSchema>;

export const CreateTradeInputSchema = z.object({
  id: z.string().uuid().optional(),
  symbol: z.string().trim().min(1).max(64),
  mode: TradeModeSchema,
  side: TradeSideSchema,
  status: TradeStatusSchema,
  marginUsdt: nullableNonnegative.optional(),
  leverage: z.number().finite().positive().nullable().optional(),
  quantity: nullableNonnegative.optional(),
  entryPrice: nullableNonnegative.optional(),
  exitPrice: nullableNonnegative.optional(),
  realizedPnl: nullableFinite.optional(),
  fees: nullableNonnegative.optional(),
  plannedAt: utcTimestampSchema.nullable().optional(),
  openedAt: utcTimestampSchema.nullable().optional(),
  closedAt: utcTimestampSchema.nullable().optional(),
  closeReason: z.string().trim().min(1).max(240).nullable().optional(),
}).strict();
export type CreateTradeInput = z.infer<typeof CreateTradeInputSchema>;

export const TradeUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: TradeStatusSchema.optional(),
  marginUsdt: nullableNonnegative.optional(),
  leverage: z.number().finite().positive().nullable().optional(),
  quantity: nullableNonnegative.optional(),
  entryPrice: nullableNonnegative.optional(),
  exitPrice: nullableNonnegative.optional(),
  realizedPnl: nullableFinite.optional(),
  fees: nullableNonnegative.optional(),
  plannedAt: utcTimestampSchema.nullable().optional(),
  openedAt: utcTimestampSchema.nullable().optional(),
  closedAt: utcTimestampSchema.nullable().optional(),
  closeReason: z.string().trim().min(1).max(240).nullable().optional(),
}).strict().refine((value) => Object.entries(value).some(([key, entry]) => key !== "expectedVersion" && entry !== undefined), {
  message: "At least one trade field must be updated.",
});
export type TradeUpdate = z.infer<typeof TradeUpdateSchema>;

export const TradeEventRecordSchema = z.object({
  id: z.string().uuid(),
  tradeId: z.string().uuid().nullable(),
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  eventTime: utcTimestampSchema,
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: utcTimestampSchema,
}).strict();
export type TradeEventRecord = z.infer<typeof TradeEventRecordSchema>;

const DailyPlanFieldsSchema = z.object({
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  symbol: z.literal("GPS_USDT"),
  dailyTarget: z.number().int().min(1).max(10),
  completed: z.number().int().nonnegative(),
  marginUsdt: z.number().finite().nonnegative(),
  leverage: z.number().finite().positive(),
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
}).strict();

export const DailyPlanRecordSchema = DailyPlanFieldsSchema.refine((plan) => plan.completed <= plan.dailyTarget, {
  message: "Completed trades cannot exceed the daily target.",
});
export type DailyPlanRecord = z.infer<typeof DailyPlanRecordSchema>;

export const UpsertDailyPlanInputSchema = DailyPlanFieldsSchema.omit({ createdAt: true, updatedAt: true })
  .refine((plan) => plan.completed <= plan.dailyTarget, {
    message: "Completed trades cannot exceed the daily target.",
  });
export type UpsertDailyPlanInput = z.infer<typeof UpsertDailyPlanInputSchema>;

export const AuditCategorySchema = z.enum(["STORAGE", "TRADING", "RISK", "SCHEDULER", "SYSTEM"]);
export const AuditSeveritySchema = z.enum(["INFO", "WARN", "ERROR"]);

const forbiddenPayloadKeyParts = [
  "password", "pass", "otp", "code", "cookie", "token", "authorization", "auth",
  "session", "storagestate", "masterkey", "secret", "credential", "account", "email", "header",
];

function findUnsafePayloadReason(value: unknown, depth = 0, budget = { nodes: 0 }): string | null {
  budget.nodes += 1;
  if (budget.nodes > 500) return "Audit payload contains too many values.";
  if (depth > 8) return "Audit payload nesting is too deep.";
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "string") {
    return value.length <= 4096 ? null : "Audit payload strings are too long.";
  }
  if (typeof value === "number") return Number.isFinite(value) ? null : "Audit payload numbers must be finite.";
  if (Array.isArray(value)) {
    if (value.length > 100) return "Audit payload arrays are too large.";
    for (const item of value) {
      const reason = findUnsafePayloadReason(item, depth + 1, budget);
      if (reason) return reason;
    }
    return null;
  }
  if (typeof value !== "object") return "Audit payload must contain JSON values only.";

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return "Audit payload must contain plain objects only.";
  const entries = Object.entries(value);
  if (entries.length > 100) return "Audit payload objects are too large.";
  for (const [key, item] of entries) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (forbiddenPayloadKeyParts.some((part) => normalizedKey.includes(part))) {
      return "Audit payload contains a sensitive field.";
    }
    if (key.length > 80) return "Audit payload key is too long.";
    const reason = findUnsafePayloadReason(item, depth + 1, budget);
    if (reason) return reason;
  }
  return null;
}

export const SafeAuditPayloadSchema = z.record(z.string(), z.unknown()).superRefine((payload, context) => {
  const reason = findUnsafePayloadReason(payload);
  if (reason) context.addIssue({ code: "custom", message: reason });
});
export type SafeAuditPayload = z.infer<typeof SafeAuditPayloadSchema>;

export const TradeEventInputSchema = z.object({
  id: z.string().uuid().optional(),
  tradeId: z.string().uuid().nullable(),
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  eventTime: utcTimestampSchema.optional(),
  payload: SafeAuditPayloadSchema.nullable().optional(),
}).strict();
export type TradeEventInput = z.infer<typeof TradeEventInputSchema>;

export const AppendAuditEventInputSchema = z.object({
  id: z.string().uuid().optional(),
  category: AuditCategorySchema,
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  severity: AuditSeveritySchema,
  message: z.string().trim().min(1).max(240),
  payload: SafeAuditPayloadSchema.nullable().optional(),
}).strict();
export type AppendAuditEventInput = z.infer<typeof AppendAuditEventInputSchema>;

export const AuditEventRecordSchema = z.object({
  id: z.string().uuid(),
  category: AuditCategorySchema,
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  severity: AuditSeveritySchema,
  message: z.string().trim().min(1).max(240),
  payload: z.record(z.string(), z.unknown()).nullable(),
  createdAt: utcTimestampSchema,
}).strict();
export type AuditEventRecord = z.infer<typeof AuditEventRecordSchema>;

export const StorageStatusSchema = z.enum(["READY", "DEGRADED"]);
export type StorageStatus = z.infer<typeof StorageStatusSchema>;

export const StorageHealthSchema = z.object({
  status: StorageStatusSchema,
  schemaVersion: z.number().int().nonnegative().nullable(),
}).strict();
export type StorageHealth = z.infer<typeof StorageHealthSchema>;

export const TradeHistoryResponseSchema = z.object({
  trades: z.array(TradeHistoryEntrySchema).max(100),
}).strict();
