import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema } from "../../packages/shared/src/protocol.js";
import { DashboardView } from "../../apps/web/src/App";

describe("mock dashboard rendering", () => {
  it("renders GPS_USDT fixture values and display-only dashboard sections", () => {
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      credentialsSaved: false,
      liveTrading: false,
      fakeAuth: true,
      updatedAt: new Date(0).toISOString(),
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot: createFakeDashboardSnapshot(true, new Date(0).toISOString()),
      auth,
      webSocketConnected: true,
    }));

    for (const expected of [
      "GPS_USDT",
      "Last Price",
      "Mark Price",
      "Available USDT",
      "Margin Mode",
      "Leverage",
      "Current Position",
      "Unrealized PnL",
      "Today Target",
      "Completed",
      "Runtime Logs",
      "LIVE_TRADING",
      "FIXTURE",
    ]) {
      expect(html).toContain(expected);
    }
    expect(html).not.toContain("Long");
    expect(html).not.toContain("Short");
  });
});
