import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PaperCloseReasonSchema,
  PaperPositionSchema,
  PaperTradingStateSchema,
  createIdlePaperTradingState,
  type PaperCloseReason,
  type PaperPosition,
  type PaperTradingState,
} from "../../../../packages/shared/src/paper-trading.js";
import {
  TradeSideSchema,
  type TradeEventInput,
  type TradeRecord,
  type TradeUpdate,
} from "../../../../packages/shared/src/storage.js";
import type { DashboardEvent } from "../../../../packages/shared/src/protocol.js";
import { EventBus } from "../realtime/event-bus.js";
import { StorageService } from "../storage/storage-service.js";
import { TradeNotFoundError, TradeVersionConflictError } from "../storage/storage-errors.js";
import {
  calculatePaperCloseAccounting,
  calculatePaperEntryFee,
  calculatePaperGrossPnl,
} from "./paper-pnl.js";
import {
  PaperStateConflictError,
  PaperTradeInvalidTransitionError,
  PaperTradeModeError,
  PaperTradeNotFoundError,
  PaperTradeSymbolError,
  PaperTradingInputError,
  PaperTradingServiceClosedError,
} from "./paper-errors.js";

const PositiveFiniteSchema = z.number().finite().positive();
const UtcTimestampSchema = z.string().datetime();
const PaperFeeRateSchema = z.number().finite().min(0).max(0.01);

const PlanPaperTradeInputSchema = z.object({
  symbol: z.string().min(1).max(64),
  side: TradeSideSchema,
  marginUsdt: PositiveFiniteSchema,
  leverage: PositiveFiniteSchema,
  plannedAt: UtcTimestampSchema.optional(),
}).strict();

const OpenPaperTradeInputSchema = z.object({
  tradeId: z.string().uuid(),
  entryPrice: PositiveFiniteSchema,
  openedAt: UtcTimestampSchema.optional(),
}).strict();

const MarkPaperTradeInputSchema = z.object({
  tradeId: z.string().uuid(),
  markPrice: PositiveFiniteSchema,
  markedAt: UtcTimestampSchema.optional(),
}).strict();

const ClosePaperTradeInputSchema = z.object({
  tradeId: z.string().uuid(),
  exitPrice: PositiveFiniteSchema,
  closeReason: PaperCloseReasonSchema.optional(),
  closedAt: UtcTimestampSchema.optional(),
}).strict();

export interface PaperTradingServiceOptions {
  storage: StorageService;
  events: EventBus;
  feeRate?: number;
  clock?: () => Date;
  idGenerator?: () => string;
}

type Clock = () => Date;

export class PaperTradingService {
  private readonly clock: Clock;
  private readonly idGenerator: () => string;
  private readonly feeRate: number;
  private state: PaperTradingState;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: PaperTradingServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.feeRate = options.feeRate ?? 0;
    if (!PaperFeeRateSchema.safeParse(this.feeRate).success) throw new PaperTradingInputError();
    this.state = createIdlePaperTradingState(this.timestamp());
  }

  getState(): PaperTradingState {
    return PaperTradingStateSchema.parse({
      ...this.state,
      position: this.state.position ? { ...this.state.position } : null,
    });
  }

  recover(): Promise<PaperTradingState> {
    return this.serialize(async () => {
      try {
        const openTrades = this.options.storage.trades.listOpenPaperTrades({ symbol: "GPS_USDT", limit: 2 });
        if (openTrades.length > 1) throw new PaperStateConflictError();
        const trade = openTrades[0];
        if (!trade) {
          this.replaceState(createIdlePaperTradingState(this.timestamp()));
          this.publishState();
          return this.getState();
        }
        assertPaperTrade(trade);
        if (!isRecoverableOpenTrade(trade)) throw new PaperStateConflictError();
        const position = positionFromOpenTrade(trade);
        this.replaceState({ status: "OPEN", activeTradeId: trade.id, position, updatedAt: this.timestamp() });
        this.publishState();
        return this.getState();
      } catch (error) {
        throw error instanceof PaperStateConflictError ? error : new PaperStateConflictError();
      }
    });
  }

  planPaperTrade(input: unknown): Promise<TradeRecord> {
    return this.serialize(() => {
      this.assertOperational();
      const parsed = PlanPaperTradeInputSchema.safeParse(input);
      if (!parsed.success) throw new PaperTradingInputError();
      if (parsed.data.symbol !== "GPS_USDT") throw new PaperTradeSymbolError();
      if (this.state.status !== "IDLE") throw new PaperTradeInvalidTransitionError();
      if (this.assertNoOpenPaperConflict().length > 0) throw new PaperStateConflictError();

      const tradeId = this.idGenerator();
      const plannedAt = parsed.data.plannedAt ?? this.timestamp();
      const trade = this.options.storage.trades.createTradeWithEvent(
        {
          id: tradeId,
          symbol: "GPS_USDT",
          mode: "PAPER",
          side: parsed.data.side,
          status: "PLANNED",
          marginUsdt: parsed.data.marginUsdt,
          leverage: parsed.data.leverage,
          quantity: null,
          entryPrice: null,
          exitPrice: null,
          realizedPnl: null,
          fees: null,
          plannedAt,
          openedAt: null,
          closedAt: null,
        },
        {
          id: this.idGenerator(),
          eventType: "PAPER_TRADE_PLANNED",
          eventTime: plannedAt,
          payload: {
            symbol: "GPS_USDT",
            mode: "PAPER",
            side: parsed.data.side,
            status: "PLANNED",
            marginUsdt: parsed.data.marginUsdt,
            leverage: parsed.data.leverage,
            entryPrice: null,
            quantity: null,
          },
        },
      );
      this.replaceState({ status: "PLANNED", activeTradeId: trade.id, position: null, updatedAt: this.timestamp() });
      this.publishState();
      return trade;
    });
  }

  openPaperTrade(input: unknown): Promise<TradeRecord> {
    return this.serialize(() => {
      this.assertOperational();
      const parsed = OpenPaperTradeInputSchema.safeParse(input);
      if (!parsed.success) throw new PaperTradingInputError();
      const trade = this.requirePaperTrade(parsed.data.tradeId);
      if (trade.status !== "PLANNED") throw new PaperTradeInvalidTransitionError();
      if (this.state.status === "PLANNED" && this.state.activeTradeId !== trade.id) {
        throw new PaperTradeInvalidTransitionError();
      }
      if (this.state.status === "OPEN" && this.state.activeTradeId !== trade.id) {
        throw new PaperTradeInvalidTransitionError();
      }

      const openTrades = this.assertNoOpenPaperConflict();
      if (openTrades.some((openTrade) => openTrade.id !== trade.id)) {
        if (this.state.status === "OPEN" && this.state.activeTradeId === openTrades[0]?.id) {
          throw new PaperTradeInvalidTransitionError();
        }
        throw new PaperStateConflictError();
      }
      const notionalUsdt = finitePositive(trade.marginUsdt! * trade.leverage!);
      const quantity = finitePositive(notionalUsdt / parsed.data.entryPrice);
      const openedAt = parsed.data.openedAt ?? this.timestamp();
      const entryFee = calculatePaperEntryFee(parsed.data.entryPrice, quantity, this.feeRate);
      const updated = this.recordTransition(trade, {
        status: "OPEN",
        entryPrice: parsed.data.entryPrice,
        quantity,
        openedAt,
        fees: entryFee,
      }, {
        eventType: "PAPER_TRADE_OPENED",
        eventTime: openedAt,
        payload: {
          symbol: trade.symbol,
          mode: "PAPER",
          side: trade.side,
          status: "OPEN",
          marginUsdt: trade.marginUsdt!,
          leverage: trade.leverage!,
          entryPrice: parsed.data.entryPrice,
          quantity,
          fees: entryFee,
        },
      });
      const position = PaperPositionSchema.parse({
        tradeId: updated.id,
        symbol: updated.symbol,
        side: updated.side,
        marginUsdt: updated.marginUsdt,
        leverage: updated.leverage,
        quantity: updated.quantity,
        entryPrice: updated.entryPrice,
        markPrice: null,
        unrealizedPnl: null,
        openedAt: updated.openedAt,
      });
      this.replaceState({ status: "OPEN", activeTradeId: updated.id, position, updatedAt: this.timestamp() });
      this.publish({ type: "trade.opened", payload: {
        tradeId: updated.id,
        mode: "PAPER",
        symbol: "GPS_USDT",
        side: updated.side,
        entryPrice: updated.entryPrice!,
        quantity: updated.quantity!,
        openedAt: updated.openedAt!,
      } });
      this.publishState();
      return updated;
    });
  }

  markPaperTrade(input: unknown): Promise<PaperTradingState> {
    return this.serialize(() => {
      this.assertOperational();
      const parsed = MarkPaperTradeInputSchema.safeParse(input);
      if (!parsed.success) throw new PaperTradingInputError();
      const trade = this.requirePaperTrade(parsed.data.tradeId);
      if (trade.status !== "OPEN" || this.state.status !== "OPEN" || this.state.activeTradeId !== trade.id) {
        throw new PaperTradeInvalidTransitionError();
      }
      const unrealizedPnl = calculatePaperGrossPnl({
        side: trade.side,
        entryPrice: trade.entryPrice!,
        exitPrice: parsed.data.markPrice,
        quantity: trade.quantity!,
      });
      if (!this.state.position) throw new PaperStateConflictError();
      const position = PaperPositionSchema.parse({
        ...this.state.position,
        markPrice: parsed.data.markPrice,
        unrealizedPnl,
      });
      this.replaceState({ status: "OPEN", activeTradeId: trade.id, position, updatedAt: parsed.data.markedAt ?? this.timestamp() });
      this.publishState();
      return this.getState();
    });
  }

  closePaperTrade(input: unknown): Promise<TradeRecord> {
    return this.serialize(() => {
      this.assertOperational();
      const parsed = ClosePaperTradeInputSchema.safeParse(input);
      if (!parsed.success) throw new PaperTradingInputError();
      const trade = this.requirePaperTrade(parsed.data.tradeId);
      if (trade.status !== "OPEN" || this.state.status !== "OPEN" || this.state.activeTradeId !== trade.id) {
        throw new PaperTradeInvalidTransitionError();
      }
      const accounting = calculatePaperCloseAccounting({
        side: trade.side,
        entryPrice: trade.entryPrice!,
        exitPrice: parsed.data.exitPrice,
        quantity: trade.quantity!,
      }, this.feeRate);
      const closedAt = parsed.data.closedAt ?? this.timestamp();
      const closeReason: PaperCloseReason = parsed.data.closeReason ?? "MANUAL";
      const updated = this.recordTransition(trade, {
        status: "CLOSED",
        exitPrice: parsed.data.exitPrice,
        realizedPnl: accounting.realizedPnl,
        fees: accounting.fees,
        closedAt,
        closeReason,
      }, {
        eventType: "PAPER_TRADE_CLOSED",
        eventTime: closedAt,
        payload: {
          symbol: trade.symbol,
          mode: "PAPER",
          side: trade.side,
          status: "CLOSED",
          entryPrice: trade.entryPrice!,
          exitPrice: parsed.data.exitPrice,
          quantity: trade.quantity!,
          marginUsdt: trade.marginUsdt!,
          leverage: trade.leverage!,
          realizedPnl: accounting.realizedPnl,
          fees: accounting.fees,
          closeReason,
        },
      });
      this.replaceState(createIdlePaperTradingState(this.timestamp()));
      this.publish({ type: "trade.closed", payload: {
        tradeId: updated.id,
        mode: "PAPER",
        symbol: "GPS_USDT",
        side: updated.side,
        entryPrice: updated.entryPrice!,
        exitPrice: updated.exitPrice!,
        quantity: updated.quantity!,
        realizedPnl: updated.realizedPnl!,
        fees: updated.fees!,
        closeReason,
        closedAt: updated.closedAt!,
      } });
      this.publishState();
      return updated;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
  }

  private serialize<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.closed) throw new PaperTradingServiceClosedError();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof PaperStateConflictError && !error.runtimeReconciled) this.halt();
        this.publishState();
        throw error;
      }
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertOperational(): void {
    if (this.state.status === "ERROR") throw new PaperStateConflictError();
  }

  private assertNoOpenPaperConflict(): TradeRecord[] {
    const openTrades = this.options.storage.trades.listOpenPaperTrades({ symbol: "GPS_USDT", limit: 2 });
    if (openTrades.length > 1) throw new PaperStateConflictError();
    return openTrades;
  }

  private requirePaperTrade(tradeId: string): TradeRecord {
    let trade: TradeRecord | null;
    try {
      trade = this.options.storage.trades.getTrade(tradeId);
    } catch {
      throw new PaperStateConflictError();
    }
    if (!trade) throw new PaperTradeNotFoundError();
    assertPaperTrade(trade);
    return trade;
  }

  private recordTransition(
    trade: TradeRecord,
    fields: Omit<TradeUpdate, "expectedVersion">,
    event: Omit<TradeEventInput, "id" | "tradeId">,
  ): TradeRecord {
    try {
      return this.options.storage.trades.recordTradeTransition({
        tradeId: trade.id,
        patch: { expectedVersion: trade.version, ...fields },
        event: { ...event, id: this.idGenerator() },
      });
    } catch (error) {
      if (error instanceof TradeVersionConflictError || error instanceof TradeNotFoundError) {
        throw new PaperStateConflictError(this.reconcileRuntimeAfterConflict(trade.id));
      }
      throw error;
    }
  }

  private reconcileRuntimeAfterConflict(tradeId: string): boolean {
    try {
      const openTrades = this.options.storage.trades.listOpenPaperTrades({ symbol: "GPS_USDT", limit: 2 });
      if (openTrades.length > 1) {
        this.halt();
        return false;
      }
      const openTrade = openTrades[0];
      if (openTrade) {
        if (!isRecoverableOpenTrade(openTrade)) {
          this.halt();
          return false;
        }
        this.replaceState({
          status: "OPEN",
          activeTradeId: openTrade.id,
          position: positionFromOpenTrade(openTrade),
          updatedAt: this.timestamp(),
        });
        return true;
      }

      const current = this.options.storage.trades.getTrade(tradeId);
      if (current?.mode === "PAPER" && current.symbol === "GPS_USDT" && current.status === "PLANNED") {
        this.replaceState({ status: "PLANNED", activeTradeId: current.id, position: null, updatedAt: this.timestamp() });
      } else {
        this.replaceState(createIdlePaperTradingState(this.timestamp()));
      }
      return true;
    } catch {
      this.halt();
      return false;
    }
  }

  private replaceState(state: PaperTradingState): void {
    this.state = PaperTradingStateSchema.parse(state);
  }

  private halt(): void {
    this.replaceState({ status: "ERROR", activeTradeId: null, position: null, updatedAt: this.timestamp() });
  }

  private publishState(): void {
    this.publish({ type: "paper.state", payload: this.getState() });
  }

  private publish(event: Extract<DashboardEvent, { type: "paper.state" | "trade.opened" | "trade.closed" }>): void {
    this.options.events.publish({ version: 1, timestamp: this.timestamp(), ...event });
  }

  private timestamp(): string {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new PaperTradingInputError();
    return value.toISOString();
  }
}

function assertPaperTrade(trade: TradeRecord): void {
  if (trade.mode !== "PAPER") throw new PaperTradeModeError();
  if (trade.symbol !== "GPS_USDT") throw new PaperTradeSymbolError();
}

function isRecoverableOpenTrade(trade: TradeRecord): boolean {
  return trade.mode === "PAPER"
    && trade.symbol === "GPS_USDT"
    && trade.status === "OPEN"
    && trade.entryPrice !== null
    && trade.entryPrice > 0
    && trade.quantity !== null
    && trade.quantity > 0
    && trade.marginUsdt !== null
    && trade.marginUsdt > 0
    && trade.leverage !== null
    && trade.leverage > 0
    && trade.openedAt !== null;
}

function positionFromOpenTrade(trade: TradeRecord): PaperPosition {
  if (!isRecoverableOpenTrade(trade)) throw new PaperStateConflictError();
  return PaperPositionSchema.parse({
    tradeId: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    marginUsdt: trade.marginUsdt,
    leverage: trade.leverage,
    quantity: trade.quantity,
    entryPrice: trade.entryPrice,
    markPrice: null,
    unrealizedPnl: null,
    openedAt: trade.openedAt,
  });
}

function finitePositive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new PaperTradingInputError();
  return value;
}
