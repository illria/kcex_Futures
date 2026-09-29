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
  type AssistedSubmissionSummary,
  type ExecutionAdapterResult,
  type ExecutionConfirmInput,
  type ExecutionFailureKind,
  type ExecutionAttemptRecord,
  type ExecutionPreviewInput,
  type ExecutionProvider,
  type ExecutionReasonCode,
  type ExecutionStatus,
  type PositionConfirmationEvidence,
} from "../../../../packages/shared/src/execution.js";
import { RiskTradeIntentSchema, type RiskDecision } from "../../../../packages/shared/src/risk.js";
import type { RiskService } from "../risk/risk-service.js";
import type { StorageService } from "../storage/storage-service.js";
import { EventBus } from "../realtime/event-bus.js";
import type { ExecutionAdapter } from "./execution-adapter.js";
import { ExecutionArmService, EXECUTION_ARM_ACKNOWLEDGEMENT } from "./execution-arm.js";
import { AssistedExecutionError } from "./execution-errors.js";
import type { ExecutionPositionSource } from "./execution-position-source.js";
import type { ExecutionAttemptPatch } from "../storage/execution-attempt-repository.js";
import {
  FixturePositionConfirmationSource,
  PositionConfirmationService,
  type PositionConfirmationResult,
  type PositionConfirmationSource,
} from "./position-confirmation-service.js";

export const DEFAULT_PREVIEW_TTL_MS = 60_000;
export const DEFAULT_EXECUTION_SUBMIT_TIMEOUT_MS = 10_000;

export interface AssistedLiveServiceOptions {
  provider: ExecutionProvider;
  adapter: ExecutionAdapter;
  storage: StorageService;
  risk: RiskService;
  events: EventBus;
  positionSource: ExecutionPositionSource;
  confirmationSource?: PositionConfirmationSource;
  confirmationService?: PositionConfirmationService;
  onConfirmed?: () => void;
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
  private readonly positionConfirmation: PositionConfirmationService;
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
    this.positionConfirmation = options.confirmationService ?? new PositionConfirmationService({
      source: options.confirmationSource ?? new FixturePositionConfirmationSource(),
      now: this.now,
    });
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

  /** Converts any interrupted in-flight attempt to durable UNKNOWN before the HTTP server listens. */
  async recover(): Promise<AssistedExecutionState> {
    this.arm.disarm();
    this.clearPrivatePreview();
    try {
      this.assertStorageReady();
      if (this.options.storage.executionAttempts.getBlockingAttemptCount() > 1) {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"], null);
        return this.getState();
      }
      let blocking = this.options.storage.executionAttempts.getBlockingAttempt();
      if (blocking && ["SUBMITTING", "SUBMITTED", "CONFIRMING"].includes(blocking.status)) {
        blocking = this.options.storage.executionAttempts.transitionAttemptWithAudit(
          blocking.attemptId,
          blocking.version,
          "UNKNOWN",
          { reason: "SUBMISSION_OUTCOME_UNKNOWN", unknownAt: this.timestamp() },
          attemptAudit(blocking, "LIVE_OUTCOME_UNKNOWN", "An interrupted fixture attempt was recovered as unknown.", {
            reason: "SUBMISSION_OUTCOME_UNKNOWN",
          }),
        );
        await this.recordUnknownRisk(blocking.attemptId);
        this.publishUnknown(blocking, null);
      }
      const latest = this.options.storage.executionAttempts.getLatestAttempt();
      if (latest) {
        const restoredStatus = statusForAttempt(latest.status);
        this.replaceState(restoredStatus, latest.status === "UNKNOWN" ? [latest.reason ?? "SUBMISSION_OUTCOME_UNKNOWN"] : [], null, toSummary(latest));
        if (latest.status === "UNKNOWN") await this.recordUnknownRisk(latest.attemptId);
        if (latest.status === "CONFIRMED") await this.options.risk.recordExecutionSuccess(latest.attemptId);
      }
    } catch {
      this.replaceState("HALTED", ["STORAGE_DEGRADED"], null);
    }
    return this.getState();
  }

  getState(): AssistedExecutionState {
    this.syncArmExpiry();
    return AssistedExecutionStateSchema.parse(this.state);
  }

  armRuntime(acknowledgement: string): AssistedExecutionState {
    this.assertNotBusy();
    this.assertFixtureProvider();
    this.assertNoBlockingAttempt();
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
    const blocking = this.options.storage.isReady ? this.options.storage.executionAttempts.getBlockingAttempt() : null;
    const currentStatus = blocking?.status === "UNKNOWN"
      ? "UNKNOWN"
      : this.inFlight ? this.state.status : "DISARMED";
    let reasons: ExecutionReasonCode[] = blocking?.status === "UNKNOWN" && blocking.reason
      ? [blocking.reason]
      : [];
    try {
      this.audit("LIVE_DISARMED", { provider: this.options.provider });
    } catch {
      reasons = ["STORAGE_DEGRADED"];
    }
    this.replaceState(currentStatus, reasons, null, blocking ? toSummary(blocking) : this.state.lastSubmission);
    return this.getState();
  }

  createPreview(inputValue: ExecutionPreviewInput): { preview: AssistedLivePreview; confirmationToken: string; state: AssistedExecutionState } {
    this.syncArmExpiry();
    this.assertNotBusy();
    this.assertFixtureProvider();
    this.assertNoBlockingAttempt();
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

    try {
      this.assertNoBlockingAttempt();
    } catch (error) {
      if (!(error instanceof AssistedExecutionError) || error.code !== "STORAGE_DEGRADED") throw error;
      this.arm.disarm();
      this.clearPrivatePreview();
      this.replaceState("HALTED", ["STORAGE_DEGRADED"], null);
      return this.getState();
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
      } catch { positionState = "UNKNOWN"; }

      let decision: RiskDecision;
      try {
        decision = await this.options.risk.evaluatePreTrade(
          RiskTradeIntentSchema.parse({ mode: intent.mode, symbol: intent.symbol, side: intent.side, marginUsdt: intent.marginUsdt, leverage: intent.leverage }),
          { liveTrading: wasArmed && this.options.provider === "FIXTURE", positionState },
        );
      } catch {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"]);
        return this.getState();
      }

      if (!decision.allowed) {
        let auditFailed = false;
        try { this.audit("LIVE_PRECHECK_BLOCKED", { ...previewAuditPayload(preview), riskReasons: decision.reasons }); }
        catch { auditFailed = true; }
        this.replaceState(auditFailed || isFailClosedRiskDecision(decision) ? "HALTED" : "BLOCKED",
          auditFailed ? ["STORAGE_DEGRADED"] : ["RISK_PRECHECK_BLOCKED"]);
        return this.getState();
      }
      if (this.disarmRequestedDuringPrecheck) {
        this.replaceState("DISARMED", [], null);
        return this.getState();
      }

      let attempt: ExecutionAttemptRecord;
      try {
        this.assertStorageReady();
        attempt = this.options.storage.executionAttempts.createSubmittingAttemptWithAudit({
          attemptId: this.idGenerator(),
          previewId: preview.previewId,
          symbol: preview.symbol,
          side: preview.side,
          marginUsdt: preview.marginUsdt,
          leverage: preview.leverage,
          auditPayload: previewAuditPayload(preview),
        });
      } catch {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"]);
        return this.getState();
      }
      this.replaceState("SUBMITTING", [], null, toSummary(attempt));

      const adapterOutcome = await this.submitWithTimeout(preview);
      if (adapterOutcome.kind === "AMBIGUOUS") {
        await this.markUnknown(attempt, "SUBMISSION_OUTCOME_UNKNOWN", null);
        return this.getState();
      }

      if (adapterOutcome.result.status === "FAILED") {
        let failed: ExecutionAttemptRecord;
        try {
          failed = this.options.storage.executionAttempts.transitionAttemptWithAudit(attempt.attemptId, attempt.version, "FAILED", {
            outcome: "NOT_SUBMITTED",
            failureKind: adapterOutcome.result.failureKind,
            failedAt: adapterOutcome.result.failedAt,
          }, attemptAudit(attempt, "LIVE_ATTEMPT_NOT_SUBMITTED", "Fixture adapter explicitly reported no submission.", {
            outcome: "NOT_SUBMITTED",
            failureKind: adapterOutcome.result.failureKind,
          }));
          await this.options.risk.recordExecutionFailure({
            failureKind: riskFailureKind(adapterOutcome.result.failureKind),
            executionAttemptId: attempt.attemptId,
          });
        } catch {
          this.replaceState("HALTED", ["STORAGE_DEGRADED"], null, toSummary(attempt));
          return this.getState();
        }
        this.replaceState("FAILED", ["EXECUTION_FAILED"], null, toSummary(failed));
        return this.getState();
      }

      let submitted: ExecutionAttemptRecord;
      try {
        submitted = this.options.storage.executionAttempts.transitionAttemptWithAudit(attempt.attemptId, attempt.version, "SUBMITTED", {
          fixtureSubmissionId: adapterOutcome.result.fixtureSubmissionId,
          submittedAt: adapterOutcome.result.submittedAt,
        }, attemptAudit(attempt, "LIVE_ATTEMPT_SUBMITTED", "Fixture adapter returned a validated SUBMITTED result."));
      } catch {
        await this.markUnknown(attempt, "SUBMISSION_OUTCOME_UNKNOWN", null);
        return this.getState();
      }
      this.options.events.publish({
        version: 1,
        type: "execution.submitted",
        timestamp: this.timestamp(),
        payload: {
          attemptId: attempt.attemptId,
          previewId: preview.previewId,
          provider: "FIXTURE",
          symbol: preview.symbol,
          side: preview.side,
          submittedAt: adapterOutcome.result.submittedAt,
        },
      });
      this.replaceState("SUBMITTED", [], null, toSummary(submitted));
      return await this.confirmPosition(submitted, preview);
    } finally {
      this.inFlight = false;
      this.disarmRequestedDuringPrecheck = false;
    }
  }

  /** Manual, read-only evidence reconciliation. This path never invokes ExecutionAdapter.submit(). */
  async reconcile(attemptId: string): Promise<AssistedExecutionState> {
    if (this.inFlight) throw new AssistedExecutionError("CONFIRMATION_BUSY");
    this.assertFixtureProvider();
    this.assertStorageReady();
    const attempt = this.options.storage.executionAttempts.getAttempt(attemptId);
    if (!attempt || attempt.status !== "UNKNOWN") throw new AssistedExecutionError("EXECUTION_ATTEMPT_NOT_FOUND", 404);
    this.inFlight = true;
    try {
      const confirming = this.options.storage.executionAttempts.transitionAttemptWithAudit(
        attempt.attemptId,
        attempt.version,
        "CONFIRMING",
        {
          reason: null,
          unknownAt: null,
          evidence: null,
          confirmationStartedAt: this.timestamp(),
          ...observedEvidencePatch(null),
        },
        attemptAudit(attempt, "LIVE_RECONCILIATION_STARTED", "Manual read-only fixture evidence reconciliation started."),
      );
      const previewContext = confirmationContext(confirming, this.timestamp());
      this.publishConfirming(confirming);
      this.replaceState("CONFIRMING", [], null, toSummary(confirming));
      return await this.evaluatePositionEvidence(confirming, previewContext, true);
    } catch {
      const persisted = this.options.storage.executionAttempts.getAttempt(attempt.attemptId);
      if (persisted?.status === "UNKNOWN") this.replaceState("UNKNOWN", [persisted.reason ?? "SUBMISSION_OUTCOME_UNKNOWN"], null, toSummary(persisted));
      else this.replaceState("HALTED", ["STORAGE_DEGRADED"]);
      return this.getState();
    } finally {
      this.inFlight = false;
    }
  }

  close(): void {
    this.arm.disarm();
    this.clearPrivatePreview();
    if (this.inFlight) return;
    try {
      const blocking = this.options.storage.isReady ? this.options.storage.executionAttempts.getBlockingAttempt() : null;
      if (blocking) {
        this.replaceState(statusForAttempt(blocking.status), blocking.status === "UNKNOWN" && blocking.reason ? [blocking.reason] : [], null, toSummary(blocking));
      } else if (!["CONFIRMED", "FAILED", "HALTED"].includes(this.state.status)) {
        this.replaceState("DISARMED", [], null);
      }
    } catch {
      this.replaceState("HALTED", ["STORAGE_DEGRADED"], null);
    }
  }

  private async confirmPosition(attempt: ExecutionAttemptRecord, preview: AssistedLivePreview): Promise<AssistedExecutionState> {
    let confirming: ExecutionAttemptRecord;
    try {
      confirming = this.options.storage.executionAttempts.transitionAttemptWithAudit(
        attempt.attemptId,
        attempt.version,
        "CONFIRMING",
        { confirmationStartedAt: this.timestamp() },
        attemptAudit(attempt, "LIVE_CONFIRMATION_STARTED", "Bounded fixture position confirmation started."),
      );
    } catch {
      return this.markUnknown(attempt, "SUBMISSION_OUTCOME_UNKNOWN", null);
    }
    this.publishConfirming(confirming);
    this.replaceState("CONFIRMING", [], null, toSummary(confirming));
    return this.evaluatePositionEvidence(confirming, preview);
  }

  private async evaluatePositionEvidence(
    attempt: ExecutionAttemptRecord,
    context: AssistedLivePreview | ReturnType<typeof confirmationContext>,
    reconciliation = false,
  ): Promise<AssistedExecutionState> {
    let outcome: PositionConfirmationResult;
    try {
      outcome = await this.positionConfirmation.confirmContext(context);
    } catch {
      outcome = { status: "UNKNOWN", reason: "CONFIRMATION_SOURCE_UNKNOWN", evidence: null };
    }
    if (outcome.status === "UNKNOWN") return this.markUnknown(attempt, outcome.reason, outcome.evidence, reconciliation);

    let confirmed: ExecutionAttemptRecord;
    const confirmedAt = this.timestamp();
    try {
      confirmed = this.options.storage.executionAttempts.transitionAttemptWithAudit(attempt.attemptId, attempt.version, "CONFIRMED", {
        evidence: outcome.evidence,
        confirmedAt,
        observedSide: outcome.evidence.side,
        observedEntryPrice: outcome.evidence.entryPrice,
        observedSize: outcome.evidence.size,
        observedAt: outcome.evidence.observedAt,
      }, attemptAudit(attempt, "LIVE_POSITION_CONFIRMED_FIXTURE", "Fresh fixture position evidence matched the submitted intent."));
      await this.options.risk.recordExecutionSuccess(attempt.attemptId, "OPEN");
      this.options.onConfirmed?.();
    } catch {
      const persisted = this.options.storage.executionAttempts.getAttempt(attempt.attemptId);
      if (persisted?.status === "CONFIRMED") {
        this.replaceState("CONFIRMED", [], null, toSummary(persisted));
      } else {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"], null, toSummary(attempt));
      }
      return this.getState();
    }
    this.options.events.publish({
      version: 1,
      type: "execution.confirmed",
      timestamp: this.timestamp(),
      payload: {
        attemptId: attempt.attemptId,
        previewId: attempt.previewId,
        provider: "FIXTURE",
        symbol: attempt.symbol,
        side: attempt.side,
        submittedAt: confirmed.submittedAt,
        confirmedAt,
        observedEntryPrice: outcome.evidence.entryPrice,
        observedSize: outcome.evidence.size,
        observedAt: outcome.evidence.observedAt,
        evidence: outcome.evidence,
      },
    });
    this.replaceState("CONFIRMED", [], null, toSummary(confirmed));
    return this.getState();
  }

  private async markUnknown(
    attemptInput: ExecutionAttemptRecord,
    reason: ExecutionReasonCode,
    evidence: PositionConfirmationEvidence | null,
    reconciliation = false,
  ): Promise<AssistedExecutionState> {
    let attempt = this.options.storage.executionAttempts.getAttempt(attemptInput.attemptId) ?? attemptInput;
    if (attempt.status !== "UNKNOWN") {
      try {
        const eventType = reconciliation ? "LIVE_RECONCILIATION_UNKNOWN" : "LIVE_OUTCOME_UNKNOWN";
        attempt = this.options.storage.executionAttempts.transitionAttemptWithAudit(attempt.attemptId, attempt.version, "UNKNOWN", {
          reason,
          evidence,
          unknownAt: this.timestamp(),
          ...observedEvidencePatch(evidence),
        }, attemptAudit(attempt, eventType, reconciliation
          ? "Read-only fixture reconciliation remains unknown."
          : "Fixture execution outcome is unknown and blocks new entries.", { reason }));
      } catch {
        this.replaceState("HALTED", ["STORAGE_DEGRADED"], null, toSummary(attempt));
        return this.getState();
      }
    }
    try {
      await this.recordUnknownRisk(attempt.attemptId);
    } catch {
      // The durable unresolved attempt still blocks all new entries if audit or risk storage degrades.
    }
    this.publishUnknown(attempt, evidence);
    this.replaceState("UNKNOWN", [reason], null, toSummary(attempt));
    return this.getState();
  }

  private async recordUnknownRisk(attemptId: string): Promise<void> {
    await this.options.risk.recordExecutionFailure({ failureKind: "UNKNOWN_RESULT", executionAttemptId: attemptId });
  }

  private publishConfirming(attempt: ExecutionAttemptRecord): void {
    this.options.events.publish({
      version: 1,
      type: "execution.confirming",
      timestamp: this.timestamp(),
      payload: {
        attemptId: attempt.attemptId,
        previewId: attempt.previewId,
        provider: "FIXTURE",
        symbol: attempt.symbol,
        side: attempt.side,
        submittedAt: attempt.submittedAt,
      },
    });
  }

  private publishUnknown(
    attempt: ExecutionAttemptRecord,
    evidence: PositionConfirmationEvidence | null,
  ): void {
    this.options.events.publish({
      version: 1,
      type: "execution.unknown",
      timestamp: this.timestamp(),
      payload: {
        attemptId: attempt.attemptId,
        previewId: attempt.previewId,
        provider: "FIXTURE",
        symbol: attempt.symbol,
        side: attempt.side,
        submittedAt: attempt.submittedAt,
        unknownAt: attempt.unknownAt ?? this.timestamp(),
        reason: attempt.reason ?? "SUBMISSION_OUTCOME_UNKNOWN",
        evidence: evidence ?? attempt.evidence,
      },
    });
  }

  private assertFixtureProvider(): void {
    if (this.options.provider !== "FIXTURE") throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
  }

  private assertNotBusy(): void {
    if (this.inFlight) throw new AssistedExecutionError("EXECUTION_BUSY");
  }

  private assertNoBlockingAttempt(): void {
    this.assertStorageReady();
    if (this.options.storage.executionAttempts.getBlockingAttempt()) {
      throw new AssistedExecutionError("UNRESOLVED_EXECUTION_ATTEMPT");
    }
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
      severity: eventType.includes("FAILED") || eventType === "LIVE_PRECHECK_BLOCKED" || eventType.endsWith("UNKNOWN") ? "WARN" : "INFO",
      message: auditMessage(eventType),
      payload,
    });
  }

  private readReferencePrice(): number | null {
    try {
      const value = this.options.referencePrice?.();
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    } catch { return null; }
  }

  private async submitWithTimeout(preview: AssistedLivePreview): Promise<
    | { kind: "VALID"; result: ExecutionAdapterResult }
    | { kind: "AMBIGUOUS" }
  > {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new SubmissionTimeoutError()), this.submitTimeoutMs);
    });
    try {
      const result = await Promise.race([this.options.adapter.submit(preview), timeout]);
      return { kind: "VALID", result: ExecutionAdapterResultSchema.parse(result) };
    } catch {
      return { kind: "AMBIGUOUS" };
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

  private timestamp(): string { return this.clockNow().toISOString(); }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Execution clock is invalid.");
    return value;
  }
}

function toSummary(attempt: ExecutionAttemptRecord): AssistedSubmissionSummary {
  const base = {
    attemptId: attempt.attemptId,
    previewId: attempt.previewId,
    provider: "FIXTURE" as const,
    symbol: attempt.symbol,
    side: attempt.side,
  };
  if (attempt.status === "SUBMITTING") return { ...base, status: "SUBMITTING" };
  if (attempt.status === "SUBMITTED") {
    if (!attempt.fixtureSubmissionId || !attempt.submittedAt) throw new Error("Stored submitted attempt is incomplete.");
    return { ...base, status: "SUBMITTED", fixtureSubmissionId: attempt.fixtureSubmissionId, submittedAt: attempt.submittedAt };
  }
  if (attempt.status === "CONFIRMING") {
    return { ...base, status: "CONFIRMING", fixtureSubmissionId: attempt.fixtureSubmissionId, submittedAt: attempt.submittedAt };
  }
  if (attempt.status === "CONFIRMED") {
    if (!attempt.confirmedAt || attempt.evidence?.kind !== "MATCHED_OPEN") throw new Error("Stored confirmed attempt is incomplete.");
    return {
      ...base,
      status: "CONFIRMED",
      fixtureSubmissionId: attempt.fixtureSubmissionId,
      submittedAt: attempt.submittedAt,
      confirmedAt: attempt.confirmedAt,
      evidence: attempt.evidence,
    };
  }
  if (attempt.status === "FAILED") {
    if (attempt.outcome !== "NOT_SUBMITTED" || !attempt.failureKind || !attempt.failedAt) throw new Error("Stored failed attempt is incomplete.");
    return { ...base, status: "FAILED", outcome: "NOT_SUBMITTED", failureKind: attempt.failureKind, failedAt: attempt.failedAt };
  }
  return {
    ...base,
    status: "UNKNOWN",
    fixtureSubmissionId: attempt.fixtureSubmissionId,
    submittedAt: attempt.submittedAt,
    unknownAt: attempt.unknownAt ?? attempt.updatedAt,
    reason: attempt.reason ?? "SUBMISSION_OUTCOME_UNKNOWN",
    evidence: attempt.evidence,
  };
}

function statusForAttempt(status: ExecutionAttemptRecord["status"]): ExecutionStatus {
  switch (status) {
    case "SUBMITTING": return "SUBMITTING";
    case "SUBMITTED": return "SUBMITTED";
    case "CONFIRMING": return "CONFIRMING";
    case "CONFIRMED": return "CONFIRMED";
    case "FAILED": return "FAILED";
    case "UNKNOWN": return "UNKNOWN";
  }
}

function confirmationContext(
  attempt: ExecutionAttemptRecord,
  createdAt: string,
) {
  return {
    previewId: attempt.previewId,
    symbol: attempt.symbol,
    side: attempt.side,
    referencePrice: null,
    createdAt,
  };
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

function attemptAudit(
  attempt: ExecutionAttemptRecord,
  eventType: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return {
    category: "TRADING" as const,
    eventType,
    severity: eventType.includes("UNKNOWN") ? "WARN" as const : "INFO" as const,
    message,
    payload: {
      attemptId: attempt.attemptId,
      previewId: attempt.previewId,
      provider: attempt.provider,
      symbol: attempt.symbol,
      side: attempt.side,
      ...extra,
    },
  };
}

function observedEvidencePatch(evidence: PositionConfirmationEvidence | null): ExecutionAttemptPatch {
  if (evidence?.kind === "MATCHED_OPEN") {
    return {
      observedSide: evidence.side,
      observedEntryPrice: evidence.entryPrice,
      observedSize: evidence.size,
      observedAt: evidence.observedAt,
    };
  }
  return {
    observedSide: null,
    observedEntryPrice: null,
    observedSize: null,
    observedAt: evidence?.observedAt ?? null,
  };
}

function auditMessage(eventType: string): string {
  switch (eventType) {
    case "LIVE_ARMED": return "Local assisted execution was armed.";
    case "LIVE_DISARMED": return "Local assisted execution was disarmed.";
    case "LIVE_PREVIEW_CREATED": return "A fixture-only assisted execution preview was created.";
    case "LIVE_PRECHECK_BLOCKED": return "Assisted execution was blocked by the risk precheck.";
    case "LIVE_ATTEMPT_SUBMITTING": return "A durable fixture attempt was recorded before adapter invocation.";
    case "LIVE_ATTEMPT_SUBMITTED": return "The fixture adapter accepted a submission attempt.";
    case "LIVE_ATTEMPT_NOT_SUBMITTED": return "The fixture adapter explicitly confirmed no submission.";
    case "LIVE_OUTCOME_UNKNOWN": return "The fixture attempt outcome is unknown and requires manual reconciliation.";
    case "LIVE_POSITION_CONFIRMED_FIXTURE": return "Fixture position evidence matched the submitted intent.";
    default: return "Assisted execution event.";
  }
}

function riskFailureKind(kind: ExecutionFailureKind): "EXECUTION_FAILED" | "TIMEOUT" {
  return kind === "TIMEOUT" ? "TIMEOUT" : "EXECUTION_FAILED";
}

function isFailClosedRiskDecision(decision: RiskDecision): boolean {
  return decision.reasons.some((reason) => [
    "POSITION_UNKNOWN", "CONSECUTIVE_FAILURE_LIMIT", "KILL_SWITCH_UNKNOWN", "STORAGE_DEGRADED",
  ].includes(reason));
}

class SubmissionTimeoutError extends Error {}
