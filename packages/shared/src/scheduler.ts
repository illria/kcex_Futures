import { z } from "zod";

export const SchedulerSlotStatusSchema = z.enum(["SCHEDULED", "DUE", "COMPLETED", "MISSED"]);
export type SchedulerSlotStatus = z.infer<typeof SchedulerSlotStatusSchema>;

export const SchedulerMissReasonSchema = z.enum([
  "WINDOW_EXPIRED",
  "DAY_ROLLOVER",
  "POSITION_NOT_FLAT",
  "POSITION_UNKNOWN",
  "EXECUTION_UNRESOLVED",
  "PROTECTION_UNRESOLVED",
  "STORAGE_DEGRADED",
]);
export type SchedulerMissReason = z.infer<typeof SchedulerMissReasonSchema>;

export const SchedulerBlockReasonSchema = z.enum([
  "POSITION_NOT_FLAT",
  "POSITION_UNKNOWN",
  "EXECUTION_UNRESOLVED",
  "PROTECTION_UNRESOLVED",
  "KILL_SWITCH_ENGAGED",
  "KILL_SWITCH_UNKNOWN",
  "STORAGE_DEGRADED",
  "AMBIGUOUS_EXECUTION_MATCH",
  "RUNTIME_UNHEALTHY",
]);
export type SchedulerBlockReason = z.infer<typeof SchedulerBlockReasonSchema>;

export const SchedulerRuntimeStatusSchema = z.enum(["READY", "DUE", "BLOCKED", "COMPLETE", "DEGRADED"]);
export type SchedulerRuntimeStatus = z.infer<typeof SchedulerRuntimeStatusSchema>;

export const SchedulerSourceSchema = z.enum(["LOCAL", "FIXTURE"]);
export type SchedulerSource = z.infer<typeof SchedulerSourceSchema>;

export const UtcDateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});

export const SchedulerSlotSchema = z.object({
  id: z.string().uuid(),
  dateKey: UtcDateKeySchema,
  slotIndex: z.number().int().min(0).max(9),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  dueAt: z.string().datetime(),
  status: SchedulerSlotStatusSchema,
  executionAttemptId: z.string().uuid().nullable(),
  liveExecutionAttemptId: z.string().uuid().nullable().default(null),
  completedAt: z.string().datetime().nullable(),
  missedAt: z.string().datetime().nullable(),
  missReason: SchedulerMissReasonSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  version: z.number().int().positive(),
}).strict().superRefine((slot, context) => {
  const dueAt = new Date(slot.dueAt);
  if (dueAt.toISOString().slice(0, 10) !== slot.dateKey || dueAt.getUTCHours() > 23
    || dueAt.getUTCMinutes() % 5 !== 0 || dueAt.getUTCSeconds() !== 0 || dueAt.getUTCMilliseconds() !== 0) {
    context.addIssue({ code: "custom", path: ["dueAt"], message: "Scheduler dueAt must be on the five-minute UTC grid for its date." });
  }
  if (slot.status === "COMPLETED") {
    if ((!slot.executionAttemptId && !slot.liveExecutionAttemptId)
      || (slot.executionAttemptId !== null && slot.liveExecutionAttemptId !== null)
      || !slot.completedAt || slot.missedAt || slot.missReason) {
      context.addIssue({ code: "custom", path: ["status"], message: "COMPLETED requires a bound attempt and completion time only." });
    }
  } else if (slot.status === "MISSED") {
    if (!slot.missedAt || !slot.missReason || slot.executionAttemptId || slot.liveExecutionAttemptId || slot.completedAt) {
      context.addIssue({ code: "custom", path: ["status"], message: "MISSED requires a miss timestamp and reason only." });
    }
  } else if (slot.executionAttemptId || slot.liveExecutionAttemptId || slot.completedAt || slot.missedAt || slot.missReason) {
    context.addIssue({ code: "custom", path: ["status"], message: "Open scheduler slots cannot contain terminal fields." });
  }
});
export type SchedulerSlot = z.infer<typeof SchedulerSlotSchema>;

export const SchedulerDailyPlanSchema = z.object({
  dateKey: UtcDateKeySchema,
  symbol: z.literal("GPS_USDT"),
  dailyTarget: z.number().int().min(1).max(10),
  completed: z.number().int().nonnegative(),
  marginUsdt: z.literal(50),
  leverage: z.literal(10),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  slots: z.array(SchedulerSlotSchema).min(1).max(10),
}).strict().superRefine((plan, context) => {
  if (plan.completed > plan.dailyTarget || plan.slots.length !== plan.dailyTarget) {
    context.addIssue({ code: "custom", message: "Daily plan counts must agree with its target." });
  }
  for (let index = 0; index < plan.slots.length; index += 1) {
    if (plan.slots[index]?.slotIndex !== index || plan.slots[index]?.dateKey !== plan.dateKey) {
      context.addIssue({ code: "custom", path: ["slots", index], message: "Daily plan slots must be contiguous and match the plan date." });
    }
    if (index > 0) {
      const prior = Date.parse(plan.slots[index - 1]!.dueAt);
      const current = Date.parse(plan.slots[index]!.dueAt);
      if (current - prior < 30 * 60_000) {
        context.addIssue({ code: "custom", path: ["slots", index, "dueAt"], message: "Adjacent slots must be separated by at least 30 minutes." });
      }
    }
  }
  const completedCount = plan.slots.filter((slot) => slot.status === "COMPLETED").length;
  if (completedCount !== plan.completed) {
    context.addIssue({ code: "custom", path: ["completed"], message: "Daily completed count must match completed slots." });
  }
});
export type SchedulerDailyPlan = z.infer<typeof SchedulerDailyPlanSchema>;

export const SchedulerDueSlotSchema = z.object({
  slotIndex: z.number().int().min(0).max(9),
  side: z.enum(["LONG", "SHORT"]),
  dueAt: z.string().datetime(),
  windowEndsAt: z.string().datetime(),
  entryEligibility: z.enum(["ELIGIBLE", "BLOCKED"]),
}).strict();
export type SchedulerDueSlot = z.infer<typeof SchedulerDueSlotSchema>;

export const SchedulerStateSchema = z.object({
  status: SchedulerRuntimeStatusSchema,
  source: SchedulerSourceSchema,
  dateKey: UtcDateKeySchema,
  dailyMin: z.literal(1),
  dailyMax: z.literal(10),
  todayTarget: z.number().int().min(1).max(10),
  completed: z.number().int().nonnegative(),
  missed: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  nextTradeAt: z.string().datetime().nullable(),
  dueSlot: SchedulerDueSlotSchema.nullable(),
  marginUsdt: z.literal(50),
  leverage: z.literal(10),
  minSpacingMinutes: z.literal(30),
  graceMinutes: z.literal(15),
  timezone: z.literal("UTC"),
  autoSubmit: z.literal(false),
  blockReasons: z.array(SchedulerBlockReasonSchema).max(8),
  updatedAt: z.string().datetime(),
}).strict().superRefine((state, context) => {
  if (state.completed + state.missed + state.remaining !== state.todayTarget) {
    context.addIssue({ code: "custom", path: ["remaining"], message: "Remaining slots must match the daily target." });
  }
  if ((state.status === "DUE" || state.status === "BLOCKED") && state.dueSlot === null) {
    context.addIssue({ code: "custom", path: ["dueSlot"], message: "DUE and BLOCKED states require a due slot." });
  }
  if ((state.status === "READY" || state.status === "COMPLETE") && state.dueSlot !== null) {
    context.addIssue({ code: "custom", path: ["dueSlot"], message: "READY and COMPLETE states cannot expose a due slot." });
  }
  if (state.status === "DEGRADED" && state.dueSlot !== null && state.dueSlot.entryEligibility !== "BLOCKED") {
    context.addIssue({ code: "custom", path: ["dueSlot"], message: "A degraded due slot must fail closed." });
  }
  if (state.status === "BLOCKED" && (!state.dueSlot || state.dueSlot.entryEligibility !== "BLOCKED" || state.blockReasons.length === 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "BLOCKED requires due slot blockers." });
  }
  if (state.status === "DUE" && (!state.dueSlot || state.dueSlot.entryEligibility !== "ELIGIBLE" || state.blockReasons.length > 0)) {
    context.addIssue({ code: "custom", path: ["status"], message: "DUE requires an eligible due slot." });
  }
});
export type SchedulerState = z.infer<typeof SchedulerStateSchema>;

export function createFixtureSchedulerState(now = new Date().toISOString()): SchedulerState {
  const dateKey = new Date(now).toISOString().slice(0, 10);
  return SchedulerStateSchema.parse({
    status: "READY",
    source: "FIXTURE",
    dateKey,
    dailyMin: 1,
    dailyMax: 10,
    todayTarget: 3,
    completed: 0,
    missed: 0,
    remaining: 3,
    nextTradeAt: null,
    dueSlot: null,
    marginUsdt: 50,
    leverage: 10,
    minSpacingMinutes: 30,
    graceMinutes: 15,
    timezone: "UTC",
    autoSubmit: false,
    blockReasons: [],
    updatedAt: new Date(now).toISOString(),
  });
}
