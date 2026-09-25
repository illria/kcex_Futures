/** @vitest-environment happy-dom */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView, applyPaperStateToDashboard } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, DashboardSnapshotSchema } from "../../packages/shared/src/protocol.js";
import { PaperTradingStateSchema } from "../../packages/shared/src/paper-trading.js";

const auth = AuthStateSchema.parse({
  status: "AUTHENTICATED",
  credentialsSaved: false,
  liveTrading: false,
  authProvider: "FAKE",
  updatedAt: "2026-09-26T12:00:00.000Z",
});

describe("Dashboard Paper Simulation panel", () => {
  it("shows the explicit empty paper state separately from the KCEX position section", () => {
    const snapshot = createFakeDashboardSnapshot(true, "2026-09-26T12:00:00.000Z");
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: false,
    }));

    expect(html).toContain("PAPER SIMULATION · NO KCEX ORDER");
    expect(html).toContain("No open paper position.");
    expect(html).toContain("KCEX Read-Only Position");
  });

  it("renders an OPEN LONG paper position without changing KCEX financial fields", () => {
    const original = createFakeDashboardSnapshot(true, "2026-09-26T12:00:00.000Z");
    const paper = PaperTradingStateSchema.parse({
      status: "OPEN",
      activeTradeId: "60000000-0000-4000-8000-000000000001",
      position: {
        tradeId: "60000000-0000-4000-8000-000000000001",
        symbol: "GPS_USDT",
        side: "LONG",
        marginUsdt: 50,
        leverage: 10,
        quantity: 50_000,
        entryPrice: 0.01,
        markPrice: 0.011,
        unrealizedPnl: 50,
        openedAt: "2026-09-26T12:00:00.000Z",
      },
      updatedAt: "2026-09-26T12:00:01.000Z",
    });
    const snapshot = applyPaperStateToDashboard(original, paper);
    expect(snapshot.position).toEqual(original.position);
    expect(snapshot.futures.position).toEqual(original.futures.position);
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: true,
    }));

    for (const value of ["PAPER SIMULATION · NO KCEX ORDER", "LONG", "50.00 USDT", "10.00x", "0.01000", "0.01100", "50000.000", "KCEX Read-Only Position"]) {
      expect(html).toContain(value);
    }
  });

  it("validates and atomically applies the runtime paper state to the dashboard model", () => {
    const current = createFakeDashboardSnapshot(true, "2026-09-26T12:00:00.000Z");
    const paper = PaperTradingStateSchema.parse({
      status: "PLANNED",
      activeTradeId: "60000000-0000-4000-8000-000000000002",
      position: null,
      updatedAt: "2026-09-26T12:00:01.000Z",
    });

    const updated = applyPaperStateToDashboard(current, paper);
    expect(DashboardSnapshotSchema.parse(updated).paper).toEqual(paper);
    expect(updated.futures.source).toBe("MOCK");
  });
});
