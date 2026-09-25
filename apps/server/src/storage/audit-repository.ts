import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AppendAuditEventInputSchema,
  AuditEventRecordSchema,
  SafeAuditPayloadSchema,
  type AppendAuditEventInput,
  type AuditEventRecord,
} from "../../../../packages/shared/src/storage.js";
import { StorageDataIntegrityError } from "./storage-errors.js";

type RawRow = Record<string, unknown>;
type Clock = () => Date;

export class AuditRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: Clock = () => new Date()) {}

  appendAuditEvent(input: AppendAuditEventInput): AuditEventRecord {
    const validated = AppendAuditEventInputSchema.parse(input);
    const id = validated.id ?? randomUUID();
    const createdAt = this.now().toISOString();
    const payload = validated.payload === undefined || validated.payload === null
      ? null
      : SafeAuditPayloadSchema.parse(validated.payload);
    const payloadJson = payload === null ? null : JSON.stringify(payload);

    this.database.prepare(`
      INSERT INTO audit_events(id, category, event_type, severity, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, validated.category, validated.eventType, validated.severity, validated.message, payloadJson, createdAt);

    const row = this.database.prepare(`
      SELECT id, category, event_type AS eventType, severity, message, payload_json AS payloadJson, created_at AS createdAt
      FROM audit_events
      WHERE id = ?
    `).get(id) as RawRow | undefined;
    if (!row) throw new StorageDataIntegrityError("audit event");
    return parseAuditEventRow(row);
  }

  listAuditEvents(options: { limit?: number } = {}): AuditEventRecord[] {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("List limit must be an integer from 1 to 100.");
    }
    const rows = this.database.prepare(`
      SELECT id, category, event_type AS eventType, severity, message, payload_json AS payloadJson, created_at AS createdAt
      FROM audit_events
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as unknown as RawRow[];
    return rows.map(parseAuditEventRow);
  }
}

function parseAuditEventRow(row: RawRow): AuditEventRecord {
  let payload: unknown = null;
  try {
    payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : null;
  } catch {
    throw new StorageDataIntegrityError("audit event");
  }
  if (payload !== null) {
    const safePayload = SafeAuditPayloadSchema.safeParse(payload);
    if (!safePayload.success) throw new StorageDataIntegrityError("audit event");
    payload = safePayload.data;
  }
  const record = { ...row };
  delete record.payloadJson;
  const parsed = AuditEventRecordSchema.safeParse({ ...record, payload });
  if (!parsed.success) throw new StorageDataIntegrityError("audit event");
  return parsed.data;
}
