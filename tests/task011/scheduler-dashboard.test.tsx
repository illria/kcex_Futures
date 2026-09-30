import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardView } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, DashboardSnapshotSchema } from "../../packages/shared/src/protocol.js";
import { SchedulerStateSchema } from "../../packages/shared/src/scheduler.js";

const NOW = "2026-10-01T00:31:00.000Z";
const auth = AuthStateSchema.parse({
  status: "AUTHENTICATED",
  authProvider: "FAKE",
  credentialsSaved: false,
  liveTrading: false,
  updatedAt: NOW,
});

describe("TASK-011 read-only scheduler dashboard", () => {
  it("renders local UTC plan state and the no-automatic-submission warning without scheduler controls", () => {
    const base = createFakeDashboardSnapshot(true, NOW);
    const scheduler = SchedulerStateSchema.parse({
      ...base.scheduler,
      status: "BLOCKED",
      source: "LOCAL",
      dateKey: "2026-10-01",
      todayTarget: 3,
      completed: 0,
      missed: 1,
      remaining: 2,
      nextTradeAt: "2026-10-01T01:30:00.000Z",
      dueSlot: {
        slotIndex: 1,
        side: "SHORT",
        dueAt: "2026-10-01T00:30:00.000Z",
        windowEndsAt: "2026-10-01T00:45:00.000Z",
        entryEligibility: "BLOCKED",
      },
      blockReasons: ["POSITION_NOT_FLAT"],
      updatedAt: NOW,
    });
    const snapshot = DashboardSnapshotSchema.parse({ ...base, scheduler });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: true,
    }));
    const panel = html.match(/<section class="panel scheduler-panel"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(panel).toContain("Daily Random Scheduler");
    expect(panel).toContain("2026-10-01 · UTC");
    expect(panel).toContain("BLOCKED");
    expect(panel).toContain("SHORT");
    expect(panel).toContain("00:30–00:45 UTC");
    expect(panel).toContain("SCHEDULE ONLY — NO AUTOMATIC ORDER SUBMISSION");
    expect(panel).toContain("LIVE_TRADING=false");
    expect(panel).not.toContain("<button");
  });
});
