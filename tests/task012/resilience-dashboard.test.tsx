import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView, RuntimeResiliencePanel, materializeDashboardFuturesForDisplay } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import {
  AuthStateSchema,
  DashboardSnapshotSchema,
  ResilienceStateSchema,
} from "../../packages/shared/src/protocol.js";

const NOW = "2026-10-01T00:00:00.000Z";

function resilienceState(overrides: Record<string, unknown> = {}) {
  return ResilienceStateSchema.parse({
    status: "MANUAL_ACTION",
    reasons: ["AUTH_SESSION_LOST", "SELECTOR_DRIFT_SUSPECTED"],
    authStatus: "SESSION_LOST",
    browserStatus: "STOPPED",
    browserHealth: { browserConnected: true, pageAvailable: true, pageClosed: false, trustedPage: true },
    readStatus: "SESSION_LOST",
    readHealth: "UNKNOWN",
    consecutiveReadFailures: 2,
    lastReadAttemptAt: NOW,
    lastHealthyAt: "2026-09-30T23:59:00.000Z",
    lastRecoveryAt: NOW,
    selectorDrift: { suspected: true, consecutiveEvidenceFailures: 3, missingFields: ["lastPrice"] },
    storageStatus: "READY",
    readStaleAfterMs: 15_000,
    automaticLogin: false,
    automaticTrading: false,
    updatedAt: NOW,
    ...overrides,
  });
}

describe("TASK-012 Runtime Resilience dashboard", () => {
  it("renders manual action warnings, bounded reasons, selector evidence, and stale heartbeat", () => {
    const html = renderToStaticMarkup(React.createElement(RuntimeResiliencePanel, {
      resilience: resilienceState(),
      lastHeartbeatAt: Date.now() - 46_000,
    }));
    expect(html).toContain("SESSION LOST — MANUAL LOGIN REQUIRED");
    expect(html).toContain("SELECTOR DRIFT SUSPECTED — MANUAL DOM REVIEW REQUIRED");
    expect(html).toContain("NO AUTOMATIC LOGIN");
    expect(html).toContain("NO CAPTCHA BYPASS");
    expect(html).toContain("NO AUTOMATIC KCEX ORDER RECOVERY");
    expect(html).toContain("AUTH_SESSION_LOST, SELECTOR_DRIFT_SUSPECTED");
    expect(html).toContain("Missing fields: lastPrice");
    expect(html).toContain("STALE · 46s");
  });

  it("shows the security challenge warning and distinguishes process heartbeat from resilience", () => {
    const html = renderToStaticMarkup(React.createElement(RuntimeResiliencePanel, {
      resilience: resilienceState({
        status: "HALTED",
        reasons: ["MANUAL_CHALLENGE", "BROWSER_DISCONNECTED"],
        authStatus: "MANUAL_CHALLENGE",
        browserStatus: "STOPPED",
      }),
      lastHeartbeatAt: Date.now(),
    }));
    expect(html).toContain("SECURITY CHALLENGE — MANUAL ACTION REQUIRED");
    expect(html).toContain("HALTED");
    expect(html).toContain("Heartbeat");
    expect(html).toContain("FRESH · 0s");
  });

  it("uses the poll-aware stale window while preserving immediate UNKNOWN and STOPPED staleness", () => {
    const base = createFakeDashboardSnapshot(true, NOW);
    const futures = {
      ...base.futures,
      source: "KCEX" as const,
      market: { ...base.futures.market, source: "KCEX" as const },
      account: { ...base.futures.account, source: "KCEX" as const },
      contract: { ...base.futures.contract, source: "KCEX" as const },
      position: { ...base.futures.position, source: "KCEX" as const },
      openOrders: {
        ...base.futures.openOrders,
        source: "KCEX" as const,
        orders: base.futures.openOrders.orders.map((order) => ({ ...order, source: "KCEX" as const })),
      },
    };
    const snapshot = DashboardSnapshotSchema.parse({
      ...base,
      futures,
      market: futures.market,
      account: futures.account,
      contract: futures.contract,
      position: futures.position,
      openOrders: futures.openOrders,
      status: { ...base.status, browser: "READING", readHealth: "READY" },
    });
    const freshWindow = 180_000;
    expect(materializeDashboardFuturesForDisplay(snapshot, "KCEX", Date.parse(NOW) + freshWindow - 1, freshWindow).freshness).toBe("FRESH");
    expect(materializeDashboardFuturesForDisplay(snapshot, "KCEX", Date.parse(NOW) + freshWindow, freshWindow).freshness).toBe("STALE");
    expect(materializeDashboardFuturesForDisplay({
      ...snapshot, status: { ...snapshot.status, browser: "DEGRADED", readHealth: "UNKNOWN" },
    }, "KCEX", Date.parse(NOW) + 1_000, freshWindow).freshness).toBe("STALE");
    expect(materializeDashboardFuturesForDisplay({
      ...snapshot, status: { ...snapshot.status, browser: "STOPPED" },
    }, "KCEX", Date.parse(NOW) + 1_000, freshWindow).freshness).toBe("STALE");
  });

  it("includes a resilience panel in authenticated Dashboard state without adding recovery actions", () => {
    const snapshot = createFakeDashboardSnapshot(true, NOW);
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED", authProvider: "FAKE", credentialsSaved: false,
      liveTrading: false, updatedAt: NOW,
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: true,
      resilience: resilienceState({ status: "IDLE", reasons: [], authStatus: "AUTHENTICATED", selectorDrift: { suspected: false, consecutiveEvidenceFailures: 0, missingFields: [] } }),
      lastHeartbeatAt: null,
    }));
    expect(html).toContain("Runtime Resilience");
    expect(html).toContain("NO AUTOMATIC KCEX ORDER RECOVERY");
  });
});
