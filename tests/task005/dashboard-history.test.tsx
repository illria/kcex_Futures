/** @vitest-environment happy-dom */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema } from "../../packages/shared/src/protocol.js";
import { TradeHistoryEntrySchema } from "../../packages/shared/src/storage.js";
import { DashboardView } from "../../apps/web/src/App.js";

describe("Dashboard persisted trade history", () => {
  const auth = AuthStateSchema.parse({
    status: "AUTHENTICATED",
    credentialsSaved: false,
    liveTrading: false,
    authProvider: "FAKE",
    updatedAt: "2026-09-25T12:00:00.000Z",
  });

  it("shows an explicit empty state without inventing history", () => {
    const snapshot = createFakeDashboardSnapshot(true, "2026-09-25T12:00:00.000Z");
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: false,
    }));
    expect(snapshot.history).toEqual([]);
    expect(html).toContain("No trade history.");
  });

  it("renders persisted history fields as read-only rows", () => {
    const snapshot = createFakeDashboardSnapshot(true, "2026-09-25T12:00:00.000Z");
    snapshot.status.storage = "READY";
    snapshot.history = [
      TradeHistoryEntrySchema.parse({
        id: "30000000-0000-4000-8000-000000000001",
        symbol: "GPS_USDT",
        mode: "PAPER",
        side: "LONG",
        status: "CLOSED",
        entryPrice: 0.01234,
        exitPrice: 0.013,
        realizedPnl: 3.25,
        fees: 0.05,
        createdAt: "2026-09-25T11:00:00.000Z",
      }),
      TradeHistoryEntrySchema.parse({
        id: "30000000-0000-4000-8000-000000000002",
        symbol: "GPS_USDT",
        mode: "LIVE",
        side: "SHORT",
        status: "OPEN",
        entryPrice: 0.014,
        exitPrice: null,
        realizedPnl: null,
        fees: null,
        createdAt: "2026-09-25T11:30:00.000Z",
      }),
    ];

    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: true,
    }));

    for (const label of ["Time", "Mode", "Side", "Status", "Entry", "Exit", "PnL", "Fees", "LIVE", "CLOSED", "3.25 USDT"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Storage READY");
    expect(html).not.toContain("No trade history.");
  });
});
