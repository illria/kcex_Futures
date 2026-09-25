import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CreateTradeInputSchema,
  SafeAuditPayloadSchema,
  TradeEventInputSchema,
  TradeEventRecordSchema,
  TradeRecordSchema,
  TradeUpdateSchema,
  type CreateTradeInput,
  type TradeEventInput,
  type TradeEventRecord,
  type TradeRecord,
  type TradeUpdate,
} from "../../../../packages/shared/src/storage.js";
import {
  DuplicateTradeError,
  StorageDataIntegrityError,
  TradeNotFoundError,
  TradeVersionConflictError,
} from "./storage-errors.js";

const TRADE_COLUMNS = `
  id,
  symbol,
  mode,
  side,
  status,
  margin_usdt AS marginUsdt,
  leverage,
  quantity,
  entry_price AS entryPrice,
  exit_price AS exitPrice,
  realized_pnl AS realizedPnl,
  fees,
  planned_at AS plannedAt,
  opened_at AS openedAt,
  closed_at AS closedAt,
  close_reason AS closeReason,
  created_at AS createdAt,
  updated_at AS updatedAt,
  version
`;

const EVENT_COLUMNS = `
  id,
  trade_id AS tradeId,
  event_type AS eventType,
  event_time AS eventTime,
  payload_json AS payloadJson,
  created_at AS createdAt
`;

type RawRow = Record<string, unknown>;
type Clock = () => Date;

interface TradeListOptions {
  limit?: number;
}

export class TradeRepository {
  constructor(private readonly database: DatabaseSync, private readonly now: Clock = () => new Date()) {}

  createTrade(input: CreateTradeInput): TradeRecord {
    const validated = CreateTradeInputSchema.parse(input);
    const id = validated.id ?? randomUUID();
    const timestamp = this.now().toISOString();
    try {
      this.database.prepare(`
        INSERT INTO trades (
          id, symbol, mode, side, status, margin_usdt, leverage, quantity,
          entry_price, exit_price, realized_pnl, fees, planned_at, opened_at,
          closed_at, close_reason, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        id,
        validated.symbol,
        validated.mode,
        validated.side,
        validated.status,
        validated.marginUsdt ?? null,
        validated.leverage ?? null,
        validated.quantity ?? null,
        validated.entryPrice ?? null,
        validated.exitPrice ?? null,
        validated.realizedPnl ?? null,
        validated.fees ?? null,
        validated.plannedAt ?? null,
        validated.openedAt ?? null,
        validated.closedAt ?? null,
        validated.closeReason ?? null,
        timestamp,
        timestamp,
      );
    } catch (error) {
      if (this.hasTrade(id)) throw new DuplicateTradeError();
      throw error;
    }
    const record = this.getTrade(id);
    if (!record) throw new StorageDataIntegrityError("trade");
    return record;
  }

  createTradeWithEvent(input: CreateTradeInput, event: Omit<TradeEventInput, "tradeId">): TradeRecord {
    const validatedTrade = CreateTradeInputSchema.parse(input);
    const id = validatedTrade.id ?? randomUUID();
    const validatedEvent = TradeEventInputSchema.parse({ ...event, tradeId: id });
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const record = this.createTrade({ ...validatedTrade, id });
      this.appendTradeEvent(validatedEvent);
      this.database.exec("COMMIT;");
      return record;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Preserve the original plan creation error.
      }
      throw error;
    }
  }

  getTrade(id: string): TradeRecord | null {
    const row = this.database.prepare(`SELECT ${TRADE_COLUMNS} FROM trades WHERE id = ?`).get(id) as RawRow | undefined;
    return row ? parseTradeRow(row) : null;
  }

  updateTrade(id: string, patch: TradeUpdate): TradeRecord {
    const validatedPatch = TradeUpdateSchema.parse(patch);
    return this.updateTradeValidated(id, validatedPatch);
  }

  listTrades(options: TradeListOptions = {}): TradeRecord[] {
    const limit = parseLimit(options.limit, 50);
    const rows = this.database.prepare(`
      SELECT ${TRADE_COLUMNS}
      FROM trades
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit) as unknown as RawRow[];
    return rows.map(parseTradeRow);
  }

  listOpenPaperTrades(options: { symbol: "GPS_USDT"; limit?: number }): TradeRecord[] {
    const limit = parseLimit(options.limit, 2, 2);
    const rows = this.database.prepare(`
      SELECT ${TRADE_COLUMNS}
      FROM trades
      WHERE mode = 'PAPER' AND symbol = ? AND status = 'OPEN'
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(options.symbol, limit) as unknown as RawRow[];
    return rows.map(parseTradeRow);
  }

  appendTradeEvent(input: TradeEventInput): TradeEventRecord {
    const validated = TradeEventInputSchema.parse(input);
    const id = validated.id ?? randomUUID();
    const eventTime = validated.eventTime ?? this.now().toISOString();
    const createdAt = this.now().toISOString();
    const payload = validated.payload === undefined || validated.payload === null
      ? null
      : SafeAuditPayloadSchema.parse(validated.payload);
    const payloadJson = payload === null ? null : JSON.stringify(payload);

    this.database.prepare(`
      INSERT INTO trade_events(id, trade_id, event_type, event_time, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, validated.tradeId, validated.eventType, eventTime, payloadJson, createdAt);

    const row = this.database.prepare(`SELECT ${EVENT_COLUMNS} FROM trade_events WHERE id = ?`).get(id) as RawRow | undefined;
    if (!row) throw new StorageDataIntegrityError("trade event");
    return parseTradeEventRow(row);
  }

  listTradeEvents(tradeId: string, options: TradeListOptions = {}): TradeEventRecord[] {
    const limit = parseLimit(options.limit, 100);
    const rows = this.database.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM trade_events
      WHERE trade_id = ?
      ORDER BY event_time ASC, id ASC
      LIMIT ?
    `).all(tradeId, limit) as unknown as RawRow[];
    return rows.map(parseTradeEventRow);
  }

  recordTradeTransition(input: {
    tradeId: string;
    patch: TradeUpdate;
    event: Omit<TradeEventInput, "tradeId">;
  }): TradeRecord {
    const patch = TradeUpdateSchema.parse(input.patch);
    const event = TradeEventInputSchema.parse({ ...input.event, tradeId: input.tradeId });
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const updated = this.updateTradeValidated(input.tradeId, patch);
      this.appendTradeEvent(event);
      this.database.exec("COMMIT;");
      return updated;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Preserve the original transition error.
      }
      throw error;
    }
  }

  private updateTradeValidated(id: string, patch: TradeUpdate): TradeRecord {
    const current = this.getTrade(id);
    if (!current) throw new TradeNotFoundError();
    const expectedVersion = patch.expectedVersion;
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => key !== "expectedVersion" && value !== undefined),
    );
    if (current.version !== expectedVersion) throw new TradeVersionConflictError();

    const next = TradeRecordSchema.parse({
      ...current,
      ...changes,
      updatedAt: this.now().toISOString(),
      version: current.version + 1,
    });
    const result = this.database.prepare(`
      UPDATE trades SET
        status = ?,
        margin_usdt = ?,
        leverage = ?,
        quantity = ?,
        entry_price = ?,
        exit_price = ?,
        realized_pnl = ?,
        fees = ?,
        planned_at = ?,
        opened_at = ?,
        closed_at = ?,
        close_reason = ?,
        updated_at = ?,
        version = version + 1
      WHERE id = ? AND version = ?
    `).run(
      next.status,
      next.marginUsdt,
      next.leverage,
      next.quantity,
      next.entryPrice,
      next.exitPrice,
      next.realizedPnl,
      next.fees,
      next.plannedAt,
      next.openedAt,
      next.closedAt,
      next.closeReason,
      next.updatedAt,
      id,
      expectedVersion,
    );
    if (Number(result.changes) !== 1) throw new TradeVersionConflictError();
    return next;
  }

  private hasTrade(id: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 AS present FROM trades WHERE id = ?").get(id));
  }
}

function parseTradeRow(row: RawRow): TradeRecord {
  const parsed = TradeRecordSchema.safeParse(row);
  if (!parsed.success) throw new StorageDataIntegrityError("trade");
  return parsed.data;
}

function parseTradeEventRow(row: RawRow): TradeEventRecord {
  let payload: unknown = null;
  try {
    payload = typeof row.payloadJson === "string" ? JSON.parse(row.payloadJson) : null;
  } catch {
    throw new StorageDataIntegrityError("trade event");
  }
  if (payload !== null) {
    const safePayload = SafeAuditPayloadSchema.safeParse(payload);
    if (!safePayload.success) throw new StorageDataIntegrityError("trade event");
    payload = safePayload.data;
  }
  const record = { ...row };
  delete record.payloadJson;
  const parsed = TradeEventRecordSchema.safeParse({ ...record, payload });
  if (!parsed.success) throw new StorageDataIntegrityError("trade event");
  return parsed.data;
}

function parseLimit(value: unknown, defaultValue: number, maximum = 100): number {
  const limit = value === undefined ? defaultValue : value;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new RangeError(`List limit must be an integer from 1 to ${maximum}.`);
  }
  return limit;
}
