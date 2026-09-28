/** @vitest-environment happy-dom */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyRiskBlockedToDashboard, applyRiskStateToDashboard, DashboardView } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, DashboardSnapshotSchema } from "../../packages/shared/src/protocol.js";
import { DEFAULT_RISK_LIMITS, RiskStateSchema } from "../../packages/shared/src/risk.js";

const NOW = "2026-09-29T12:00:00.000Z";
const auth = AuthStateSchema.parse({
  status: "AUTHENTICATED",
  credentialsSaved: false,
  liveTrading: false,
  authProvider: "FAKE",
  updatedAt: NOW,
});

describe("read-only Risk Controls panel", () => {
  it("renders READY/CLEAR and current limits and counters", () => {
    const snapshot = createFakeDashboardSnapshot(true, NOW);
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: false,
    }));
    expect(html).toContain("Risk Controls");
    expect(html).toContain("READY");
    expect(html).toContain("CLEAR");
    expect(html).toContain("0 / 10");
    expect(html).toContain("0.00 / 50.00 USDT");
    expect(html).toContain("LIVE_TRADING=false");
    expect(html).not.toContain("Enable Risk");
    expect(html).not.toContain("Disable Risk");
    expect(html).not.toContain("Arm Live");
  });

  it("displays a halted Kill Switch and daily limits without mutation controls", () => {
    const initial = createFakeDashboardSnapshot(true, NOW);
    const risk = RiskStateSchema.parse({
      status: "HALTED",
      killSwitch: "ENGAGED",
      limits: DEFAULT_RISK_LIMITS,
      metrics: {
        mode: "PAPER",
        dateKey: "2026-09-29",
        dailyOpenedTrades: 10,
        dailyRealizedLossUsdt: 50,
        consecutiveFailures: 3,
      },
      reasons: ["DAILY_TRADE_LIMIT", "DAILY_LOSS_LIMIT", "KILL_SWITCH_ENGAGED"],
      updatedAt: NOW,
    });
    const snapshot = applyRiskStateToDashboard(initial, risk);
    expect(DashboardSnapshotSchema.parse(snapshot)).toMatchObject({
      status: { killSwitch: "ENGAGED" },
      risk: { status: "HALTED", killSwitch: "ENGAGED" },
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: true,
    }));
    expect(html).toContain("10 / 10");
    expect(html).toContain("50.00 / 50.00 USDT");
    expect(html).toContain("3 / 3");
    expect(html).toContain("DAILY_TRADE_LIMIT");
    expect(html).toContain("ENGAGED");
    expect(html).not.toContain("Enable Risk");
    expect(html).not.toContain("Disable Risk");
    expect(html).not.toContain("Arm Live");
  });

  it("keeps unknown metric values unavailable instead of displaying a fabricated zero", () => {
    const initial = createFakeDashboardSnapshot(true, NOW);
    const risk = RiskStateSchema.parse({
      ...initial.risk,
      status: "HALTED",
      killSwitch: "UNKNOWN",
      metrics: { ...initial.risk.metrics, dailyOpenedTrades: null, consecutiveFailures: null },
      reasons: ["STORAGE_DEGRADED", "KILL_SWITCH_UNKNOWN"],
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: applyRiskStateToDashboard(initial, risk),
      auth,
      webSocketConnected: true,
    }));
    expect(html).toContain("— / 10");
    expect(html).toContain("UNKNOWN");
  });

  it("surfaces a validated risk.blocked reason without creating an execution retry", () => {
    const current = createFakeDashboardSnapshot(true, NOW);
    const updated = applyRiskBlockedToDashboard(current, {
      mode: "PAPER",
      symbol: "GPS_USDT",
      side: "LONG",
      marginUsdt: 50.01,
      leverage: 10,
      reasons: ["MARGIN_LIMIT"],
    });
    expect(updated.risk.status).toBe("BLOCKED");
    expect(updated.risk.reasons).toEqual(["MARGIN_LIMIT"]);
    expect(updated.paper).toEqual(current.paper);
    expect(updated.history).toEqual(current.history);
  });
});
