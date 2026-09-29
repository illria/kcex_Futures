import { describe, expect, it } from "vitest";
import { ExecutionAttemptConflictError, InvalidExecutionAttemptTransitionError, StorageDataIntegrityError } from "../../apps/server/src/storage/storage-errors.js";
import { createTask008Setup } from "../task008/helpers.js";

const ATTEMPT_ID = "90000000-0000-4000-8000-000000000001";
const PREVIEW_ID = "90000000-0000-4000-8000-000000000002";
const NOW = "2026-09-29T12:00:00.000Z";

describe("TASK-009 durable execution attempt repository", () => {
  it("writes SUBMITTING and its audit row atomically before any adapter call", async () => {
    const setup = await createTask008Setup();
    try {
      const attempt = setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
        attemptId: ATTEMPT_ID,
        previewId: PREVIEW_ID,
        symbol: "GPS_USDT",
        side: "LONG",
        marginUsdt: 50,
        leverage: 10,
        auditPayload: { marginUsdt: 50, leverage: 10 },
      });
      expect(attempt).toMatchObject({
        attemptId: ATTEMPT_ID,
        previewId: PREVIEW_ID,
        status: "SUBMITTING",
        marginUsdt: 50,
        leverage: 10,
        version: 1,
      });
      expect(setup.storage.auditEvents.listAuditEvents({ limit: 100 }).some((event) => event.eventType === "LIVE_ATTEMPT_SUBMITTING")).toBe(true);
      expect(setup.storage.executionAttempts.getBlockingAttempt()?.attemptId).toBe(ATTEMPT_ID);
    } finally {
      await setup.cleanup();
    }
  });

  it("enforces valid transitions, optimistic versions, and the one unresolved-attempt gate", async () => {
    const setup = await createTask008Setup();
    try {
      const attempt = setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
        attemptId: ATTEMPT_ID,
        previewId: PREVIEW_ID,
        symbol: "GPS_USDT",
        side: "LONG",
        marginUsdt: 50,
        leverage: 10,
        auditPayload: {},
      });
      const unknown = setup.storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "UNKNOWN", {
        reason: "SUBMISSION_OUTCOME_UNKNOWN",
        unknownAt: NOW,
      });
      expect(unknown.version).toBe(2);
      expect(() => setup.storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "CONFIRMING"))
        .toThrow(ExecutionAttemptConflictError);
      expect(() => setup.storage.executionAttempts.transitionAttempt(unknown.attemptId, unknown.version, "FAILED"))
        .toThrow(InvalidExecutionAttemptTransitionError);
      expect(() => setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
        previewId: "90000000-0000-4000-8000-000000000003",
        symbol: "GPS_USDT",
        side: "SHORT",
        marginUsdt: 50,
        leverage: 10,
        auditPayload: {},
      })).toThrow();
      expect(setup.storage.executionAttempts.getBlockingAttemptCount()).toBe(1);
    } finally {
      await setup.cleanup();
    }
  });

  it("rejects a syntactically valid but schema-corrupt persisted evidence row", async () => {
    const setup = await createTask008Setup();
    try {
      const attempt = setup.storage.executionAttempts.createSubmittingAttemptWithAudit({
        attemptId: ATTEMPT_ID,
        previewId: PREVIEW_ID,
        symbol: "GPS_USDT",
        side: "LONG",
        marginUsdt: 50,
        leverage: 10,
        auditPayload: {},
      });
      const database = (setup.storage as unknown as {
        database: { getConnection(): { prepare(sql: string): { run(...args: unknown[]): unknown } } };
      }).database.getConnection();
      setup.storage.executionAttempts.transitionAttempt(attempt.attemptId, attempt.version, "UNKNOWN", {
        reason: "SUBMISSION_OUTCOME_UNKNOWN",
        unknownAt: NOW,
      });
      database.prepare("UPDATE execution_attempts SET evidence_json = ? WHERE attempt_id = ?")
        .run(JSON.stringify({ kind: "NO_POSITION", source: "FIXTURE", observedAt: "invalid" }), attempt.attemptId);
      expect(() => setup.storage.executionAttempts.getAttempt(attempt.attemptId)).toThrow(StorageDataIntegrityError);
    } finally {
      await setup.cleanup();
    }
  });
});
