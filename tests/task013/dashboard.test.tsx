import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema } from "../../packages/shared/src/protocol.js";
import { EMPTY_KCEX_VERIFICATION_REPORT, createLiveAutomationPlaceholder, createLiveCanaryPlaceholder } from "../../packages/shared/src/live-launch.js";

describe("TASK-013 read-only verification and live gate dashboard", () => {
  it("renders verification status, explicit Canary preview, runtime-only Auto Live, and no false launch claim", () => {
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      authProvider: "FAKE",
      credentialsSaved: false,
      liveTrading: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: createFakeDashboardSnapshot(true, "2026-10-01T00:00:00.000Z"),
      auth,
      webSocketConnected: false,
      liveAutomation: createLiveAutomationPlaceholder("2026-10-01T00:00:00.000Z"),
      liveCanary: createLiveCanaryPlaceholder("2026-10-01T00:00:00.000Z"),
      verificationReport: EMPTY_KCEX_VERIFICATION_REPORT,
    }));
    expect(html).toContain("KCEX Verification Mode");
    expect(html).toContain("READ ONLY");
    expect(html).toContain("Selectors Verified");
    expect(html).toContain("Live Automation");
    expect(html).toContain("Every process restart begins disarmed");
    expect(html).toContain("Live Canary");
    expect(html).toContain("Preview Canary");
    expect(html).toContain("Preview Mark Price");
    expect(html).toContain("MANUAL_VERIFICATION_REQUIRED");
    expect(html).not.toContain("LAUNCH READY");
  });
});
