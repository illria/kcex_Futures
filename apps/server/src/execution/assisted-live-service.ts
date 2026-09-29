import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  AssistedExecutionStateSchema,
  AssistedLiveOrderIntentSchema,
  AssistedLivePreviewSchema,
  ExecutionAdapterResultSchema,
  ExecutionConfirmInputSchema,
  ExecutionPreviewInputSchema,
  ExecutionProviderSchema,
  ExecutionReasonCodeSchema,
  ExecutionStatusSchema,
  type AssistedExecutionState,
  type AssistedLiveOrderIntent,
  type AssistedLivePreview,
  type ExecutionConfirmInput,
  type ExecutionFailureKind,
  type ExecutionPreviewInput,
  type ExecutionProvider,
  type ExecutionReasonCode,
  type ExecutionStatus,
} from "../../../../packages/shared/src/execution.js";
import { RiskTradeIntentSchema, type RiskDecision } from "../../../../packages/shared/src/risk.js";
import type { RiskService } from "../risk/risk-service.js";
import type { StorageService } from "../storage/storage-service.js";
import { EventBus } from "../realtime/event-bus.js";
import type { ExecutionAdapter } from "./execution-adapter.js";
import { ExecutionArmService, EXECUTION_ARM_ACKNOWLEDGEMENT } from "./execution-arm.js";
import { AssistedExecutionError } from "./execution-errors.js";
import type { ExecutionPositionSource } from "./execution-position-source.js";

export const DEFAULT_PREVIEW_TTL_MS = 60_000;
export const DEFAULT_EXECUTION_SUBMIT_TIMEOUT_MS = 10_000;

export interface AssistedLiveServiceOptions {
  provider: ExecutionProvider;
  adapter: ExecutionAdapter;
  storage: StorageService;
  risk: RiskService;
  events: EventBus;
  positionSource: ExecutionPositionSource;
  now?: () => Date;
  idGenerator?: () => string;
  confirmationTokenGenerator?: () => string;
  armService?: ExecutionArmService;
  previewTtlMs?: number;
  submitTimeoutMs?: number;
  referencePrice?: () => number | null;
}

export class AssistedLiveService {
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly tokenGenerator: () => string;
  private readonly arm: ExecutionArmService;
  private readonly previewTtlMs: number;
  private readonly submitTimeoutMs: number;
  private inFlight = false;
  private disarmRequestedDuringPrecheck = false;
  private activePreview: AssistedLivePreview | null = null;
  private confirmationToken: string | null = null;
  private state: AssistedExecutionState;

  constructor(private readonly options: AssistedLiveServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.tokenGenerator = options.confirmationTokenGenerator ?? randomUUID;
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_EXECUTION_SUBMIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.previewTtlMs) || this.previewTtlMs < 1 || this.previewTtlMs > DEFAULT_PREVIEW_TTL_MS) {
      throw new RangeError("Preview duration is outside the supported limit.");
    }
    if (!Number.isSafeInteger(this.submitTimeoutMs) || this.submitTimeoutMs < 1 || this.submitTimeoutMs > 60_000) {
      throw new RangeError("Submission timeout is outside the supported limit.");
    }
    const provider = ExecutionProviderSchema.parse(options.provider);
    if (options.adapter.provider !== provider) throw new TypeError("Execution adapter does not match its configured provider.");
    this.arm = options.armService ?? new ExecutionArmService(() => this.clockNow().getTime());
    this.state = AssistedExecutionStateSchema.parse({
      status: "DISARMED",
      provider,
      armedUntil: null,
      activePreview: null,
      lastSubmission: null,
      reasons: [],
      updatedAt: this.timestamp(),
    });
  }

  getState(): AssistedExecutionState {
    this.syncArmExpiry();
    return AssistedExecutionStateSchema.parse(this.state);
  }

  armRuntime(acknowledgement: string): AssistedExecutionState {
    this.assertNotBusy();
    this.assertFixtureProvider();
    if (acknowledgement !== EXECUTION_ARM_ACKNOWLEDGEMENT) {
      throw new AssistedExecutionError("INVALID_ARM_ACKNOWLEDGEMENT", 400);
    }
    this.assertStorageReady();
    const armedUntil = this.arm.arm(acknowledgement);
    try {
      this.audit("LIVE_ARMED", { provider: this.options.provider, armedUntil });
    } catch {
      this.arm.disarm();
      this.clearPrivatePreview();
      this.replaceState("HALTED", ["STORAGE_DEGRADED"]);
      throw new AssistedExecutionError("STORAGE_DEGRADED", 503);
    }
    this.clearPrivatePreview();
    this.replaceState("ARMED", [], armedUntil);
    return this.getState();
  }

  disarm(): AssistedExecutionState {
    this.arm.disarm();
    this.clearPrivatePreview();
    if (this.inFlight && this.state.status !== "SUBMITTING") this.disarmRequestedDuringPrecheck = true;
    const currentStatus = this.inFlight ? this.state.status : "DISARMED";
    let reasons: ExecutionReasonCode[] = [];
    try {
      this.audit("LIVE_DISARMED", { provider: this.options.provider });
    } catch {
      reasons = ["STORAGE_DEGRADED"];
    }
    this.replaceState(currentStatus, reasons, null);
    return this.getState();
  }

  createPreview(inputValue: ExecutionPreviewInput): { preview: AssistedLivePreview; confirmationToken: string; state: AssistedExecutionState } {
    this.syncArmExpiry();
    this.assertNotBusy();
    this.assertFixtureProvider();
    if (!this.arm.isArmed()) throw new AssistedExecutionError("ARM_REQUIRED");
    this.assertStorageReady();
    const input = ExecutionPreviewInputSchema.parse(inputValue);
    const now = this.clockNow();
    const intent = AssistedLiveOrderIntentSchema.parse({
      mode: "LIVE",
      symbol: "GPS_USDT",
      side: input.side,
      orderType: "MARKET",
      marginMode: "ISOLATED",
      marginUsdt: input.marginUsdt,
      leverage: input.leverage,
    });
    const referencePrice = this.readReferencePrice();
    const preview = AssistedLivePreviewSchema.parse({
      previewId: this.idGenerator(),
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      marginMode: intent.marginMode,
      marginUsdt: intent.marginUsdt,
      leverage: intent.leverage,
      provider: "FIXTURE",
      referencePrice,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.previewTtlMs).toISOString(),
    });
    const token = this.tokenGenerator();
    if (preview.previewId === token) throw new Error("Preview and confirmation identifiers must differ.");

    this.audit("LIVE_PREVIEW_CREATED", previewAuditPayload(preview));
    this.activePreview = Object.freeze(preview);
    this.confirmationToken = token;
    const armedUntil = this.arm.getArmedUntil();
    this.replaceState("PREVIEW_READY", [], armedUntil);
    this.replaceState("AWAITING_CONFIRMATION", [], armedUntil);
    return { preview: this.activePreview, confirmationToken: token, state: this.getState() };
  }

  async confirm(inputValue: ExecutionConfirmInput): Promise<AssistedExecutionState> {
    if (this.inFlight) throw new AssistedExecutionError("EXECUTION_BUSY");
    this.syncArmExpiry();
    this.assertFixtureProvider();
    if (!this.arm.isArmed()) throw new AssistedExecutionError("ARM_REQUIRED");
    const input = ExecutionConfirmInputSchema.parse(inputValue);
    const preview = this.activePreview;
    if (!preview || !this.confirmationToken || preview.previewId !== input.previewId
      || !constantTimeTokenEquals(this.confirmationToken, input.confirmationToken)) {
      throw new AssistedExecutionError("PREVIEW_INVALID", 400);
    }
    input.confirmationToken = "";
    if (Date.parse(preview.expiresAt) <= this.clockNow().getTime()) {
      this.clearPrivatePreview();
      this.replaceState("ARMED", ["PREVIEW_EXPIRED"], this.arm.getArmedUntil());
      throw new AssistedExecutionError("PREVIEW_EXPIRED");
    }

    this.inFlight = true;
    this.disarmRequestedDuringPrecheck = false;
    const wasArmed = this.arm.consume();
    this.clearPrivatePreview();
    this.replaceState("PRECHECK", [], null);
    const intent: AssistedLiveOrderIntent = {
      mode: "LIVE",
      symbol: preview.symbol,
      side: preview.side,
      orderType: preview.orderType,
      marginMode: preview.marginMode,
      marginUsdt: preview.marginUsdt,
      leverage: preview.leverage,
    };
    try {
      let positionState: "FLAT" | "OPEN" | "UNKNOWN" = "UNKNOWN";
      try {
        const value = await this.options.positionSource.getPositionState();
        if (value === "FLAT" || value === "OPEN" || value === "UNKNOWN") positionState = value;
      } catch {
        positionState = "UNKNOWN";
      }

      let decision: RiskDecision;
      try {
        decision = await this.options.risk.evaluatePreTrade(
          RiskTradeIntentSchema.parse({
            mode: intent.mode,
            symbol: intent.symbol,
            side: intent.side,
            marginUsdt: intent.marginUsdt,
            leverage: intent.leverage,
          }),
          {
            liveTrading: wasArmed && this.options.provider === "FIXTURE",
            positionState,
          },
        );
      } catch {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"]);
        return this.getState();
      }

      if (!decision.allowed) {
        let auditFailed = false;
        try {
          this.audit("LIVE_PRECHECK_BLOCKED", { ...previewAuditPayload(preview), reasonCodes: decision.reasons });
        } catch {
          auditFailed = true;
        }
        this.replaceState(
          auditFailed || isFailClosedRiskDecision(decision) ? "HALTED" : "BLOCKED",
          auditFailed ? ["STORAGE_DEGRADED"] : ["RISK_PRECHECK_BLOCKED"],
        );
        return this.getState();
      }

      if (this.disarmRequestedDuringPrecheck) {
        this.replaceState("DISARMED", [], null);
        return this.getState();
      }

      try {
        this.audit("LIVE_SUBMIT_ATTEMPT", previewAuditPayload(preview));
      } catch {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"]);
        return this.getState();
      }

      this.replaceState("SUBMITTING", []);
      const result = await this.submitWithTimeout(preview);
      const baseSummary = {
        previewId: preview.previewId,
        provider: "FIXTURE" as const,
        symbol: preview.symbol,
        side: preview.side,
      };

      if (result.status === "FAILED") {
        try {
          await this.options.risk.recordExecutionFailure({ failureKind: riskFailureKind(result.failureKind) });
        } catch {
          this.replaceState("HALTED", ["STORAGE_DEGRADED"], null);
          return this.getState();
        }
        let auditFailed = false;
        try {
          this.audit("LIVE_SUBMIT_FAILED", { ...previewAuditPayload(preview), failureKind: result.failureKind });
        } catch {
          auditFailed = true;
        }
        this.replaceState(auditFailed ? "HALTED" : "FAILED", auditFailed ? ["STORAGE_DEGRADED"] : ["EXECUTION_FAILED"], null, {
          ...baseSummary,
          status: "FAILED",
          failureKind: result.failureKind,
          failedAt: result.failedAt,
        });
        return this.getState();
      }

      let auditFailed = false;
      try {
        this.audit("LIVE_SUBMITTED_FIXTURE", {
          ...previewAuditPayload(preview),
          fixtureSubmissionId: result.fixtureSubmissionId,
          submittedAt: result.submittedAt,
        });
      } catch {
        auditFailed = true;
      }
      this.options.events.publish({
        version: 1,
        type: "execution.submitted",
        timestamp: this.timestamp(),
        payload: {
          previewId: preview.previewId,
          provider: "FIXTURE",
          symbol: preview.symbol,
          side: preview.side,
          submittedAt: result.submittedAt,
        },
      });
      this.replaceState(auditFailed ? "HALTED" : "SUBMITTED", auditFailed ? ["STORAGE_DEGRADED"] : [], null, {
        ...baseSummary,
        status: "SUBMITTED",
        fixtureSubmissionId: result.fixtureSubmissionId,
        submittedAt: result.submittedAt,
      });
      return this.getState();
    } finally {
      this.inFlight = false;
      this.disarmRequestedDuringPrecheck = false;
    }
  }

  close(): void {
    this.arm.disarm();
    this.clearPrivatePreview();
    if (!this.inFlight) this.replaceState("DISARMED", [], null);
  }

  private assertFixtureProvider(): void {
    if (this.options.provider !== "FIXTURE") throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
  }

  private assertNotBusy(): void {
    if (this.inFlight) throw new AssistedExecutionError("EXECUTION_BUSY");
  }

  private assertStorageReady(): void {
    if (!this.options.storage.isReady || this.options.storage.getHealth().status !== "READY") {
      throw new AssistedExecutionError("STORAGE_DEGRADED", 503);
    }
  }

  private audit(eventType: string, payload: Record<string, unknown>): void {
    this.assertStorageReady();
    this.options.storage.auditEvents.appendAuditEvent({
      category: eventType === "LIVE_PRECHECK_BLOCKED" ? "RISK" : "TRADING",
      eventType,
      severity: eventType === "LIVE_SUBMIT_FAILED" || eventType === "LIVE_PRECHECK_BLOCKED" ? "WARN" : "INFO",
      message: auditMessage(eventType),
      payload,
    });
  }

  private readReferencePrice(): number | null {
    try {
      const value = this.options.referencePrice?.();
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  private async submitWithTimeout(preview: AssistedLivePreview) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new SubmissionTimeoutError()), this.submitTimeoutMs);
    });
    try {
      const result = await Promise.race([this.options.adapter.submit(preview), timeout]);
      return ExecutionAdapterResultSchema.parse(result);
    } catch (error) {
      const kind = error instanceof SubmissionTimeoutError ? "TIMEOUT" : "EXECUTION_FAILED";
      const failedAt = this.timestamp();
      return ExecutionAdapterResultSchema.parse({ status: "FAILED", failureKind: kind, failedAt });
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private syncArmExpiry(): void {
    if (this.state.armedUntil === null || this.arm.isArmed()) return;
    this.clearPrivatePreview();
    const status: ExecutionStatus = this.inFlight ? this.state.status : "DISARMED";
    this.replaceState(status, ["ARM_EXPIRED"], null);
  }

  private clearPrivatePreview(): void {
    this.activePreview = null;
    this.confirmationToken = null;
  }

  private replaceState(
    status: ExecutionStatus,
    reasons: ExecutionReasonCode[],
    armedUntil: string | null = null,
    lastSubmission = this.state.lastSubmission,
  ): void {
    const next = AssistedExecutionStateSchema.parse({
      status: ExecutionStatusSchema.parse(status),
      provider: this.options.provider,
      armedUntil,
      activePreview: this.activePreview,
      lastSubmission,
      reasons: reasons.map((reason) => ExecutionReasonCodeSchema.parse(reason)),
      updatedAt: this.timestamp(),
    });
    this.state = next;
    this.options.events.publish({ version: 1, type: "execution.state", timestamp: this.timestamp(), payload: next });
  }

  private timestamp(): string {
    return this.clockNow().toISOString();
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Execution clock is invalid.");
    return value;
  }
}

function constantTimeTokenEquals(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function previewAuditPayload(preview: AssistedLivePreview): Record<string, unknown> {
  return {
    previewId: preview.previewId,
    provider: preview.provider,
    symbol: preview.symbol,
    side: preview.side,
    marginUsdt: preview.marginUsdt,
    leverage: preview.leverage,
    orderType: preview.orderType,
    marginMode: preview.marginMode,
  };
}

function auditMessage(eventType: string): string {
  switch (eventType) {
    case "LIVE_ARMED": return "Local assisted execution was armed.";
    case "LIVE_DISARMED": return "Local assisted execution was disarmed.";
    case "LIVE_PREVIEW_CREATED": return "A fixture-only assisted execution preview was created.";
    case "LIVE_PRECHECK_BLOCKED": return "Assisted execution was blocked by the risk precheck.";
    case "LIVE_SUBMIT_ATTEMPT": return "A single fixture submission attempt began.";
    case "LIVE_SUBMITTED_FIXTURE": return "The fixture adapter accepted a submission attempt.";
    case "LIVE_SUBMIT_FAILED": return "The fixture submission attempt failed.";
    default: return "Assisted execution event.";
  }
}

function riskFailureKind(kind: ExecutionFailureKind): "EXECUTION_FAILED" | "TIMEOUT" {
  return kind === "TIMEOUT" ? "TIMEOUT" : "EXECUTION_FAILED";
}

function isFailClosedRiskDecision(decision: RiskDecision): boolean {
  return decision.reasons.some((reason) => [
    "POSITION_UNKNOWN",
    "CONSECUTIVE_FAILURE_LIMIT",
    "KILL_SWITCH_UNKNOWN",
    "STORAGE_DEGRADED",
  ].includes(reason));
}

class SubmissionTimeoutError extends Error {}
