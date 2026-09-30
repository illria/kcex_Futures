import {
  LIVE_AUTOMATION_CONFIRMATION_PHRASE,
  LiveAutomationProtectionInputSchema,
  LiveAutomationStateSchema,
  getLiveAutomationBlockReasons,
  type KcexLiveSelectorManifest,
  type LiveAutomationState,
  type LiveProtectionSetting,
  type VerifiedKcexContractProfile,
} from "../../../../packages/shared/src/live-launch.js";
import type { EventBus } from "../realtime/event-bus.js";

export interface LiveAutomationPreflight {
  liveTrading: boolean;
  automationAuthorized: boolean;
  provider: "DISABLED" | "FIXTURE" | "KCEX";
  authStatus: string;
  resilienceStatus: string;
  readFresh: boolean;
  contractProfile: VerifiedKcexContractProfile;
  selectors: KcexLiveSelectorManifest;
  killSwitch: "CLEAR" | "ENGAGED" | "UNKNOWN";
  positionStatus: "FLAT" | "OPEN" | "UNKNOWN";
  openOrdersClear: boolean;
  unresolvedExecution: boolean;
  unresolvedProtection: boolean;
  storageReady: boolean;
  riskAllowsEntry: boolean;
  realExecutionVerified: boolean;
  protectionVerified: boolean;
  dueSlotId: string | null;
  lastAttemptId: string | null;
}

export interface SchedulerLiveSlot {
  id: string;
  dateKey: string;
  slotIndex: number;
  side: "LONG" | "SHORT";
  dueAt: string;
  status: "SCHEDULED" | "DUE" | "COMPLETED" | "MISSED";
}

export interface AutoLiveOrchestratorOptions {
  events: EventBus;
  getPreflight(): LiveAutomationPreflight;
  refreshPreflight?(): Promise<void>;
  executeDueSlot?: (slot: SchedulerLiveSlot, attemptId: string, protection: { takeProfit: LiveProtectionSetting; stopLoss: LiveProtectionSetting }) => Promise<"POSITION_OPEN" | "UNKNOWN" | "MANUAL_ACTION">;
  claimSlotOnce?: (slot: SchedulerLiveSlot) => Promise<string | null>;
  now?: () => Date;
  graceMs?: number;
}

export class LiveAutomationBlockedError extends Error {
  constructor(readonly state: LiveAutomationState) {
    super("LIVE_AUTOMATION_BLOCKED");
    this.name = "LiveAutomationBlockedError";
  }
}

/** Runtime-only arm state. A new process always constructs this service DISARMED. */
export class AutoLiveOrchestrator {
  private readonly now: () => Date;
  private readonly graceMs: number;
  private status: LiveAutomationState["status"] = "DISARMED";
  private takeProfit: LiveProtectionSetting | null = null;
  private stopLoss: LiveProtectionSetting | null = null;
  private dueSlotId: string | null = null;
  private lastAttemptId: string | null = null;
  private stopRequested = false;
  private inFlight = false;
  private armed = false;
  private hardHalted = false;
  private readonly observedSlots = new Set<string>();

  constructor(private readonly options: AutoLiveOrchestratorOptions) {
    this.now = options.now ?? (() => new Date());
    this.graceMs = options.graceMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.graceMs) || this.graceMs < 1_000 || this.graceMs > 15 * 60_000) {
      throw new RangeError("Live scheduler grace must be between one second and fifteen minutes.");
    }
  }

  getState(): LiveAutomationState {
    const gates = this.options.getPreflight();
    const blockReasons = getLiveAutomationBlockReasons({
      ...gates,
      takeProfit: this.takeProfit,
      stopLoss: this.stopLoss,
    });
    const canArm = this.status === "DISARMED" && blockReasons.length === 0;
    return LiveAutomationStateSchema.parse({
      status: this.status,
      liveTrading: gates.liveTrading,
      automationAuthorized: gates.automationAuthorized,
      provider: gates.provider,
      authStatus: gates.authStatus,
      resilienceStatus: gates.resilienceStatus,
      readFresh: gates.readFresh,
      contractProfileStatus: gates.contractProfile.status,
      killSwitch: gates.killSwitch,
      positionStatus: gates.positionStatus,
      openOrdersClear: gates.openOrdersClear,
      unresolvedExecution: gates.unresolvedExecution,
      unresolvedProtection: gates.unresolvedProtection,
      protectionConfigured: this.takeProfit !== null && this.stopLoss !== null,
      takeProfit: this.takeProfit,
      stopLoss: this.stopLoss,
      canArm,
      stopRequested: this.stopRequested,
      dueSlotId: this.dueSlotId ?? gates.dueSlotId,
      lastAttemptId: this.lastAttemptId ?? gates.lastAttemptId,
      blockReasons,
      updatedAt: this.now().toISOString(),
    });
  }

  async refresh(): Promise<LiveAutomationState> {
    await this.options.refreshPreflight?.();
    return this.publish();
  }

  configureProtection(input: unknown): LiveAutomationState {
    const settings = LiveAutomationProtectionInputSchema.parse(input);
    if (this.status !== "DISARMED") throw new Error("LIVE_AUTOMATION_MUST_BE_DISARMED");
    this.takeProfit = Object.freeze({ ...settings.takeProfit });
    this.stopLoss = Object.freeze({ ...settings.stopLoss });
    return this.publish();
  }

  arm(confirmation: string): LiveAutomationState {
    if (confirmation !== LIVE_AUTOMATION_CONFIRMATION_PHRASE) throw new Error("LIVE_AUTOMATION_CONFIRMATION_MISMATCH");
    const state = this.getState();
    if (!state.canArm) throw new LiveAutomationBlockedError(state);
    this.stopRequested = false;
    this.hardHalted = false;
    this.armed = true;
    this.status = "ARMED";
    return this.publish();
  }

  stop(): LiveAutomationState {
    this.stopRequested = true;
    this.armed = false;
    if (!this.inFlight) {
      this.status = "DISARMED";
      this.stopRequested = false;
      this.dueSlotId = null;
    }
    return this.publish();
  }

  async onSchedulerSlot(slot: SchedulerLiveSlot): Promise<LiveAutomationState> {
    try {
      await this.options.refreshPreflight?.();
    } catch {
      this.armed = false;
      this.hardHalted = true;
      this.status = "HALTED";
      return this.publish();
    }
    if (!this.armed || this.stopRequested || this.inFlight
      || !(["ARMED", "WAITING", "DUE"] as const).includes(this.status as "ARMED" | "WAITING" | "DUE")
      || slot.status !== "DUE") return this.getState();
    const nowMs = this.now().getTime();
    const dueMs = Date.parse(slot.dueAt);
    if (!Number.isFinite(dueMs) || nowMs < dueMs) {
      this.status = "WAITING";
      return this.publish();
    }
    if (nowMs > dueMs + this.graceMs) {
      this.status = "BLOCKED";
      this.dueSlotId = slot.id;
      return this.publish();
    }
    if (this.observedSlots.has(slot.id) || !this.options.claimSlotOnce || !this.options.executeDueSlot) {
      this.status = "HALTED";
      this.dueSlotId = slot.id;
      return this.publish();
    }
    const state = this.getState();
    if (state.blockReasons.length > 0) {
      this.status = "BLOCKED";
      this.dueSlotId = slot.id;
      return this.publish();
    }
    this.inFlight = true;
    this.dueSlotId = slot.id;
    this.status = "PRECHECK";
    this.publish();
    try {
      const attemptId = await this.options.claimSlotOnce(slot);
      if (!attemptId) {
        this.status = "HALTED";
        this.armed = false;
        return this.publish();
      }
      this.lastAttemptId = attemptId;
      this.observedSlots.add(slot.id);
      this.status = "SUBMITTING";
      this.publish();
      const outcome = await this.options.executeDueSlot(slot, attemptId, {
        takeProfit: this.takeProfit!,
        stopLoss: this.stopLoss!,
      });
      this.status = outcome === "UNKNOWN" ? "HALTED" : outcome;
      if (outcome === "UNKNOWN" || outcome === "MANUAL_ACTION") {
        this.stopRequested = true;
        this.armed = false;
        this.hardHalted = true;
      }
      return this.publish();
    } catch {
      this.status = "HALTED";
      this.stopRequested = true;
      this.armed = false;
      return this.publish();
    } finally {
      this.inFlight = false;
      if (this.stopRequested) {
        if (this.hardHalted && this.status !== "HALTED" && this.status !== "MANUAL_ACTION") {
          this.status = "MANUAL_ACTION";
        } else if (this.status !== "HALTED" && this.status !== "MANUAL_ACTION" && this.status !== "POSITION_OPEN") {
          this.status = "DISARMED";
        }
        this.stopRequested = false;
        if (this.status === "DISARMED") this.dueSlotId = null;
      }
      this.publish();
    }
  }

  handlePositionState(positionStatus: "FLAT" | "OPEN" | "UNKNOWN"): LiveAutomationState {
    if (positionStatus === "OPEN" && this.status === "ARMED") this.status = "POSITION_OPEN";
    if (positionStatus === "FLAT" && this.status === "POSITION_OPEN") {
      this.status = this.armed && !this.stopRequested ? "ARMED" : "DISARMED";
      if (this.status === "DISARMED") this.stopRequested = false;
      this.dueSlotId = null;
    }
    if (positionStatus === "UNKNOWN" && this.status !== "DISARMED") {
      this.status = "HALTED";
      this.stopRequested = true;
      this.armed = false;
      this.hardHalted = true;
    }
    return this.publish();
  }

  reportProgress(status: "CONFIRMING" | "PROTECTING"): LiveAutomationState {
    if (!this.inFlight) throw new Error("LIVE_AUTOMATION_NOT_IN_FLIGHT");
    this.status = status;
    return this.publish();
  }

  halt(): LiveAutomationState {
    this.armed = false;
    this.stopRequested = true;
    this.hardHalted = true;
    if (!this.inFlight) {
      this.status = "HALTED";
      this.stopRequested = false;
    }
    return this.publish();
  }

  requireManualAction(): LiveAutomationState {
    this.armed = false;
    this.stopRequested = true;
    this.hardHalted = true;
    if (!this.inFlight) {
      this.status = "MANUAL_ACTION";
      this.stopRequested = false;
    }
    return this.publish();
  }

  isRuntimeAuthorized(): boolean {
    return this.armed && !this.stopRequested && !this.hardHalted;
  }

  private publish(): LiveAutomationState {
    const state = this.getState();
    this.options.events.publish({ version: 1, type: "live.automation.state", timestamp: state.updatedAt, payload: state });
    return state;
  }
}
