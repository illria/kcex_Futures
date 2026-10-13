import { randomUUID } from "node:crypto";
import {
  SchedulerStateSchema,
  type SchedulerBlockReason,
  type SchedulerDailyPlan,
  type SchedulerDueSlot,
  type SchedulerMissReason,
  type SchedulerSlot,
  type SchedulerState,
} from "../../../../packages/shared/src/scheduler.js";
import type { KillSwitchStatus } from "../../../../packages/shared/src/risk.js";
import type { EventBus } from "../realtime/event-bus.js";
import type { StorageService } from "../storage/storage-service.js";
import type { ExecutionPositionSource } from "../execution/execution-position-source.js";
import type { ResilienceStatus } from "../../../../packages/shared/src/protocol.js";
import { cryptoRandomSource, generateDailySchedule, type RandomSource } from "./schedule-generator.js";
import { SchedulerRuntimeError } from "./scheduler-errors.js";

export const SCHEDULER_TICK_INTERVAL_MS = 30_000;
export const SCHEDULER_GRACE_MS = 15 * 60_000;

export interface DailySchedulerServiceOptions {
  storage: StorageService;
  events: EventBus;
  positionSource: ExecutionPositionSource;
  getKillSwitchStatus: () => Promise<KillSwitchStatus> | KillSwitchStatus;
  getResilienceStatus?: () => ResilienceStatus;
  now?: () => Date;
  randomSource?: RandomSource;
  idGenerator?: () => string;
  intervalMs?: number;
}

export class DailySchedulerService {
  private readonly now: () => Date;
  private readonly randomSource: RandomSource;
  private readonly idGenerator: () => string;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private closed = false;
  private lastPublishedKey = "";
  private lastDegradedAuditKey = "";
  private state: SchedulerState;

  constructor(private readonly options: DailySchedulerServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomSource = options.randomSource ?? cryptoRandomSource;
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.intervalMs = options.intervalMs ?? SCHEDULER_TICK_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1_000 || this.intervalMs > SCHEDULER_TICK_INTERVAL_MS) {
      throw new RangeError("Scheduler tick interval must be from one to thirty seconds.");
    }
    const initialNow = this.clockNow();
    this.state = SchedulerStateSchema.parse({
      status: "DEGRADED",
      source: "LOCAL",
      dateKey: initialNow.toISOString().slice(0, 10),
      dailyMin: 1,
      dailyMax: 10,
      todayTarget: 1,
      completed: 0,
      missed: 0,
      remaining: 1,
      nextTradeAt: null,
      dueSlot: null,
      marginUsdt: 50,
      leverage: 10,
      minSpacingMinutes: 30,
      graceMinutes: 15,
      timezone: "UTC",
      autoSubmit: false,
      blockReasons: ["STORAGE_DEGRADED"],
      updatedAt: initialNow.toISOString(),
    });
  }

  async recover(): Promise<SchedulerState> {
    if (this.closed) return this.getState();
    return this.tick();
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
  }

  getState(): SchedulerState {
    return SchedulerStateSchema.parse(this.state);
  }

  async tick(): Promise<SchedulerState> {
    if (this.closed || this.ticking) return this.getState();
    this.ticking = true;
    let currentPlan: SchedulerDailyPlan | null = null;
    try {
      const now = this.clockNow();
      const timestamp = now.toISOString();
      const dateKey = timestamp.slice(0, 10);
      if (this.options.storage.getHealth().status !== "READY") {
        return this.publishDegraded(dateKey, null, "STORAGE_DEGRADED", now);
      }

      let plan = this.options.storage.scheduler.getDailySchedule(dateKey);
      currentPlan = plan;

      // Durable confirmations take precedence over expiry, including after a restart or missed tick.
      for (const slot of this.options.storage.scheduler.listReconciliationCandidates(timestamp, dateKey)) {
        const matches = this.options.storage.scheduler.findUnboundConfirmedMatchesForSlot(slot);
        if (matches.length > 1) {
          return this.publishDegraded(
            dateKey,
            currentPlan,
            "AMBIGUOUS_EXECUTION_MATCH",
            now,
            slot.dateKey === dateKey ? slot : null,
          );
        }
        if (matches.length === 1) {
          this.options.storage.scheduler.completeSlotWithAttempt({
            slotId: slot.id,
            expectedVersion: slot.version,
            executionAttemptId: matches[0]!,
          });
          if (slot.dateKey === dateKey) {
            currentPlan = this.options.storage.scheduler.getDailySchedule(dateKey);
          }
        }
      }

      const expiringDue = this.options.storage.scheduler.getCurrentDueSlot(dateKey);
      const dueMissReason = expiringDue && now.getTime() > Date.parse(expiringDue.dueAt) + SCHEDULER_GRACE_MS
        ? missReasonForBlockers(await this.computeBlockers())
        : "WINDOW_EXPIRED";
      this.options.storage.scheduler.expireSlots(timestamp, dateKey, dueMissReason);
      plan = this.options.storage.scheduler.getDailySchedule(dateKey);
      if (!plan) {
        const generated = generateDailySchedule(dateKey, now, this.randomSource, this.idGenerator);
        const created = this.options.storage.scheduler.createDailySchedule({
          dateKey,
          dailyTarget: generated.dailyTarget,
          createdAt: timestamp,
          slots: generated.slots,
        });
        plan = created.plan;
      }
      currentPlan = plan;
      // A first start at midday must expire already elapsed slots from the new plan.
      this.options.storage.scheduler.expireSlots(timestamp, dateKey);
      plan = this.options.storage.scheduler.getDailySchedule(dateKey);
      if (!plan) throw new SchedulerRuntimeError("SCHEDULER_STATE_INVALID");
      currentPlan = plan;

      const dueBeforeTransition = plan.slots.filter((slot) => slot.status === "SCHEDULED"
        && Date.parse(slot.dueAt) <= now.getTime()
        && now.getTime() <= Date.parse(slot.dueAt) + SCHEDULER_GRACE_MS);
      if (dueBeforeTransition.length > 1) {
        return this.publishDegraded(dateKey, plan, "AMBIGUOUS_EXECUTION_MATCH", now);
      }
      for (const slot of dueBeforeTransition) {
        this.options.storage.scheduler.transitionSlot({
          id: slot.id,
          expectedVersion: slot.version,
          status: "DUE",
          at: timestamp,
        });
      }

      const dueSlot = this.options.storage.scheduler.getCurrentDueSlot(dateKey);

      const refreshedHealth = this.options.storage.getHealth().status;
      if (refreshedHealth !== "READY") return this.publishDegraded(dateKey, plan, "STORAGE_DEGRADED", now, dueSlot);
      const blockers = dueSlot ? await this.computeBlockers() : [];
      const next = this.options.storage.scheduler.getNextScheduledSlot(dateKey);
      const slots = this.options.storage.scheduler.listSlots(dateKey);
      const completed = slots.filter((slot) => slot.status === "COMPLETED").length;
      const missed = slots.filter((slot) => slot.status === "MISSED").length;
      const remaining = plan.dailyTarget - completed - missed;
      const dueDetails = dueSlot ? makeDueSlot(dueSlot, blockers.length > 0) : null;
      const status = dueSlot
        ? blockers.length > 0 ? "BLOCKED" : "DUE"
        : remaining === 0 ? "COMPLETE" : "READY";
      const nextState = SchedulerStateSchema.parse({
        status,
        source: "LOCAL",
        dateKey,
        dailyMin: 1,
        dailyMax: 10,
        todayTarget: plan.dailyTarget,
        completed,
        missed,
        remaining,
        nextTradeAt: remaining > 0 ? next?.dueAt ?? null : null,
        dueSlot: dueDetails,
        marginUsdt: 50,
        leverage: 10,
        minSpacingMinutes: 30,
        graceMinutes: 15,
        timezone: "UTC",
        autoSubmit: false,
        blockReasons: blockers,
        updatedAt: timestamp,
      });
      this.replaceState(nextState);
      return this.getState();
    } catch {
      const now = this.clockNow();
      return this.publishDegraded(now.toISOString().slice(0, 10), currentPlan, "STORAGE_DEGRADED", now);
    } finally {
      this.ticking = false;
    }
  }

  private async computeBlockers(): Promise<SchedulerBlockReason[]> {
    const blockers: SchedulerBlockReason[] = [];
    const resilienceStatus = this.options.getResilienceStatus?.() ?? "IDLE";
    if (resilienceStatus === "MANUAL_ACTION" || resilienceStatus === "HALTED") blockers.push("RUNTIME_UNHEALTHY");
    const position = await this.options.positionSource.getPositionState();
    if (position === "OPEN") blockers.push("POSITION_NOT_FLAT");
    else if (position !== "FLAT") blockers.push("POSITION_UNKNOWN");
    if (this.options.storage.executionAttempts.getBlockingAttempt()) blockers.push("EXECUTION_UNRESOLVED");
    if (this.options.storage.liveExecutionAttempts.getBlockingAttempt()) blockers.push("EXECUTION_UNRESOLVED");
    if (this.options.storage.protectionPlans.getPositionGuardPlan()) blockers.push("PROTECTION_UNRESOLVED");
    if (this.options.storage.liveProtectionPlans.getPositionGuardPlan()) blockers.push("PROTECTION_UNRESOLVED");
    const killSwitch = await this.options.getKillSwitchStatus();
    if (killSwitch === "ENGAGED") blockers.push("KILL_SWITCH_ENGAGED");
    else if (killSwitch === "UNKNOWN") blockers.push("KILL_SWITCH_UNKNOWN");
    return blockers;
  }

  private publishDegraded(
    dateKey: string,
    plan: SchedulerDailyPlan | null,
    reason: SchedulerBlockReason,
    now: Date,
    dueSlot?: SchedulerSlot | null,
  ): SchedulerState {
    const slots = plan?.slots ?? [];
    const target = plan?.dailyTarget ?? Math.max(1, this.state.todayTarget);
    const completed = slots.filter((slot) => slot.status === "COMPLETED").length;
    const missed = slots.filter((slot) => slot.status === "MISSED").length;
    const remaining = Math.max(0, target - completed - missed);
    const state = SchedulerStateSchema.parse({
      status: "DEGRADED",
      source: "LOCAL",
      dateKey,
      dailyMin: 1,
      dailyMax: 10,
      todayTarget: target,
      completed,
      missed,
      remaining,
      nextTradeAt: plan?.slots.find((slot) => slot.status === "SCHEDULED")?.dueAt ?? null,
      dueSlot: dueSlot ? makeDueSlot(dueSlot, true) : null,
      marginUsdt: 50,
      leverage: 10,
      minSpacingMinutes: 30,
      graceMinutes: 15,
      timezone: "UTC",
      autoSubmit: false,
      blockReasons: [reason],
      updatedAt: now.toISOString(),
    });
    if (this.options.storage.isReady && this.options.storage.getHealth().status === "READY") {
      const auditKey = `${dateKey}:${reason}:${dueSlot?.id ?? "none"}`;
      if (auditKey !== this.lastDegradedAuditKey) {
        try {
          this.options.storage.auditEvents.appendAuditEvent({
            category: "SCHEDULER",
            eventType: "SCHEDULER_DEGRADED",
            severity: "WARN",
            message: "The daily scheduler entered a fail-closed degraded state.",
            payload: { dateKey, reason },
          });
          this.lastDegradedAuditKey = auditKey;
        } catch {
          // A failed audit write must not trigger a retry or any execution path.
        }
      }
    }
    this.replaceState(state);
    return this.getState();
  }

  private replaceState(next: SchedulerState): void {
    const withoutUpdatedAt = (state: SchedulerState) => JSON.stringify({ ...state, updatedAt: "" });
    const candidateKey = withoutUpdatedAt(next);
    if (candidateKey === withoutUpdatedAt(this.state)) return;
    this.state = next;
    if (next.status !== "DEGRADED") this.lastDegradedAuditKey = "";
    if (candidateKey !== this.lastPublishedKey) {
      this.lastPublishedKey = candidateKey;
      this.options.events.publish({
        version: 1,
        type: "scheduler.plan",
        timestamp: next.updatedAt,
        payload: next,
      });
    }
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new SchedulerRuntimeError("SCHEDULER_CLOCK_INVALID");
    return value;
  }
}

function makeDueSlot(slot: SchedulerSlot, blocked: boolean): SchedulerDueSlot {
  return {
    slotIndex: slot.slotIndex,
    side: slot.side,
    dueAt: slot.dueAt,
    windowEndsAt: new Date(Date.parse(slot.dueAt) + SCHEDULER_GRACE_MS).toISOString(),
    entryEligibility: blocked ? "BLOCKED" : "ELIGIBLE",
  };
}

function missReasonForBlockers(blockers: SchedulerBlockReason[]): SchedulerMissReason {
  if (blockers.includes("POSITION_NOT_FLAT")) return "POSITION_NOT_FLAT";
  if (blockers.includes("POSITION_UNKNOWN")) return "POSITION_UNKNOWN";
  if (blockers.includes("EXECUTION_UNRESOLVED")) return "EXECUTION_UNRESOLVED";
  if (blockers.includes("PROTECTION_UNRESOLVED")) return "PROTECTION_UNRESOLVED";
  return "WINDOW_EXPIRED";
}
