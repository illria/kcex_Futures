import { randomUUID } from "node:crypto";
import {
  AssistedLivePreviewSchema,
  ExecutionAdapterResultSchema,
  type AssistedLivePreview,
  type ExecutionAdapterResult,
  type ExecutionFailureKind,
} from "../../../../packages/shared/src/execution.js";
import type { ExecutionAdapter } from "./execution-adapter.js";

export interface FixtureExecutionAdapterOptions {
  now?: () => Date;
  idGenerator?: () => string;
  delayMs?: number;
  failureKind?: ExecutionFailureKind;
  resultMode?: "VALID" | "THROW" | "MALFORMED";
}

export class FixtureExecutionAdapter implements ExecutionAdapter {
  readonly provider = "FIXTURE" as const;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly delayMs: number;
  private readonly failureKind?: ExecutionFailureKind;
  private readonly resultMode: "VALID" | "THROW" | "MALFORMED";
  private calls = 0;

  constructor(options: FixtureExecutionAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.delayMs = options.delayMs ?? 0;
    this.failureKind = options.failureKind;
    this.resultMode = options.resultMode ?? "VALID";
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs < 0 || this.delayMs > 60_000) {
      throw new RangeError("Fixture delay is outside the supported limit.");
    }
  }

  get submitCalls(): number {
    return this.calls;
  }

  async submit(previewInput: AssistedLivePreview): Promise<ExecutionAdapterResult> {
    AssistedLivePreviewSchema.parse(previewInput);
    this.calls += 1;
    if (this.resultMode === "THROW") throw new Error("fixture adapter failure");
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("Fixture clock is invalid.");
    if (this.resultMode === "MALFORMED") {
      return { status: "SUBMITTED", fixtureSubmissionId: "invalid", submittedAt: "not-a-time" } as unknown as ExecutionAdapterResult;
    }
    const result = this.failureKind
      ? { status: "FAILED" as const, outcome: "NOT_SUBMITTED" as const, failureKind: this.failureKind, failedAt: now.toISOString() }
      : { status: "SUBMITTED" as const, fixtureSubmissionId: this.idGenerator(), submittedAt: now.toISOString() };
    return ExecutionAdapterResultSchema.parse(result);
  }
}
