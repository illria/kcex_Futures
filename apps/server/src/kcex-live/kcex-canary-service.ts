import { randomUUID } from "node:crypto";
import {
  LIVE_CANARY_CONFIRMATION_PHRASE,
  LiveCanaryConfirmInputSchema,
  LiveCanaryPreviewInputSchema,
  LiveCanaryStateSchema,
  type LiveCanaryPreviewInput,
  type LiveCanaryState,
  type VerifiedKcexContractProfile,
} from "../../../../packages/shared/src/live-launch.js";
import { deriveKcexQuantity } from "./quantity.js";
import type { LiveExecutionAttemptRepository } from "../storage/live-execution-attempt-repository.js";
import type { EventBus } from "../realtime/event-bus.js";

export interface KcexCanaryServiceOptions {
  attempts: LiveExecutionAttemptRepository;
  events: EventBus;
  profile: () => VerifiedKcexContractProfile;
  markPrice(): number | null;
  getBlockReasons(input: LiveCanaryPreviewInput): Promise<readonly string[]>;
  isVerified?(): boolean;
  recordFailure?(): Promise<void>;
  executeOnce(
    input: LiveCanaryPreviewInput,
    attemptId: string,
    expectedQuantity: number,
    reportProgress: (status: "SUBMITTING" | "CONFIRMING" | "PROTECTING") => void,
  ): Promise<"PASSED" | "FAILED" | "UNKNOWN" | "MANUAL_ACTION">;
  now?: () => Date;
  previewTtlMs?: number;
}

interface ActivePreview {
  id: string;
  input: LiveCanaryPreviewInput;
  markPrice: number;
  quantity: number;
  notionalUsdt: number;
  expiresAt: string;
}

/** One explicitly confirmed, durable canary. The scheduler is never called from this service. */
export class KcexCanaryService {
  private readonly now: () => Date;
  private readonly previewTtlMs: number;
  private preview: ActivePreview | null = null;
  private inFlight = false;
  private runtimeStatus: LiveCanaryState["status"] = "NOT_STARTED";
  private blockReasons: string[] = [];

  constructor(private readonly options: KcexCanaryServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.previewTtlMs = options.previewTtlMs ?? 60_000;
    if (!Number.isSafeInteger(this.previewTtlMs) || this.previewTtlMs < 1_000 || this.previewTtlMs > 60_000) {
      throw new RangeError("Canary preview lifetime must be from one to sixty seconds.");
    }
  }

  getState(): LiveCanaryState {
    const attempt = this.options.attempts.getCanaryAttempt();
    const status = attempt
      ? this.inFlight ? this.runtimeStatus
        : attempt.status === "FAILED" ? "FAILED"
          : attempt.status === "UNKNOWN" ? "UNKNOWN"
            : attempt.status === "CONFIRMED" ? this.runtimeStatus === "PASSED" || this.options.isVerified?.() === true ? "PASSED" : "MANUAL_ACTION"
              : "UNKNOWN"
      : this.preview && Date.parse(this.preview.expiresAt) > this.clockNow().getTime() ? "PREVIEWED" : "NOT_STARTED";
    return LiveCanaryStateSchema.parse({
      status,
      attemptId: attempt?.attemptId ?? null,
      side: attempt?.side ?? this.preview?.input.side ?? null,
      marginUsdt: attempt?.marginUsdt ?? this.preview?.input.marginUsdt ?? null,
      markPrice: this.preview?.markPrice ?? null,
      quantity: attempt?.quantity ?? this.preview?.quantity ?? null,
      notionalUsdt: attempt?.notionalUsdt ?? this.preview?.notionalUsdt ?? null,
      previewId: this.preview?.id ?? null,
      previewExpiresAt: this.preview?.expiresAt ?? null,
      blockReasons: this.blockReasons,
      updatedAt: this.clockNow().toISOString(),
    });
  }

  async createPreview(inputValue: unknown): Promise<LiveCanaryState> {
    const input = LiveCanaryPreviewInputSchema.parse(inputValue);
    if (this.options.attempts.getCanaryAttempt() || this.inFlight) {
      this.preview = null;
      this.blockReasons = ["CANARY_ALREADY_ATTEMPTED"];
      return this.publish();
    }
    const reasons = [...await this.options.getBlockReasons(input)];
    const markPrice = this.options.markPrice();
    let previewQuote: ReturnType<typeof deriveKcexQuantity> | null = null;
    if (reasons.length === 0 && markPrice !== null) {
      try {
        previewQuote = deriveKcexQuantity({ profile: this.options.profile(), markPrice, marginUsdt: input.marginUsdt, leverage: 10 });
      } catch {
        reasons.push("CONTRACT_QUANTITY_INVALID");
      }
    } else if (markPrice === null) {
      reasons.push("MARKET_PRICE_UNAVAILABLE");
    }
    this.blockReasons = [...new Set(reasons)];
    if (this.blockReasons.length > 0) {
      this.preview = null;
      this.runtimeStatus = "NOT_STARTED";
      return this.publish();
    }
    this.preview = {
      id: randomUUID(),
      input: Object.freeze({ ...input, takeProfit: Object.freeze({ ...input.takeProfit }), stopLoss: Object.freeze({ ...input.stopLoss }) }),
      markPrice: markPrice!,
      quantity: previewQuote!.quantity,
      notionalUsdt: previewQuote!.notionalUsdt,
      expiresAt: new Date(this.clockNow().getTime() + this.previewTtlMs).toISOString(),
    };
    this.runtimeStatus = "PREVIEWED";
    this.blockReasons = [];
    return this.publish();
  }

  async confirm(inputValue: unknown): Promise<LiveCanaryState> {
    const input = LiveCanaryConfirmInputSchema.parse(inputValue);
    if (input.confirmation !== LIVE_CANARY_CONFIRMATION_PHRASE || this.inFlight) throw new Error("CANARY_CONFIRMATION_INVALID");
    const preview = this.preview;
    if (!preview || preview.id !== input.previewId || Date.parse(preview.expiresAt) <= this.clockNow().getTime()) {
      this.preview = null;
      this.runtimeStatus = "NOT_STARTED";
      this.blockReasons = ["CANARY_PREVIEW_EXPIRED"];
      return this.publish();
    }
    const reasons = [...await this.options.getBlockReasons(preview.input)];
    if (reasons.length > 0) {
      this.preview = null;
      this.runtimeStatus = "NOT_STARTED";
      this.blockReasons = [...new Set(reasons)];
      return this.publish();
    }
    const currentMarkPrice = this.options.markPrice();
    if (currentMarkPrice === null) {
      this.preview = null;
      this.runtimeStatus = "NOT_STARTED";
      this.blockReasons = ["MARKET_PRICE_UNAVAILABLE"];
      return this.publish();
    }
    let currentQuote: ReturnType<typeof deriveKcexQuantity>;
    try {
      currentQuote = deriveKcexQuantity({
        profile: this.options.profile(),
        markPrice: currentMarkPrice,
        marginUsdt: preview.input.marginUsdt,
        leverage: 10,
      });
    } catch {
      this.preview = null;
      this.runtimeStatus = "NOT_STARTED";
      this.blockReasons = ["CONTRACT_QUANTITY_INVALID"];
      return this.publish();
    }
    if (currentQuote.quantity !== preview.quantity) {
      this.preview = null;
      this.runtimeStatus = "NOT_STARTED";
      this.blockReasons = ["PREVIEW_QUANTITY_CHANGED"];
      return this.publish();
    }
    const attempt = this.options.attempts.createCanaryAttempt({ side: preview.input.side, marginUsdt: preview.input.marginUsdt });
    this.preview = null;
    if (!attempt) {
      this.runtimeStatus = "UNKNOWN";
      this.blockReasons = ["CANARY_ALREADY_ATTEMPTED"];
      return this.publish();
    }
    this.inFlight = true;
    this.runtimeStatus = "SUBMITTING";
    this.blockReasons = [];
    try {
      const outcome = await this.options.executeOnce(preview.input, attempt.attemptId, preview.quantity, (status) => {
        this.runtimeStatus = status;
        this.publish();
      });
      this.runtimeStatus = outcome;
      if (outcome === "PASSED") {
        const finalAttempt = this.options.attempts.getById(attempt.attemptId);
        if (!finalAttempt || finalAttempt.status !== "CONFIRMED") {
          this.runtimeStatus = "UNKNOWN";
          this.blockReasons = ["CANARY_CONFIRMATION_NOT_DURABLE"];
        }
      }
      if (this.runtimeStatus !== "PASSED") await this.options.recordFailure?.();
    } catch {
      const current = this.options.attempts.getById(attempt.attemptId);
      if (current && ["SUBMITTING", "SUBMITTED", "CONFIRMING"].includes(current.status)) {
        try { this.options.attempts.markUnknown(attempt.attemptId); } catch { /* Never retry a potentially submitted order. */ }
      }
      this.runtimeStatus = "UNKNOWN";
      this.blockReasons = ["CANARY_OUTCOME_UNKNOWN"];
      await this.options.recordFailure?.().catch(() => undefined);
    } finally {
      this.inFlight = false;
    }
    return this.publish();
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Canary clock is invalid.");
    return value;
  }

  private publish(): LiveCanaryState {
    const state = this.getState();
    this.options.events.publish({ version: 1, type: "live.canary.state", timestamp: state.updatedAt, payload: state });
    return state;
  }

  reportProgress(status: "SUBMITTING" | "CONFIRMING" | "PROTECTING"): void {
    if (!this.inFlight) return;
    this.runtimeStatus = status;
    this.publish();
  }
}
