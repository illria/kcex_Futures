import { describe, expect, it } from "vitest";
import type { ExecutionAttemptStatus } from "../../packages/shared/src/execution.js";
import type { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { EXECUTION_ARM_ACKNOWLEDGEMENT } from "../../apps/server/src/execution/execution-arm.js";
import { createTask008Setup } from "../task008/helpers.js";

const NOW = "2026-09-29T12:00:00.000Z";
const MATCHED_OPEN = {
  kind: "MATCHED_OPEN",
  source: "FIXTURE",
  symbol: "GPS_USDT",
  side: "LONG",
  entryPrice: 0.0123,
  size: 1.25,
  observedAt: NOW,
} as const;

function seedAttempt(storage: StorageService, status: ExecutionAttemptStatus): void {
  const repository = storage.executionAttempts;
  let attempt = repository.createSubmittingAttemptWithAudit({
    attemptId: "93000000-0000-4000-8000-000000000001",
    previewId: "93000000-0000-4000-8000-000000000002",
    symbol: "GPS_USDT",
    side: "LONG",
    marginUsdt: 50,
    leverage: 10,
    auditPayload: {},
  });

  if (status === "SUBMITTING") return;
  if (status === "FAILED") {
    repository.transitionAttempt(attempt.attemptId, attempt.version, "FAILED", {
      outcome: "NOT_SUBMITTED",
      failureKind: "EXECUTION_FAILED",
      failedAt: NOW,
    });
    return;
  }
  if (status === "UNKNOWN") {
    repository.transitionAttempt(attempt.attemptId, attempt.version, "UNKNOWN", {
      reason: "SUBMISSION_OUTCOME_UNKNOWN",
      unknownAt: NOW,
    });
    return;
  }

  attempt = repository.transitionAttempt(attempt.attemptId, attempt.version, "SUBMITTED", {
    fixtureSubmissionId: "93000000-0000-4000-8000-000000000003",
    submittedAt: NOW,
  });
  if (status === "SUBMITTED") return;
  attempt = repository.transitionAttempt(attempt.attemptId, attempt.version, "CONFIRMING");
  if (status === "CONFIRMING") return;
  repository.transitionAttempt(attempt.attemptId, attempt.version, "CONFIRMED", {
    confirmedAt: NOW,
    evidence: MATCHED_OPEN,
    observedSide: "LONG",
    observedEntryPrice: MATCHED_OPEN.entryPrice,
    observedSize: MATCHED_OPEN.size,
    observedAt: MATCHED_OPEN.observedAt,
  });
}

describe("TASK-009 restart-safe fixture position bootstrap", () => {
  it("starts a fresh production-style fixture bootstrap FLAT and allows an evidence-backed fixture flow", async () => {
    const setup = await createTask008Setup({ confirmationEvidence: [MATCHED_OPEN] });
    try {
      expect(setup.positionSource.getPositionState()).toBe("FLAT");
      setup.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
      const preview = setup.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10 });
      const result = await setup.service.confirm({
        previewId: preview.preview.previewId,
        confirmationToken: preview.confirmationToken,
      });
      expect(result.status).toBe("CONFIRMED");
      expect(setup.adapter.submitCalls).toBe(1);
    } finally {
      await setup.cleanup();
    }
  });

  it.each([
    { attemptStatus: "FAILED" as const, expected: "FLAT" as const },
    { attemptStatus: "SUBMITTING" as const, expected: "UNKNOWN" as const },
    { attemptStatus: "SUBMITTED" as const, expected: "UNKNOWN" as const },
    { attemptStatus: "CONFIRMING" as const, expected: "UNKNOWN" as const },
    { attemptStatus: "UNKNOWN" as const, expected: "UNKNOWN" as const },
    { attemptStatus: "CONFIRMED" as const, expected: "UNKNOWN" as const },
  ])("resolves persisted $attemptStatus to $expected", async ({ attemptStatus, expected }) => {
    const setup = await createTask008Setup({ seedAttempts: (storage) => seedAttempt(storage, attemptStatus) });
    try {
      expect(setup.positionSource.getPositionState()).toBe(expected);
    } finally {
      await setup.cleanup();
    }
  });

  it("halts a confirmed attempt after restart as POSITION_UNKNOWN without a new fixture submission", async () => {
    const setup = await createTask008Setup({
      seedAttempts: (storage) => seedAttempt(storage, "CONFIRMED"),
      confirmationEvidence: [MATCHED_OPEN],
    });
    try {
      expect(setup.positionSource.getPositionState()).toBe("UNKNOWN");
      setup.service.armRuntime(EXECUTION_ARM_ACKNOWLEDGEMENT);
      const preview = setup.service.createPreview({ side: "LONG", marginUsdt: 50, leverage: 10 });
      const result = await setup.service.confirm({
        previewId: preview.preview.previewId,
        confirmationToken: preview.confirmationToken,
      });
      expect(result.status).toBe("HALTED");
      expect(setup.risk.getState().reasons).toContain("POSITION_UNKNOWN");
      expect(setup.adapter.submitCalls).toBe(0);
    } finally {
      await setup.cleanup();
    }
  });
});
