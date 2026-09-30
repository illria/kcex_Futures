import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ProtectionAdapterResultSchema,
  ProtectionConfirmationInputSchema,
  ProtectionIntentSchema,
  ProtectionPlanSchema,
  ProtectionPreviewSchema,
  ProtectionPreviewResponseSchema,
  ProtectionRuntimeStateSchema,
  deriveProtectionPrice,
  evaluateProtectionTrigger,
  type DurableProtectionStatus,
  type ProtectionConfirmationInput,
  type ProtectionIntent,
  type ProtectionPlan,
  type ProtectionPreview,
  type ProtectionRuntimeState,
} from "../../../../packages/shared/src/protection.js";
import type { ExecutionAttemptRecord, ExecutionPositionState } from "../../../../packages/shared/src/execution.js";
import type { EventBus } from "../realtime/event-bus.js";
import type { StorageService } from "../storage/storage-service.js";
import type { ExecutionPositionSource } from "../execution/execution-position-source.js";
import type { ProtectionAdapter } from "./protection-adapter.js";

export const PROTECTION_PREVIEW_TTL_MS = 60_000;
export const DEFAULT_PROTECTION_ACTIVATION_TIMEOUT_MS = 10_000;

export type ProtectionServiceErrorCode =
  | "PROTECTION_PROVIDER_DISABLED"
  | "STORAGE_DEGRADED"
  | "PROTECTION_BUSY"
  | "POSITION_NOT_OPEN"
  | "POSITION_UNKNOWN"
  | "EXECUTION_ATTEMPT_UNRESOLVED"
  | "EXECUTION_ATTEMPT_NOT_CONFIRMED"
  | "NOT_LATEST_CONFIRMED_ATTEMPT"
  | "PROTECTION_ALREADY_EXISTS"
  | "PREVIEW_INVALID"
  | "PREVIEW_EXPIRED"
  | "PROTECTION_ACTIVATION_UNKNOWN";

export class ProtectionServiceError extends Error {
  constructor(readonly code: ProtectionServiceErrorCode, readonly status = protectionErrorStatus(code)) {
    super(code);
    this.name = "ProtectionServiceError";
  }
}

export interface ProtectionServiceOptions {
  provider: "FIXTURE";
  adapter: ProtectionAdapter;
  storage: StorageService;
  events: EventBus;
  positionSource: ExecutionPositionSource;
  setPositionState?: (state: ExecutionPositionState) => void;
  now?: () => Date;
  idGenerator?: () => string;
  tokenGenerator?: () => string;
  activationTimeoutMs?: number;
}

interface PrivatePreview {
  preview: ProtectionPreview;
  token: string;
  intent: ProtectionIntent;
}

export class ProtectionService {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly activationTimeoutMs: number;
  private preview: PrivatePreview | null = null;
  private expiredPreviewId: string | null = null;
  private busy = false;
  private runtime: ProtectionRuntimeState;

  constructor(private readonly options: ProtectionServiceOptions) {
    if (options.provider !== "FIXTURE" || options.adapter.provider !== options.provider) {
      throw new TypeError("Protection service requires a matching fixture adapter.");
    }
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.tokenGenerator = options.tokenGenerator ?? (() => randomBytes(32).toString("base64url"));
    this.activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_PROTECTION_ACTIVATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.activationTimeoutMs) || this.activationTimeoutMs < 1 || this.activationTimeoutMs > 60_000) {
      throw new RangeError("Protection activation timeout is outside the supported limit.");
    }
    this.runtime = this.makeRuntime("NONE", null, null, []);
  }

  async recover(): Promise<ProtectionRuntimeState> {
    this.clearPreview();
    if (!this.isStorageReady()) {
      this.replaceRuntime("UNKNOWN", null, null, ["STORAGE_DEGRADED"]);
      return this.getState();
    }
    try {
      let plan = this.options.storage.protectionPlans.getPositionGuardPlan();
      const last = plan ?? this.options.storage.protectionPlans.getLatestPlan();
      if (plan?.status === "PLANNED") {
        plan = this.options.storage.protectionPlans.transitionWithEventAndAudit({
          id: plan.id,
          expectedVersion: plan.version,
          status: "UNKNOWN",
          eventType: "PROTECTION_OUTCOME_UNKNOWN",
          eventPayload: { reason: "RECOVERY_AFTER_PLANNED" },
          audit: protectionAudit("PROTECTION_OUTCOME_UNKNOWN", "An interrupted fixture protection plan was recovered as unknown.", plan),
        });
        this.replaceRuntime("UNKNOWN", null, plan, ["PROTECTION_ACTIVATION_UNKNOWN"]);
        this.publishUnknown(plan, "RECOVERY_AFTER_PLANNED");
        return this.getState();
      }
      const restored = plan ?? last;
      if (!restored) {
        this.replaceRuntime("NONE", null, null, []);
        return this.getState();
      }
      if (restored.status === "ACTIVE") {
        this.options.setPositionState?.("OPEN");
        this.replaceRuntime("ACTIVE", restored, restored, []);
      } else if (restored.status === "UNKNOWN") {
        this.options.setPositionState?.("UNKNOWN");
        this.replaceRuntime("UNKNOWN", null, restored, ["PROTECTION_ACTIVATION_UNKNOWN"]);
      } else if (restored.status === "TRIGGERED_TP" || restored.status === "TRIGGERED_SL") {
        this.options.setPositionState?.("UNKNOWN");
        this.replaceRuntime(restored.status, null, restored, []);
      } else if (restored.status === "ERROR") {
        this.replaceRuntime("ERROR", null, restored, ["PROTECTION_ACTIVATION_REJECTED"]);
      } else {
        this.replaceRuntime("UNKNOWN", null, restored, ["PROTECTION_ACTIVATION_UNKNOWN"]);
      }
      this.publishState();
    } catch {
      this.replaceRuntime("UNKNOWN", null, null, ["STORAGE_DEGRADED"]);
    }
    return this.getState();
  }

  getState(): ProtectionRuntimeState {
    this.expirePreviewIfNeeded();
    return ProtectionRuntimeStateSchema.parse(this.runtime);
  }

  createPreview(intentValue: ProtectionIntent): { preview: ProtectionPreview; confirmationToken: string; state: ProtectionRuntimeState } {
    this.assertNotBusy();
    this.assertStorageReady();
    const intent = ProtectionIntentSchema.parse(intentValue);
    const { attempt, entryPrice, size } = this.loadEligibleAttempt(intent.executionAttemptId);
    const existing = this.options.storage.protectionPlans.getByAttemptId(attempt.attemptId);
    if (existing && existing.status !== "ERROR") throw new ProtectionServiceError("PROTECTION_ALREADY_EXISTS");
    const guarded = this.options.storage.protectionPlans.getPositionGuardPlan();
    if (guarded) throw new ProtectionServiceError("PROTECTION_ALREADY_EXISTS");

    const now = this.clockNow();
    const preview = ProtectionPreviewSchema.parse({
      previewId: this.idGenerator(),
      executionAttemptId: attempt.attemptId,
      symbol: attempt.symbol,
      side: attempt.side,
      entryPrice,
      positionSize: size,
      leverage: attempt.leverage,
      takeProfit: {
        ...intent.takeProfit,
        targetPrice: deriveProtectionPrice({ side: attempt.side, entryPrice, leverage: attempt.leverage, legType: "TAKE_PROFIT", ...intent.takeProfit }),
      },
      stopLoss: {
        ...intent.stopLoss,
        targetPrice: deriveProtectionPrice({ side: attempt.side, entryPrice, leverage: attempt.leverage, legType: "STOP_LOSS", ...intent.stopLoss }),
      },
      expiresAt: new Date(now.getTime() + PROTECTION_PREVIEW_TTL_MS).toISOString(),
    });
    validateTargetDirection(preview);
    const token = this.tokenGenerator();
    if (token.length < 24 || token.length > 256 || token === preview.previewId) throw new Error("Protection token generator returned an invalid token.");
    this.options.storage.auditEvents.appendAuditEvent(
      protectionAudit("PROTECTION_PREVIEW_CREATED", "A fixture protection preview was created.", preview),
    );
    this.preview = {
      preview: freezePreview(preview),
      token,
      intent: Object.freeze({
        executionAttemptId: intent.executionAttemptId,
        takeProfit: Object.freeze({ ...intent.takeProfit }),
        stopLoss: Object.freeze({ ...intent.stopLoss }),
      }),
    };
    this.expiredPreviewId = null;
    this.replaceRuntime("PREVIEW_READY", null, this.options.storage.protectionPlans.getLatestPlan(), []);
    this.publishState();
    const response = ProtectionPreviewResponseSchema.parse({ preview: this.preview.preview, confirmationToken: token, state: this.getState() });
    return { ...response, preview: this.preview.preview };
  }

  async confirm(inputValue: ProtectionConfirmationInput): Promise<ProtectionRuntimeState> {
    if (this.busy) throw new ProtectionServiceError("PROTECTION_BUSY");
    const input = ProtectionConfirmationInputSchema.parse(inputValue);
    this.expirePreviewIfNeeded();
    const stored = this.preview;
    if (!stored || stored.preview.previewId !== input.previewId || !tokensMatch(stored.token, input.confirmationToken)) {
      input.previewId = "";
      input.confirmationToken = "";
      if (inputValue.previewId && inputValue.previewId === this.expiredPreviewId) throw new ProtectionServiceError("PREVIEW_EXPIRED");
      throw new ProtectionServiceError("PREVIEW_INVALID");
    }
    if (Date.parse(stored.preview.expiresAt) <= this.clockNow().getTime()) {
      this.clearPreview();
      input.previewId = "";
      input.confirmationToken = "";
      this.replaceRuntime("NONE", null, this.runtime.lastPlan, ["PREVIEW_EXPIRED"]);
      this.publishState();
      throw new ProtectionServiceError("PREVIEW_EXPIRED");
    }
    this.clearPreview();
    input.previewId = "";
    input.confirmationToken = "";
    this.replaceRuntime("NONE", null, this.runtime.lastPlan, []);
    this.publishState();
    this.busy = true;
    try {
      this.assertStorageReady();
      const { attempt, entryPrice, size } = this.loadEligibleAttempt(stored.intent.executionAttemptId);
      if (attempt.attemptId !== stored.preview.executionAttemptId
        || attempt.side !== stored.preview.side
        || entryPrice !== stored.preview.entryPrice
        || size !== stored.preview.positionSize
        || attempt.leverage !== stored.preview.leverage) {
        throw new ProtectionServiceError("PREVIEW_INVALID");
      }
      const existing = this.options.storage.protectionPlans.getByAttemptId(attempt.attemptId);
      const guard = this.options.storage.protectionPlans.getPositionGuardPlan();
      if (guard) throw new ProtectionServiceError("PROTECTION_ALREADY_EXISTS");
      if (existing && existing.status !== "ERROR") throw new ProtectionServiceError("PROTECTION_ALREADY_EXISTS");

      const timestamp = this.clockNow().toISOString();
      const planId = existing?.id ?? this.idGenerator();
      const plan = ProtectionPlanSchema.parse({
        id: planId,
        executionAttemptId: attempt.attemptId,
        provider: "FIXTURE",
        symbol: attempt.symbol,
        side: attempt.side,
        entryPrice,
        positionSize: size,
        leverage: attempt.leverage,
        takeProfit: stored.preview.takeProfit,
        stopLoss: stored.preview.stopLoss,
        status: "PLANNED",
        triggeredLeg: null,
        fixtureProtectionId: null,
        createdAt: existing?.createdAt ?? timestamp,
        activatedAt: null,
        triggeredAt: null,
        updatedAt: timestamp,
        version: existing?.version ?? 1,
      });
      const planned = existing
        ? this.options.storage.protectionPlans.rearmFailedPlanWithEventAndAudit({
            plan,
            expectedVersion: existing.version,
            eventType: "PROTECTION_PLANNED",
            eventPayload: { status: "PLANNED", rearmedAfterExplicitFixtureFailure: true },
            audit: protectionAudit("PROTECTION_PLANNED", "A user-confirmed fixture protection plan was durably recorded.", plan),
          })
        : this.options.storage.protectionPlans.createPlanWithEventAndAudit({
            plan,
            eventType: "PROTECTION_PLANNED",
            eventPayload: { status: "PLANNED" },
            audit: protectionAudit("PROTECTION_PLANNED", "A user-confirmed fixture protection plan was durably recorded.", plan),
          });
      this.replaceRuntime("PLANNED", planned, planned, []);
      this.publishState();

      let result: unknown;
      try {
        result = await withTimeout(this.options.adapter.activate(planned), this.activationTimeoutMs);
      } catch {
        return this.markActivationUnknown(planned);
      }
      const parsed = ProtectionAdapterResultSchema.safeParse(result);
      if (!parsed.success) return this.markActivationUnknown(planned);
      if (parsed.data.status === "FAILED_NOT_ACTIVATED") return this.markActivationFailed(planned);
      return this.markActive(planned, parsed.data.fixtureProtectionId);
    } catch (error) {
      if (error instanceof ProtectionServiceError) throw error;
      if (this.runtime.status === "PLANNED") {
        const activePlan = this.runtime.activePlan;
        this.replaceRuntime("UNKNOWN", activePlan, activePlan, ["STORAGE_DEGRADED"]);
        this.publishState();
        throw new ProtectionServiceError("STORAGE_DEGRADED", 503);
      }
      this.replaceRuntime("NONE", null, this.runtime.lastPlan, ["STORAGE_DEGRADED"]);
      this.publishState();
      throw new ProtectionServiceError("STORAGE_DEGRADED", 503);
    } finally {
      this.busy = false;
    }
  }

  /** Internal fixture-only evaluator; no HTTP route exposes mark input. */
  evaluateFixtureMark(markPrice: number): ProtectionRuntimeState {
    const plan = this.runtime.activePlan;
    if (this.runtime.status !== "ACTIVE" || !plan || plan.status !== "ACTIVE") return this.getState();
    const trigger = evaluateProtectionTrigger({
      side: plan.side,
      markPrice,
      takeProfitTarget: plan.takeProfit.targetPrice,
      stopLossTarget: plan.stopLoss.targetPrice,
    });
    if (trigger === "NONE") return this.getState();
    if (trigger === "UNKNOWN") {
      const unknown = this.options.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id,
        expectedVersion: plan.version,
        status: "UNKNOWN",
        eventType: "PROTECTION_OUTCOME_UNKNOWN",
        eventPayload: { reason: "TRIGGER_AMBIGUOUS" },
        audit: protectionAudit("PROTECTION_OUTCOME_UNKNOWN", "Fixture mark crossed both protection boundaries; outcome is unknown.", plan),
      });
      this.options.setPositionState?.("UNKNOWN");
      this.replaceRuntime("UNKNOWN", null, unknown, ["PROTECTION_TRIGGER_AMBIGUOUS"]);
      this.publishUnknown(unknown, "TRIGGER_AMBIGUOUS");
      return this.getState();
    }
    const leg = trigger === "TRIGGERED_TP" ? "TAKE_PROFIT" : "STOP_LOSS";
    const nextStatus = trigger as Extract<DurableProtectionStatus, "TRIGGERED_TP" | "TRIGGERED_SL">;
    const timestamp = this.clockNow().toISOString();
    const triggered = this.options.storage.protectionPlans.transitionWithEventAndAudit({
      id: plan.id,
      expectedVersion: plan.version,
      status: nextStatus,
      patch: { triggeredLeg: leg, triggeredAt: timestamp },
      eventType: nextStatus === "TRIGGERED_TP" ? "PROTECTION_TP_TRIGGERED_FIXTURE" : "PROTECTION_SL_TRIGGERED_FIXTURE",
      eventPayload: { leg, markPrice, targetPrice: leg === "TAKE_PROFIT" ? plan.takeProfit.targetPrice : plan.stopLoss.targetPrice, positionClosed: false },
      audit: protectionAudit(nextStatus === "TRIGGERED_TP" ? "PROTECTION_TP_TRIGGERED_FIXTURE" : "PROTECTION_SL_TRIGGERED_FIXTURE",
        "Fixture price condition crossed; no position close was performed.", plan),
    });
    this.options.setPositionState?.("UNKNOWN");
    this.replaceRuntime(nextStatus, null, triggered, []);
    this.options.events.publish({
      version: 1,
      type: "protection.triggered",
      timestamp,
      payload: {
        plan: triggered,
        leg,
        markPrice,
        targetPrice: leg === "TAKE_PROFIT" ? plan.takeProfit.targetPrice : plan.stopLoss.targetPrice,
        positionClosed: false,
      },
    });
    this.publishState();
    return this.getState();
  }

  private loadEligibleAttempt(attemptId: string): { attempt: ExecutionAttemptRecord; entryPrice: number; size: number } {
    const position = this.readPositionState();
    if (position === "UNKNOWN") throw new ProtectionServiceError("POSITION_UNKNOWN");
    if (position !== "OPEN") throw new ProtectionServiceError("POSITION_NOT_OPEN");
    if (this.options.storage.executionAttempts.getBlockingAttempt()) throw new ProtectionServiceError("EXECUTION_ATTEMPT_UNRESOLVED");
    const attempt = this.options.storage.executionAttempts.getAttempt(attemptId);
    if (!attempt || attempt.status !== "CONFIRMED") throw new ProtectionServiceError("EXECUTION_ATTEMPT_NOT_CONFIRMED");
    const latest = this.options.storage.executionAttempts.getLatestConfirmedAttempt();
    if (!latest || latest.attemptId !== attempt.attemptId) throw new ProtectionServiceError("NOT_LATEST_CONFIRMED_ATTEMPT");
    const evidence = attempt.evidence;
    if (!attempt.confirmedAt || !evidence || evidence.kind !== "MATCHED_OPEN"
      || evidence.source !== "FIXTURE" || evidence.symbol !== "GPS_USDT"
      || evidence.side !== attempt.side || attempt.symbol !== "GPS_USDT"
      || attempt.observedSide !== attempt.side
      || attempt.observedEntryPrice !== evidence.entryPrice
      || attempt.observedSize !== evidence.size
      || !Number.isFinite(attempt.leverage) || attempt.leverage <= 0) {
      throw new ProtectionServiceError("EXECUTION_ATTEMPT_NOT_CONFIRMED");
    }
    return { attempt, entryPrice: evidence.entryPrice, size: evidence.size };
  }

  private async markActive(plan: ProtectionPlan, fixtureProtectionId: string): Promise<ProtectionRuntimeState> {
    const timestamp = this.clockNow().toISOString();
    try {
      const active = this.options.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id,
        expectedVersion: plan.version,
        status: "ACTIVE",
        patch: { fixtureProtectionId, activatedAt: timestamp },
        eventType: "PROTECTION_ACTIVATED_FIXTURE",
        eventPayload: { provider: "FIXTURE", fixtureProtectionId },
        audit: protectionAudit("PROTECTION_ACTIVATED_FIXTURE", "Fixture protection is active; no exchange order was created.", plan),
      });
      this.options.setPositionState?.("OPEN");
      this.replaceRuntime("ACTIVE", active, active, []);
      this.options.events.publish({ version: 1, type: "protection.activated", timestamp, payload: active });
      this.publishState();
      return this.getState();
    } catch {
      return this.markActivationUnknown(plan);
    }
  }

  private async markActivationFailed(plan: ProtectionPlan): Promise<ProtectionRuntimeState> {
    try {
      const failed = this.options.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id,
        expectedVersion: plan.version,
        status: "ERROR",
        eventType: "PROTECTION_ACTIVATION_FAILED",
        eventPayload: { status: "FAILED_NOT_ACTIVATED", retryRequiresNewUserPreview: true },
        audit: protectionAudit("PROTECTION_ACTIVATION_FAILED", "Fixture adapter explicitly reported that protection was not activated.", plan),
      });
      this.replaceRuntime("ERROR", null, failed, ["PROTECTION_ACTIVATION_REJECTED"]);
      this.publishState();
    } catch {
      this.replaceRuntime("UNKNOWN", plan, plan, ["STORAGE_DEGRADED"]);
      this.publishState();
    }
    return this.getState();
  }

  private async markActivationUnknown(plan: ProtectionPlan): Promise<ProtectionRuntimeState> {
    try {
      const unknown = this.options.storage.protectionPlans.transitionWithEventAndAudit({
        id: plan.id,
        expectedVersion: plan.version,
        status: "UNKNOWN",
        eventType: "PROTECTION_OUTCOME_UNKNOWN",
        eventPayload: { reason: "ACTIVATION_OUTCOME_UNKNOWN" },
        audit: protectionAudit("PROTECTION_OUTCOME_UNKNOWN", "Fixture activation outcome is unknown; duplicate protection is blocked.", plan),
      });
      this.replaceRuntime("UNKNOWN", null, unknown, ["PROTECTION_ACTIVATION_UNKNOWN"]);
      this.publishUnknown(unknown, "ACTIVATION_OUTCOME_UNKNOWN");
    } catch {
      this.replaceRuntime("UNKNOWN", plan, plan, ["STORAGE_DEGRADED"]);
      this.publishState();
    }
    return this.getState();
  }

  private publishUnknown(plan: ProtectionPlan, reason: "ACTIVATION_OUTCOME_UNKNOWN" | "TRIGGER_AMBIGUOUS" | "RECOVERY_AFTER_PLANNED"): void {
    this.options.events.publish({
      version: 1,
      type: "protection.unknown",
      timestamp: this.clockNow().toISOString(),
      payload: { plan, reason },
    });
    this.publishState();
  }

  private publishState(): void {
    this.options.events.publish({ version: 1, type: "protection.state", timestamp: this.clockNow().toISOString(), payload: this.getState() });
  }

  private replaceRuntime(
    status: ProtectionRuntimeState["status"],
    activePlan: ProtectionPlan | null,
    lastPlan: ProtectionPlan | null,
    reasons: ProtectionRuntimeState["reasons"],
  ): void {
    this.runtime = this.makeRuntime(status, activePlan, lastPlan, reasons);
  }

  private makeRuntime(
    status: ProtectionRuntimeState["status"],
    activePlan: ProtectionPlan | null,
    lastPlan: ProtectionPlan | null,
    reasons: ProtectionRuntimeState["reasons"],
  ): ProtectionRuntimeState {
    return ProtectionRuntimeStateSchema.parse({
      status,
      provider: "FIXTURE",
      activePreview: this.preview?.preview ?? null,
      activePlan,
      lastPlan,
      reasons,
      updatedAt: this.clockNow().toISOString(),
    });
  }

  private expirePreviewIfNeeded(): void {
    if (this.preview && Date.parse(this.preview.preview.expiresAt) <= this.clockNow().getTime()) {
      this.expiredPreviewId = this.preview.preview.previewId;
      this.clearPreview(true);
      this.replaceRuntime("NONE", null, this.runtime.lastPlan, ["PREVIEW_EXPIRED"]);
    }
  }

  private clearPreview(preserveExpired = false): void {
    if (this.preview) {
      this.preview.token = "";
    }
    this.preview = null;
    if (!preserveExpired) this.expiredPreviewId = null;
  }

  private readPositionState(): ExecutionPositionState {
    const state = this.options.positionSource.getPositionState();
    if (state === "OPEN" || state === "FLAT" || state === "UNKNOWN") return state;
    throw new ProtectionServiceError("POSITION_UNKNOWN");
  }

  private assertStorageReady(): void {
    if (!this.isStorageReady()) throw new ProtectionServiceError("STORAGE_DEGRADED", 503);
  }

  private isStorageReady(): boolean {
    return this.options.storage.isReady && this.options.storage.getHealth().status === "READY";
  }

  private assertNotBusy(): void {
    if (this.busy) throw new ProtectionServiceError("PROTECTION_BUSY");
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Protection clock is invalid.");
    return value;
  }
}

function validateTargetDirection(preview: ProtectionPreview): void {
  const tp = preview.takeProfit.targetPrice;
  const sl = preview.stopLoss.targetPrice;
  const entry = preview.entryPrice;
  const valid = preview.side === "LONG"
    ? tp > entry && sl < entry
    : tp < entry && sl > entry;
  if (!valid || tp === sl || tp <= 0 || sl <= 0) throw new ProtectionServiceError("PREVIEW_INVALID", 400);
}

function freezePreview(preview: ProtectionPreview): ProtectionPreview {
  return Object.freeze({
    ...preview,
    takeProfit: Object.freeze({ ...preview.takeProfit }),
    stopLoss: Object.freeze({ ...preview.stopLoss }),
  });
}

function tokensMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("PROTECTION_ACTIVATION_TIMEOUT")), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function protectionAudit(
  eventType: string,
  message: string,
  details: Pick<ProtectionPlan, "id" | "executionAttemptId" | "provider" | "symbol" | "side"> | ProtectionPreview,
) {
  return {
    category: "TRADING" as const,
    eventType,
    severity: eventType === "PROTECTION_OUTCOME_UNKNOWN" ? "WARN" as const : "INFO" as const,
    message,
    payload: {
      protectionId: "id" in details ? details.id : details.previewId,
      attemptId: details.executionAttemptId,
      provider: "FIXTURE",
      symbol: details.symbol,
      side: details.side,
    },
  };
}

function protectionErrorStatus(code: ProtectionServiceErrorCode): number {
  if (code === "STORAGE_DEGRADED" || code === "PROTECTION_PROVIDER_DISABLED") return 503;
  if (code === "PREVIEW_INVALID") return 400;
  return 409;
}
