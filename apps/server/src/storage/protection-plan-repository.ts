import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppendAuditEventInput } from "../../../../packages/shared/src/storage.js";
import {
  ProtectionPlanEventSchema,
  ProtectionPlanSchema,
  type DurableProtectionStatus,
  type ProtectionPlan,
  type ProtectionPlanEvent,
  type ProtectionPlanEventType,
} from "../../../../packages/shared/src/protection.js";
import type { AuditRepository } from "./audit-repository.js";
import { StorageDataIntegrityError } from "./storage-errors.js";

type RawRow = Record<string, unknown>;
type Clock = () => Date;

const PLAN_COLUMNS = `
  id,
  execution_attempt_id AS executionAttemptId,
  provider,
  symbol,
  side,
  entry_price AS entryPrice,
  position_size AS positionSize,
  leverage,
  tp_basis AS tpBasis,
  tp_value AS tpValue,
  tp_target_price AS tpTargetPrice,
  sl_basis AS slBasis,
  sl_value AS slValue,
  sl_target_price AS slTargetPrice,
  status,
  triggered_leg AS triggeredLeg,
  fixture_protection_id AS fixtureProtectionId,
  created_at AS createdAt,
  activated_at AS activatedAt,
  triggered_at AS triggeredAt,
  updated_at AS updatedAt,
  version
`;

export interface CreateProtectionPlanInput {
  plan: ProtectionPlan;
  eventType: ProtectionPlanEventType;
  eventPayload?: Record<string, unknown> | null;
  audit: AppendAuditEventInput;
}

export interface ProtectionPlanPatch {
  triggeredLeg?: "TAKE_PROFIT" | "STOP_LOSS" | null;
  fixtureProtectionId?: string | null;
  activatedAt?: string | null;
  triggeredAt?: string | null;
}

export class ProtectionPlanRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly auditEvents: AuditRepository,
    private readonly now: Clock = () => new Date(),
  ) {}

  createPlanWithEventAndAudit(input: CreateProtectionPlanInput): ProtectionPlan {
    const plan = ProtectionPlanSchema.parse(input.plan);
    if (plan.status !== "PLANNED") throw new RangeError("New protection plans must start in PLANNED.");
    const event = makeEvent(plan.id, input.eventType, this.timestamp(), input.eventPayload ?? null, this.timestamp());
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.insertPlan(plan);
      this.insertEvent(event);
      this.auditEvents.appendAuditEvent(input.audit);
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original insert error. */ }
      throw error;
    }
    const stored = this.getPlan(plan.id);
    if (!stored) throw new StorageDataIntegrityError("protection plan");
    return stored;
  }

  getPlan(id: string): ProtectionPlan | null {
    const row = this.database.prepare(`SELECT ${PLAN_COLUMNS} FROM protection_plans WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? parsePlanRow(row) : null;
  }

  getByAttemptId(executionAttemptId: string): ProtectionPlan | null {
    const row = this.database.prepare(`SELECT ${PLAN_COLUMNS} FROM protection_plans WHERE execution_attempt_id = ?`)
      .get(executionAttemptId) as RawRow | undefined;
    return row ? parsePlanRow(row) : null;
  }

  getPositionGuardPlan(): ProtectionPlan | null {
    const row = this.database.prepare(`
      SELECT ${PLAN_COLUMNS} FROM protection_plans
      WHERE symbol = 'GPS_USDT' AND status IN ('PLANNED', 'ACTIVE', 'UNKNOWN')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get() as RawRow | undefined;
    return row ? parsePlanRow(row) : null;
  }

  getLatestPlan(): ProtectionPlan | null {
    const row = this.database.prepare(`
      SELECT ${PLAN_COLUMNS} FROM protection_plans
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get() as RawRow | undefined;
    return row ? parsePlanRow(row) : null;
  }

  listPlans(limit = 50): ProtectionPlan[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("Protection plan limit must be from 1 to 100.");
    const rows = this.database.prepare(`
      SELECT ${PLAN_COLUMNS} FROM protection_plans
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(limit) as unknown as RawRow[];
    return rows.map(parsePlanRow);
  }

  listEvents(protectionId: string, limit = 100): ProtectionPlanEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new RangeError("Protection event limit must be from 1 to 200.");
    const rows = this.database.prepare(`
      SELECT id, protection_id AS protectionId, event_type AS eventType, event_time AS eventTime,
        payload_json AS payloadJson, created_at AS createdAt
      FROM protection_events WHERE protection_id = ? ORDER BY rowid ASC LIMIT ?
    `).all(protectionId, limit) as unknown as RawRow[];
    return rows.map(parseEventRow);
  }

  transitionWithEventAndAudit(input: {
    id: string;
    expectedVersion: number;
    status: DurableProtectionStatus;
    patch?: ProtectionPlanPatch;
    eventType: ProtectionPlanEventType;
    eventPayload?: Record<string, unknown> | null;
    audit: AppendAuditEventInput;
  }): ProtectionPlan {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getPlan(input.id);
      if (!current) throw new StorageDataIntegrityError("protection plan");
      if (current.version !== input.expectedVersion) throw new Error("PROTECTION_VERSION_CONFLICT");
      if (!canTransition(current.status, input.status)) throw new Error("INVALID_PROTECTION_TRANSITION");
      const next = ProtectionPlanSchema.parse({
        ...current,
        ...input.patch,
        status: input.status,
        updatedAt: this.timestamp(),
        version: current.version + 1,
      });
      const result = this.database.prepare(`
        UPDATE protection_plans SET
          status = ?, triggered_leg = ?, fixture_protection_id = ?, activated_at = ?, triggered_at = ?, updated_at = ?, version = ?
        WHERE id = ? AND version = ?
      `).run(
        next.status,
        next.triggeredLeg,
        next.fixtureProtectionId,
        next.activatedAt,
        next.triggeredAt,
        next.updatedAt,
        next.version,
        input.id,
        input.expectedVersion,
      );
      if (Number(result.changes) !== 1) throw new Error("PROTECTION_VERSION_CONFLICT");
      const event = makeEvent(next.id, input.eventType, this.timestamp(), input.eventPayload ?? null, this.timestamp());
      this.insertEvent(event);
      this.auditEvents.appendAuditEvent(input.audit);
      this.database.exec("COMMIT;");
      const stored = this.getPlan(input.id);
      if (!stored) throw new StorageDataIntegrityError("protection plan");
      return stored;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transition error. */ }
      throw error;
    }
  }

  rearmFailedPlanWithEventAndAudit(input: {
    plan: ProtectionPlan;
    expectedVersion: number;
    eventType: ProtectionPlanEventType;
    eventPayload?: Record<string, unknown> | null;
    audit: AppendAuditEventInput;
  }): ProtectionPlan {
    const replacement = ProtectionPlanSchema.parse(input.plan);
    if (replacement.status !== "PLANNED") throw new RangeError("Re-armed protection must be PLANNED.");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getPlan(replacement.id);
      if (!current) throw new StorageDataIntegrityError("protection plan");
      if (current.status !== "ERROR" || current.version !== input.expectedVersion) throw new Error("PROTECTION_VERSION_CONFLICT");
      const next = ProtectionPlanSchema.parse({ ...replacement, version: current.version + 1 });
      const result = this.database.prepare(`
        UPDATE protection_plans SET
          entry_price = ?, position_size = ?, leverage = ?, tp_basis = ?, tp_value = ?, tp_target_price = ?,
          sl_basis = ?, sl_value = ?, sl_target_price = ?, status = 'PLANNED', triggered_leg = NULL,
          fixture_protection_id = NULL, activated_at = NULL, triggered_at = NULL, updated_at = ?, version = ?
        WHERE id = ? AND version = ? AND status = 'ERROR'
      `).run(
        next.entryPrice, next.positionSize, next.leverage,
        next.takeProfit.basis, next.takeProfit.value, next.takeProfit.targetPrice,
        next.stopLoss.basis, next.stopLoss.value, next.stopLoss.targetPrice,
        next.updatedAt, next.version, next.id, input.expectedVersion,
      );
      if (Number(result.changes) !== 1) throw new Error("PROTECTION_VERSION_CONFLICT");
      this.insertEvent(makeEvent(next.id, input.eventType, this.timestamp(), input.eventPayload ?? null, this.timestamp()));
      this.auditEvents.appendAuditEvent(input.audit);
      this.database.exec("COMMIT;");
      const stored = this.getPlan(next.id);
      if (!stored) throw new StorageDataIntegrityError("protection plan");
      return stored;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original transition error. */ }
      throw error;
    }
  }

  private insertPlan(plan: ProtectionPlan): void {
    this.database.prepare(`
      INSERT INTO protection_plans (
        id, execution_attempt_id, provider, symbol, side, entry_price, position_size, leverage,
        tp_basis, tp_value, tp_target_price, sl_basis, sl_value, sl_target_price, status,
        triggered_leg, fixture_protection_id, created_at, activated_at, triggered_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id, plan.executionAttemptId, plan.provider, plan.symbol, plan.side, plan.entryPrice, plan.positionSize, plan.leverage,
      plan.takeProfit.basis, plan.takeProfit.value, plan.takeProfit.targetPrice,
      plan.stopLoss.basis, plan.stopLoss.value, plan.stopLoss.targetPrice, plan.status,
      plan.triggeredLeg, plan.fixtureProtectionId, plan.createdAt, plan.activatedAt, plan.triggeredAt, plan.updatedAt, plan.version,
    );
  }

  private insertEvent(event: ProtectionPlanEvent): void {
    this.database.prepare(`
      INSERT INTO protection_events(id, protection_id, event_type, event_time, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.protectionId, event.eventType, event.eventTime,
      event.payload === null ? null : JSON.stringify(event.payload), event.createdAt);
  }

  private timestamp(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new StorageDataIntegrityError("protection clock");
    return value.toISOString();
  }
}

function makeEvent(
  protectionId: string,
  eventType: ProtectionPlanEventType,
  eventTime: string,
  payload: Record<string, unknown> | null,
  createdAt: string,
): ProtectionPlanEvent {
  return ProtectionPlanEventSchema.parse({ id: randomUUID(), protectionId, eventType, eventTime, payload, createdAt });
}

function canTransition(from: DurableProtectionStatus, to: DurableProtectionStatus): boolean {
  const allowed: Record<DurableProtectionStatus, readonly DurableProtectionStatus[]> = {
    PLANNED: ["ACTIVE", "UNKNOWN", "ERROR"],
    ACTIVE: ["TRIGGERED_TP", "TRIGGERED_SL", "UNKNOWN"],
    TRIGGERED_TP: [],
    TRIGGERED_SL: [],
    UNKNOWN: [],
    ERROR: ["PLANNED"],
  };
  return allowed[from].includes(to);
}

function parsePlanRow(row: RawRow): ProtectionPlan {
  const parsed = ProtectionPlanSchema.safeParse({
    id: row.id,
    executionAttemptId: row.executionAttemptId,
    provider: row.provider,
    symbol: row.symbol,
    side: row.side,
    entryPrice: row.entryPrice,
    positionSize: row.positionSize,
    leverage: row.leverage,
    takeProfit: { basis: row.tpBasis, value: row.tpValue, targetPrice: row.tpTargetPrice },
    stopLoss: { basis: row.slBasis, value: row.slValue, targetPrice: row.slTargetPrice },
    status: row.status,
    triggeredLeg: row.triggeredLeg,
    fixtureProtectionId: row.fixtureProtectionId,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    triggeredAt: row.triggeredAt,
    updatedAt: row.updatedAt,
    version: row.version,
  });
  if (!parsed.success) throw new StorageDataIntegrityError("protection plan");
  return parsed.data;
}

function parseEventRow(row: RawRow): ProtectionPlanEvent {
  let payload: unknown = null;
  try { payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : null; }
  catch { throw new StorageDataIntegrityError("protection event"); }
  const parsed = ProtectionPlanEventSchema.safeParse({
    id: row.id,
    protectionId: row.protectionId,
    eventType: row.eventType,
    eventTime: row.eventTime,
    payload,
    createdAt: row.createdAt,
  });
  if (!parsed.success) throw new StorageDataIntegrityError("protection event");
  return parsed.data;
}
