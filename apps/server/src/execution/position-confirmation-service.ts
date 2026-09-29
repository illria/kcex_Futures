import {
  AssistedLivePreviewSchema,
  PositionConfirmationEvidenceSchema,
  type AssistedLivePreview,
  type PositionConfirmationEvidence,
} from "../../../../packages/shared/src/execution.js";

export const DEFAULT_POSITION_CONFIRMATION_DEADLINE_MS = 10_000;
export const DEFAULT_POSITION_CONFIRMATION_POLL_INTERVAL_MS = 500;

export interface PositionConfirmationSource {
  readEvidence(preview: PositionConfirmationContext): Promise<unknown> | unknown;
}

export interface PositionConfirmationContext {
  previewId: string;
  symbol: "GPS_USDT";
  side: "LONG" | "SHORT";
  referencePrice: number | null;
  createdAt: string;
}

export type PositionConfirmationResult =
  | { status: "CONFIRMED"; evidence: Extract<PositionConfirmationEvidence, { kind: "MATCHED_OPEN" }> }
  | { status: "UNKNOWN"; reason: "CONFIRMATION_SOURCE_UNKNOWN" | "CONFIRMATION_EVIDENCE_MISMATCH" | "CONFIRMATION_TIMEOUT"; evidence: PositionConfirmationEvidence | null };

export interface PositionConfirmationServiceOptions {
  source: PositionConfirmationSource;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  deadlineMs?: number;
  pollIntervalMs?: number;
}

export class PositionConfirmationService {
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly deadlineMs: number;
  private readonly pollIntervalMs: number;

  constructor(private readonly options: PositionConfirmationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.deadlineMs = options.deadlineMs ?? DEFAULT_POSITION_CONFIRMATION_DEADLINE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POSITION_CONFIRMATION_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > DEFAULT_POSITION_CONFIRMATION_DEADLINE_MS) {
      throw new RangeError("Position confirmation deadline exceeds the supported bound.");
    }
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 100 || this.pollIntervalMs > 2_000) {
      throw new RangeError("Position confirmation interval is outside the supported bound.");
    }
  }

  async confirm(previewInput: AssistedLivePreview): Promise<PositionConfirmationResult> {
    const preview = AssistedLivePreviewSchema.parse(previewInput);
    return this.confirmContext(preview);
  }

  async confirmContext(preview: PositionConfirmationContext): Promise<PositionConfirmationResult> {
    const startedAt = this.clockNow().getTime();
    const deadlineAt = startedAt + this.deadlineMs;
    const maxPolls = Math.ceil(this.deadlineMs / this.pollIntervalMs) + 1;
    let latest: PositionConfirmationEvidence | null = null;

    for (let poll = 0; poll < maxPolls && this.clockNow().getTime() <= deadlineAt; poll += 1) {
      let raw: unknown;
      try {
        raw = await this.options.source.readEvidence(preview);
      } catch {
        return { status: "UNKNOWN", reason: "CONFIRMATION_SOURCE_UNKNOWN", evidence: null };
      }

      const parsed = PositionConfirmationEvidenceSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          status: "UNKNOWN",
          reason: "CONFIRMATION_SOURCE_UNKNOWN",
          evidence: this.unknownEvidence("INVALID_EVIDENCE"),
        };
      }
      latest = parsed.data;
      if (latest.kind === "UNKNOWN" || latest.source !== "FIXTURE") {
        return { status: "UNKNOWN", reason: "CONFIRMATION_SOURCE_UNKNOWN", evidence: latest };
      }
      if (latest.kind === "MISMATCH") {
        return { status: "UNKNOWN", reason: "CONFIRMATION_EVIDENCE_MISMATCH", evidence: latest };
      }
      if (latest.kind === "MATCHED_OPEN") {
        if (latest.symbol !== preview.symbol) {
          return {
            status: "UNKNOWN",
            reason: "CONFIRMATION_EVIDENCE_MISMATCH",
            evidence: { kind: "MISMATCH", source: "FIXTURE", reason: "SYMBOL_MISMATCH", observedAt: latest.observedAt },
          };
        }
        if (latest.side !== preview.side) {
          return {
            status: "UNKNOWN",
            reason: "CONFIRMATION_EVIDENCE_MISMATCH",
            evidence: { kind: "MISMATCH", source: "FIXTURE", reason: "SIDE_MISMATCH", observedAt: latest.observedAt },
          };
        }
        if (!isFreshObservation(latest.observedAt, this.clockNow().getTime())) {
          return {
            status: "UNKNOWN",
            reason: "CONFIRMATION_SOURCE_UNKNOWN",
            evidence: this.unknownEvidence("INVALID_EVIDENCE"),
          };
        }
        return { status: "CONFIRMED", evidence: latest };
      }

      if (poll + 1 < maxPolls && this.clockNow().getTime() < deadlineAt) {
        await this.sleep(Math.min(this.pollIntervalMs, Math.max(0, deadlineAt - this.clockNow().getTime())));
      }
    }

    return { status: "UNKNOWN", reason: "CONFIRMATION_TIMEOUT", evidence: latest };
  }

  private unknownEvidence(reason: "SOURCE_UNAVAILABLE" | "INVALID_EVIDENCE"): PositionConfirmationEvidence {
    return {
      kind: "UNKNOWN",
      source: "UNKNOWN",
      reason,
      observedAt: this.clockNow().toISOString(),
    };
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Position confirmation clock is invalid.");
    return value;
  }
}

/** Deterministic in-memory evidence source. It cannot read an exchange or browser. */
export class FixturePositionConfirmationSource implements PositionConfirmationSource {
  private readonly evidence: unknown[];
  private readonly now: () => Date;
  private calls = 0;

  constructor(evidence?: readonly unknown[], now: () => Date = () => new Date()) {
    this.evidence = evidence ? [...evidence] : [];
    this.now = now;
  }

  get readCalls(): number { return this.calls; }

  async readEvidence(_preview: PositionConfirmationContext): Promise<unknown> {
    this.calls += 1;
    if (this.evidence.length > 0) return this.evidence[Math.min(this.calls - 1, this.evidence.length - 1)];
    return {
      kind: "UNKNOWN",
      source: "FIXTURE",
      reason: "SOURCE_UNAVAILABLE",
      observedAt: this.timestamp(),
    };
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Fixture evidence clock is invalid.");
    return value.toISOString();
  }
}

function isFreshObservation(observedAt: string, now: number): boolean {
  const timestamp = Date.parse(observedAt);
  return Number.isFinite(timestamp) && timestamp <= now + 1_000 && now - timestamp <= 15_000;
}
