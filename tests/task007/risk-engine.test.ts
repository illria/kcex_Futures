import { describe, expect, it } from "vitest";
import {
  DEFAULT_RISK_LIMITS,
  type RiskContext,
  type RiskReasonCode,
  type RiskStatus,
  type RiskTradeIntent,
} from "../../packages/shared/src/risk.js";
import { evaluateRisk } from "../../apps/server/src/risk/risk-engine.js";

const NOW = "2026-09-29T12:00:00.000Z";
const intent: RiskTradeIntent = {
  mode: "PAPER",
  symbol: "GPS_USDT",
  side: "LONG",
  marginUsdt: 50,
  leverage: 10,
};
const context: RiskContext = {
  liveTrading: false,
  killSwitch: "CLEAR",
  storageStatus: "READY",
  positionState: "FLAT",
  dailyOpenedTrades: 0,
  dailyRealizedLossUsdt: 0,
  consecutiveFailures: 0,
};

function decide(
  intentOverrides: Partial<RiskTradeIntent> = {},
  contextOverrides: Partial<RiskContext> = {},
) {
  return evaluateRisk({ ...intent, ...intentOverrides }, { ...context, ...contextOverrides }, DEFAULT_RISK_LIMITS, NOW);
}

describe("pure RiskEngine", () => {
  it("allows a normal GPS_USDT PAPER intent at the exact default ceilings", () => {
    expect(decide()).toMatchObject({ allowed: true, status: "READY", reasons: [], evaluatedAt: NOW });
  });

  const blockedIntentCases: Array<[Partial<RiskTradeIntent>, RiskReasonCode]> = [
    [{ marginUsdt: 50.000001 }, "MARGIN_LIMIT"],
    [{ leverage: 10.0001 }, "LEVERAGE_LIMIT"],
    [{ symbol: "ETH_USDT" }, "SYMBOL_NOT_ALLOWED"],
    [{ mode: "LIVE" }, "LIVE_TRADING_DISABLED"],
  ];
  it.each(blockedIntentCases)("blocks an intent violating %s", (override, reason) => {
    const result = decide(override as Partial<RiskTradeIntent>);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("allows a LIVE intent only when runtime context explicitly enables it, then applies the same guards", () => {
    expect(decide({ mode: "LIVE" }, { liveTrading: true })).toMatchObject({ allowed: true, status: "READY", reasons: [] });
    expect(decide({ mode: "LIVE" }, { liveTrading: true, positionState: "OPEN" }))
      .toMatchObject({ allowed: false, status: "BLOCKED", reasons: ["POSITION_OPEN"] });
    expect(decide({ mode: "LIVE" }, { liveTrading: true, killSwitch: "ENGAGED" }))
      .toMatchObject({ allowed: false, status: "HALTED", reasons: ["KILL_SWITCH_ENGAGED"] });
  });

  const contextCases: Array<[Partial<RiskContext>, RiskStatus, RiskReasonCode | undefined]> = [
    [{ positionState: "OPEN" as const }, "BLOCKED", "POSITION_OPEN"],
    [{ positionState: "UNKNOWN" as const }, "HALTED", "POSITION_UNKNOWN"],
    [{ dailyOpenedTrades: 9 }, "READY", undefined],
    [{ dailyOpenedTrades: 10 }, "BLOCKED", "DAILY_TRADE_LIMIT"],
    [{ dailyRealizedLossUsdt: 49.99 }, "READY", undefined],
    [{ dailyRealizedLossUsdt: 50 }, "BLOCKED", "DAILY_LOSS_LIMIT"],
    [{ consecutiveFailures: 2 }, "READY", undefined],
    [{ consecutiveFailures: 3 }, "HALTED", "CONSECUTIVE_FAILURE_LIMIT"],
    [{ killSwitch: "ENGAGED" as const }, "HALTED", "KILL_SWITCH_ENGAGED"],
    [{ killSwitch: "UNKNOWN" as const }, "HALTED", "KILL_SWITCH_UNKNOWN"],
    [{ storageStatus: "DEGRADED" as const }, "HALTED", "STORAGE_DEGRADED"],
  ];
  it.each(contextCases)("maps context %s to %s", (override, status, reason) => {
    const result = decide({}, override);
    expect(result.status).toBe(status);
    if (reason) expect(result.reasons).toContain(reason);
  });

  it("returns multiple deterministic reasons instead of stopping at the first violation", () => {
    const result = decide(
      { marginUsdt: 51 },
      { killSwitch: "ENGAGED", dailyOpenedTrades: 10 },
    );
    expect(result.allowed).toBe(false);
    expect(result.status).toBe("HALTED");
    expect(result.reasons).toEqual(["MARGIN_LIMIT", "DAILY_TRADE_LIMIT", "KILL_SWITCH_ENGAGED"]);
  });

  it("rejects invalid, non-finite intent and limits at the schema boundary", () => {
    expect(() => evaluateRisk({ ...intent, marginUsdt: Number.NaN }, context, DEFAULT_RISK_LIMITS, NOW)).toThrow();
    expect(() => evaluateRisk(intent, context, { ...DEFAULT_RISK_LIMITS, maxLeverage: 10.1 }, NOW)).toThrow();
    expect(() => evaluateRisk(intent, { ...context, dailyOpenedTrades: null }, DEFAULT_RISK_LIMITS, NOW))
      .not.toThrow();
    expect(decide({}, { dailyOpenedTrades: null }).reasons).toContain("STORAGE_DEGRADED");
  });
});
