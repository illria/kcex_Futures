import { describe, expect, it } from "vitest";
import { deriveProtectionPrice, evaluateProtectionTrigger } from "../../packages/shared/src/protection.js";

describe("TASK-010 fixture protection calculations", () => {
  it.each([
    ["LONG PRICE TP", "LONG", "TAKE_PROFIT", "PRICE_PCT", 5, 105],
    ["LONG PRICE SL", "LONG", "STOP_LOSS", "PRICE_PCT", 5, 95],
    ["SHORT PRICE TP", "SHORT", "TAKE_PROFIT", "PRICE_PCT", 5, 95],
    ["SHORT PRICE SL", "SHORT", "STOP_LOSS", "PRICE_PCT", 5, 105],
    ["LONG ROI TP", "LONG", "TAKE_PROFIT", "ROI_PCT", 30, 103],
    ["LONG ROI SL", "LONG", "STOP_LOSS", "ROI_PCT", 30, 97],
    ["SHORT ROI TP", "SHORT", "TAKE_PROFIT", "ROI_PCT", 30, 97],
    ["SHORT ROI SL", "SHORT", "STOP_LOSS", "ROI_PCT", 30, 103],
  ] as const)("calculates %s", (_label, side, legType, basis, value, expected) => {
    expect(deriveProtectionPrice({ side, entryPrice: 100, leverage: 10, legType, basis, value })).toBe(expected);
  });

  it.each([
    ["zero", 0, "PRICE_PCT"],
    ["negative", -1, "PRICE_PCT"],
    ["NaN", Number.NaN, "PRICE_PCT"],
    ["infinity", Number.POSITIVE_INFINITY, "PRICE_PCT"],
    ["price above maximum", 99.01, "PRICE_PCT"],
    ["ROI above maximum", 500.1, "ROI_PCT"],
  ] as const)("rejects %s", (_label, value, basis) => {
    expect(() => deriveProtectionPrice({ side: "LONG", entryPrice: 100, leverage: 10, legType: "STOP_LOSS", basis, value })).toThrow(RangeError);
  });

  it("rejects nonpositive entry, invalid leverage, and a nonpositive derived target", () => {
    expect(() => deriveProtectionPrice({ side: "LONG", entryPrice: 0, leverage: 10, legType: "TAKE_PROFIT", basis: "PRICE_PCT", value: 5 })).toThrow(RangeError);
    expect(() => deriveProtectionPrice({ side: "LONG", entryPrice: 100, leverage: 0, legType: "TAKE_PROFIT", basis: "PRICE_PCT", value: 5 })).toThrow(RangeError);
    expect(() => deriveProtectionPrice({ side: "SHORT", entryPrice: 100, leverage: 0.1, legType: "TAKE_PROFIT", basis: "ROI_PCT", value: 500 })).toThrow(RangeError);
  });

  it.each([
    ["long TP", "LONG", 106, 105, 95, "TRIGGERED_TP"],
    ["long SL", "LONG", 94, 105, 95, "TRIGGERED_SL"],
    ["long inside", "LONG", 100, 105, 95, "NONE"],
    ["short TP", "SHORT", 94, 95, 105, "TRIGGERED_TP"],
    ["short SL", "SHORT", 106, 95, 105, "TRIGGERED_SL"],
    ["short inside", "SHORT", 100, 95, 105, "NONE"],
  ] as const)("evaluates %s without closing a position", (_label, side, markPrice, takeProfitTarget, stopLossTarget, expected) => {
    expect(evaluateProtectionTrigger({ side, markPrice, takeProfitTarget, stopLossTarget })).toBe(expected);
  });

  it("returns UNKNOWN when one mark satisfies both supplied boundaries", () => {
    expect(evaluateProtectionTrigger({ side: "LONG", markPrice: 100, takeProfitTarget: 95, stopLossTarget: 105 })).toBe("UNKNOWN");
  });
});
