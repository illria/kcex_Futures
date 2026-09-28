import { describe, expect, it } from "vitest";
import { calculatePaperCloseAccounting, calculatePaperGrossPnl } from "../../apps/server/src/trading/paper-pnl.js";

describe("paper PnL model", () => {
  it("calculates long profit and loss without multiplying leverage twice", () => {
    expect(calculatePaperGrossPnl({ side: "LONG", entryPrice: 0.01, exitPrice: 0.011, quantity: 50_000 })).toBeCloseTo(50);
    expect(calculatePaperGrossPnl({ side: "LONG", entryPrice: 0.01, exitPrice: 0.009, quantity: 50_000 })).toBeCloseTo(-50);
  });

  it("calculates short profit and loss", () => {
    expect(calculatePaperGrossPnl({ side: "SHORT", entryPrice: 0.01, exitPrice: 0.009, quantity: 50_000 })).toBeCloseTo(50);
    expect(calculatePaperGrossPnl({ side: "SHORT", entryPrice: 0.01, exitPrice: 0.011, quantity: 50_000 })).toBeCloseTo(-50);
  });

  it("returns zero at a flat price and applies a zero simulated fee by default", () => {
    const result = calculatePaperCloseAccounting(
      { side: "LONG", entryPrice: 0.01, exitPrice: 0.01, quantity: 50_000 },
      0,
    );
    expect(result.grossPnl).toBe(0);
    expect(result.fees).toBe(0);
    expect(result.realizedPnl).toBe(0);
  });

  it("calculates both simulated entry and exit fees", () => {
    const result = calculatePaperCloseAccounting(
      { side: "LONG", entryPrice: 0.01, exitPrice: 0.011, quantity: 50_000 },
      0.0001,
    );
    expect(result.entryFee).toBeCloseTo(0.05);
    expect(result.exitFee).toBeCloseTo(0.055);
    expect(result.fees).toBeCloseTo(0.105);
    expect(result.realizedPnl).toBeCloseTo(49.895);
  });

  it("rejects non-positive or non-finite prices, quantities, and fee rates", () => {
    expect(() => calculatePaperGrossPnl({ side: "LONG", entryPrice: 0, exitPrice: 1, quantity: 1 })).toThrow();
    expect(() => calculatePaperGrossPnl({ side: "LONG", entryPrice: 1, exitPrice: Number.NaN, quantity: 1 })).toThrow();
    expect(() => calculatePaperGrossPnl({ side: "LONG", entryPrice: 1, exitPrice: 2, quantity: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => calculatePaperCloseAccounting({ side: "LONG", entryPrice: 1, exitPrice: 2, quantity: 1 }, -0.1)).toThrow();
    expect(() => calculatePaperCloseAccounting({ side: "LONG", entryPrice: 1, exitPrice: 2, quantity: 1 }, 0.0101)).toThrow();
  });
});
