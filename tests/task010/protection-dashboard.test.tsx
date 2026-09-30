import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema } from "../../packages/shared/src/protocol.js";
import { ProtectionPlanSchema, ProtectionRuntimeStateSchema } from "../../packages/shared/src/protection.js";

const NOW = "2026-09-30T12:00:00.000Z";
const auth = AuthStateSchema.parse({
  status: "AUTHENTICATED", authProvider: "FAKE", credentialsSaved: false, liveTrading: false, updatedAt: NOW,
});

describe("TASK-010 Position Protection Dashboard", () => {
  it("shows explicit basis labels, an empty basis choice, and the fixture-only warning", () => {
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: createFakeDashboardSnapshot(true, NOW),
      auth,
      webSocketConnected: false,
    }));
    expect(html).toContain("Position Protection");
    expect(html).toContain("Price move %");
    expect(html).toContain("Simulated leveraged ROI %");
    expect(html).toContain("FIXTURE PROTECTION ONLY");
    expect(html).toContain("NO KCEX TP/SL ORDER EXISTS");
    expect(html).toContain("value=\"\" selected");
  });

  it("shows immutable derived targets and the active fixture warning", () => {
    const plan = ProtectionPlanSchema.parse({
      id: "a3200000-0000-4000-8000-000000000001",
      executionAttemptId: "a3200000-0000-4000-8000-000000000002",
      provider: "FIXTURE",
      symbol: "GPS_USDT",
      side: "LONG",
      entryPrice: 100,
      positionSize: 2.5,
      leverage: 10,
      takeProfit: { basis: "PRICE_PCT", value: 5, targetPrice: 105 },
      stopLoss: { basis: "ROI_PCT", value: 30, targetPrice: 97 },
      status: "ACTIVE",
      triggeredLeg: null,
      fixtureProtectionId: "a3200000-0000-4000-8000-000000000003",
      createdAt: NOW,
      activatedAt: NOW,
      triggeredAt: null,
      updatedAt: NOW,
      version: 2,
    });
    const protection = ProtectionRuntimeStateSchema.parse({
      status: "ACTIVE",
      provider: "FIXTURE",
      activePreview: null,
      activePlan: plan,
      lastPlan: plan,
      reasons: [],
      updatedAt: NOW,
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: createFakeDashboardSnapshot(true, NOW),
      auth,
      webSocketConnected: true,
      protection,
    }));
    expect(html).toContain("FIXTURE PROTECTION ACTIVE");
    expect(html).toContain("NO KCEX TP/SL ORDER CREATED");
    expect(html).toContain("TP Target Price");
    expect(html).toContain("105");
    expect(html).toContain("SL Target Price");
    expect(html).toContain("97");
  });

  it("renders the duplicate-protection warning when outcome is UNKNOWN", () => {
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: createFakeDashboardSnapshot(true, NOW),
      auth,
      webSocketConnected: true,
      protection: ProtectionRuntimeStateSchema.parse({
        status: "UNKNOWN", provider: "FIXTURE", activePreview: null, activePlan: null, lastPlan: null,
        reasons: ["PROTECTION_ACTIVATION_UNKNOWN"], updatedAt: NOW,
      }),
    }));
    expect(html).toContain("PROTECTION OUTCOME UNKNOWN");
    expect(html).toContain("DO NOT CREATE DUPLICATE PROTECTION");
    expect(html).not.toContain("Confirm fixture protection");
  });
});
