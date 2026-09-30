import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppendAuditEventInput } from "../../../../packages/shared/src/storage.js";
import {
  ExecutionAttemptRecordSchema,
  ExecutionAttemptStatusSchema,
  PositionConfirmationEvidenceSchema,
  type ExecutionAttemptRecord,
  type ExecutionAttemptStatus,
  type PositionConfirmationEvidence,
} from "../../../../packages/shared/src/execution.js";
import type { AuditRepository } from "./audit-repository.js";
import {
  ExecutionAttemptConflictError,
  ExecutionAttemptNotFoundError,
  InvalidExecutionAttemptTransitionError,
  StorageDataIntegrityError,
} from "./storage-errors.js";

type RawRow = Record<string, unknown>;
type Clock = () => Date;

const ATTEMPT_COLUMNS = `
  attempt_id AS attemptId,
  preview_id AS previewId,
  provider,
  symbol,
  side,
  margin_usdt AS marginUsdt,
  leverage,
  status,
  fixture_submission_id AS fixtureSubmissionId,
  outcome,
  failure_kind AS failureKind,
  reason_code AS reason,
  evidence_json AS evidenceJson,
  submitted_at AS submittedAt,
  confirmation_started_at AS confirmationStartedAt,
  confirmed_at AS confirmedAt,
  failed_at AS failedAt,
  unknown_at AS unknownAt,
  observed_side AS observedSide,
  observed_entry_price AS observedEntryPrice,
  observed_size AS observedSize,
  observed_at AS observedAt,
  created_at AS createdAt,
  updated_at AS updatedAt,
  version
`;

export interface CreateSubmittingAttemptInput {
  attemptId?: string;
  previewId: string;
  symbol: "GPS_USDT";
  side: "LONG" | "SHORT";
  marginUsdt: number;
  leverage: number;
  auditPayload: Record<string, unknown>;
}

export interface ExecutionAttemptPatch {
  fixtureSubmissionId?: string | null;
  outcome?: "NOT_SUBMITTED" | null;
  failureKind?: "EXECUTION_FAILED" | "TIMEOUT" | null;
  reason?: ExecutionAttemptRecord["reason"];
  evidence?: PositionConfirmationEvidence | null;
  submittedAt?: string | null;
  confirmedAt?: string | null;
  failedAt?: string | null;
  unknownAt?: string | null;
  confirmationStartedAt?: string | null;
  observedSide?: "LONG" | "SHORT" | null;
  observedEntryPrice?: number | null;
  observedSize?: number | null;
  observedAt?: string | null;
}

export class ExecutionAttemptRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly auditEvents: AuditRepository,
    private readonly now: Clock = () => new Date(),
  ) {}

  createSubmittingAttemptWithAudit(input: CreateSubmittingAttemptInput): ExecutionAttemptRecord {
    const attemptId = input.attemptId ?? randomUUID();
    const timestamp = this.timestamp();
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.database.prepare(`
        INSERT INTO execution_attempts (
          attempt_id, preview_id, provider, symbol, side, margin_usdt, leverage, status, created_at, updated_at
        ) VALUES (?, ?, 'FIXTURE', ?, ?, ?, ?, 'SUBMITTING', ?, ?)
      `).run(
        attemptId,
        input.previewId,
        input.symbol,
        input.side,
        input.marginUsdt,
        input.leverage,
        timestamp,
        timestamp,
      );
      this.auditEvents.appendAuditEvent({
        category: "TRADING",
        eventType: "LIVE_ATTEMPT_SUBMITTING",
        severity: "INFO",
        message: "A fixture execution attempt was durably recorded before adapter invocation.",
        payload: { attemptId, previewId: input.previewId, provider: "FIXTURE", symbol: input.symbol, side: input.side, ...input.auditPayload },
      });
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original persistence error. */ }
      throw error;
    }
    const record = this.getAttempt(attemptId);
    if (!record) throw new StorageDataIntegrityError("execution attempt");
    return record;
  }

  getAttempt(attemptId: string): ExecutionAttemptRecord | null {
    const row = this.database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts WHERE attempt_id = ?`)
      .get(attemptId) as RawRow | undefined;
    return row ? parseAttemptRow(row) : null;
  }

  getByPreviewId(previewId: string): ExecutionAttemptRecord | null {
    const row = this.database.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts WHERE preview_id = ?`)
      .get(previewId) as RawRow | undefined;
    return row ? parseAttemptRow(row) : null;
  }

  getBlockingAttempt(): ExecutionAttemptRecord | null {
    const row = this.database.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM execution_attempts
      WHERE status IN ('SUBMITTING', 'SUBMITTED', 'CONFIRMING', 'UNKNOWN')
      ORDER BY created_at DESC, attempt_id DESC
      LIMIT 1
    `).get() as RawRow | undefined;
    return row ? parseAttemptRow(row) : null;
  }

  getBlockingAttemptCount(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM execution_attempts
      WHERE status IN ('SUBMITTING', 'SUBMITTED', 'CONFIRMING', 'UNKNOWN')
    `).get() as { count?: number | bigint } | undefined;
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) throw new StorageDataIntegrityError("execution attempt count");
    return count;
  }

  getLatestAttempt(): ExecutionAttemptRecord | null {
    const row = this.database.prepare(`
      SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
      ORDER BY created_at DESC, attempt_id DESC LIMIT 1
    `).get() as RawRow | undefined;
    return row ? parseAttemptRow(row) : null;
  }

  getLatestConfirmedAttempt(): ExecutionAttemptRecord | null {
    const row = this.database.prepare(`
      SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
      WHERE status = 'CONFIRMED'
      ORDER BY confirmed_at DESC, attempt_id DESC LIMIT 1
    `).get() as RawRow | undefined;
    return row ? parseAttemptRow(row) : null;
  }

  listConfirmedAttemptsInRange(startAt: string, endAt: string): ExecutionAttemptRecord[] {
    const startMs = Date.parse(startAt);
    const endMs = Date.parse(endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
      throw new RangeError("Confirmed attempt range is invalid.");
    }
    const rows = this.database.prepare(`
      SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
      WHERE status = 'CONFIRMED' AND confirmed_at >= ? AND confirmed_at <= ?
      ORDER BY confirmed_at ASC, attempt_id ASC LIMIT 1001
    `).all(startAt, endAt) as unknown as RawRow[];
    return rows.map(parseAttemptRow);
  }

  listRecentAttempts(limit = 50): ExecutionAttemptRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("List limit must be from 1 to 100.");
    const rows = this.database.prepare(`
      SELECT ${ATTEMPT_COLUMNS} FROM execution_attempts
      ORDER BY created_at DESC, attempt_id DESC LIMIT ?
    `).all(limit) as unknown as RawRow[];
    return rows.map(parseAttemptRow);
  }

  transitionAttempt(
    attemptId: string,
    expectedVersion: number,
    nextStatus: ExecutionAttemptStatus,
    patch: ExecutionAttemptPatch = {},
  ): ExecutionAttemptRecord {
    const status = ExecutionAttemptStatusSchema.parse(nextStatus);
    const current = this.getAttempt(attemptId);
    if (!current) throw new ExecutionAttemptNotFoundError();
    if (current.version !== expectedVersion) throw new ExecutionAttemptConflictError();
    if (!canTransition(current.status, status)) throw new InvalidExecutionAttemptTransitionError();
    const confirmationStartedAt = status === "CONFIRMING" && patch.confirmationStartedAt === undefined
      ? this.timestamp()
      : null;
    const next = ExecutionAttemptRecordSchema.parse({
      ...current,
      ...patch,
      ...(confirmationStartedAt ? { confirmationStartedAt } : {}),
      status,
      updatedAt: this.timestamp(),
      version: current.version + 1,
    });
    const evidenceJson = next.evidence === null ? null : JSON.stringify(PositionConfirmationEvidenceSchema.parse(next.evidence));
    const result = this.database.prepare(`
      UPDATE execution_attempts SET
        status = ?, fixture_submission_id = ?, outcome = ?, failure_kind = ?, reason_code = ?, evidence_json = ?,
        submitted_at = ?, confirmation_started_at = ?, confirmed_at = ?, failed_at = ?, unknown_at = ?,
        observed_side = ?, observed_entry_price = ?, observed_size = ?, observed_at = ?, updated_at = ?, version = ?
      WHERE attempt_id = ? AND version = ?
    `).run(
      next.status,
      next.fixtureSubmissionId,
      next.outcome,
      next.failureKind,
      next.reason,
      evidenceJson,
      next.submittedAt,
      next.confirmationStartedAt,
      next.confirmedAt,
      next.failedAt,
      next.unknownAt,
      next.observedSide,
      next.observedEntryPrice,
      next.observedSize,
      next.observedAt,
      next.updatedAt,
      next.version,
      attemptId,
      expectedVersion,
    );
    if (Number(result.changes) !== 1) throw new ExecutionAttemptConflictError();
    const record = this.getAttempt(attemptId);
    if (!record) throw new StorageDataIntegrityError("execution attempt");
    return record;
  }

  transitionAttemptWithAudit(
    attemptId: string,
    expectedVersion: number,
    nextStatus: ExecutionAttemptStatus,
    patch: ExecutionAttemptPatch,
    audit: AppendAuditEventInput,
  ): ExecutionAttemptRecord {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const record = this.transitionAttempt(attemptId, expectedVersion, nextStatus, patch);
      this.auditEvents.appendAuditEvent(audit);
      this.database.exec("COMMIT;");
      return record;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transition error. */ }
      throw error;
    }
  }

  private timestamp(): string {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new StorageDataIntegrityError("execution attempt clock");
    return date.toISOString();
  }
}

function canTransition(from: ExecutionAttemptStatus, to: ExecutionAttemptStatus): boolean {
  const allowed: Record<ExecutionAttemptStatus, readonly ExecutionAttemptStatus[]> = {
    SUBMITTING: ["SUBMITTED", "FAILED", "UNKNOWN"],
    SUBMITTED: ["CONFIRMING", "UNKNOWN"],
    CONFIRMING: ["CONFIRMED", "UNKNOWN"],
    UNKNOWN: ["CONFIRMING"],
    CONFIRMED: [],
    FAILED: [],
  };
  return allowed[from].includes(to);
}

function parseAttemptRow(row: RawRow): ExecutionAttemptRecord {
  let evidence: unknown = null;
  try {
    evidence = typeof row.evidenceJson === "string" ? JSON.parse(row.evidenceJson) : null;
  } catch {
    throw new StorageDataIntegrityError("execution attempt");
  }
  const normalized = { ...row, evidence };
  delete (normalized as RawRow).evidenceJson;
  const parsed = ExecutionAttemptRecordSchema.safeParse(normalized);
  if (!parsed.success) throw new StorageDataIntegrityError("execution attempt");
  return parsed.data;
}
