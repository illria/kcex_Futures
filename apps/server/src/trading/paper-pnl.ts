import { z } from "zod";
import { TradeSideSchema } from "../../../../packages/shared/src/storage.js";
import { PaperTradingInputError } from "./paper-errors.js";

const PositiveFiniteSchema = z.number().finite().positive();
const FeeRateSchema = z.number().finite().min(0).max(0.01);

export interface PaperPnlInput {
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  quantity: number;
}

export interface PaperCloseAccounting extends PaperPnlInput {
  grossPnl: number;
  entryFee: number;
  exitFee: number;
  fees: number;
  realizedPnl: number;
}

function assertPositiveFinite(value: number): void {
  if (!PositiveFiniteSchema.safeParse(value).success) throw new PaperTradingInputError();
}

function assertFeeRate(feeRate: number): void {
  if (!FeeRateSchema.safeParse(feeRate).success) throw new PaperTradingInputError();
}

function assertFiniteResult(value: number): number {
  if (!Number.isFinite(value)) throw new PaperTradingInputError();
  return value;
}

export function calculatePaperGrossPnl(input: PaperPnlInput): number {
  if (!TradeSideSchema.safeParse(input.side).success) throw new PaperTradingInputError();
  assertPositiveFinite(input.entryPrice);
  assertPositiveFinite(input.exitPrice);
  assertPositiveFinite(input.quantity);

  const grossPnl = input.side === "LONG"
    ? (input.exitPrice - input.entryPrice) * input.quantity
    : (input.entryPrice - input.exitPrice) * input.quantity;
  return assertFiniteResult(grossPnl);
}

export function calculatePaperEntryFee(entryPrice: number, quantity: number, feeRate: number): number {
  assertPositiveFinite(entryPrice);
  assertPositiveFinite(quantity);
  assertFeeRate(feeRate);
  return assertFiniteResult(assertFiniteResult(entryPrice * quantity) * feeRate);
}

export function calculatePaperCloseAccounting(input: PaperPnlInput, feeRate: number): PaperCloseAccounting {
  assertFeeRate(feeRate);
  const grossPnl = calculatePaperGrossPnl(input);
  const entryFee = calculatePaperEntryFee(input.entryPrice, input.quantity, feeRate);
  const exitFee = calculatePaperEntryFee(input.exitPrice, input.quantity, feeRate);
  const fees = assertFiniteResult(entryFee + exitFee);
  const realizedPnl = assertFiniteResult(grossPnl - fees);
  return { ...input, grossPnl, entryFee, exitFee, fees, realizedPnl };
}
