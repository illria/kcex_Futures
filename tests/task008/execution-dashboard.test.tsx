import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { applyExecutionStateToDashboard, DashboardView } from "../../apps/web/src/App.js";
import { createFakeDashboardSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, DashboardSnapshotSchema } from "../../packages/shared/src/protocol.js";
import { AssistedExecutionStateSchema } from "../../packages/shared/src/execution.js";

const NOW = "2026-09-29T12:00:00.000Z";

describe("TASK-008 Assisted Execution Dashboard", () => {
  it("shows the disabled KCEX warning and explicit two-step fixture controls", () => {
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      authProvider: "FAKE",
      credentialsSaved: false,
      liveTrading: false,
      updatedAt: NOW,
    });
    const snapshot = DashboardSnapshotSchema.parse({
      ...createFakeDashboardSnapshot(true, NOW),
      execution: AssistedExecutionStateSchema.parse({
        status: "DISARMED",
        provider: "FIXTURE",
        armedUntil: null,
        activePreview: null,
        lastSubmission: null,
        reasons: [],
        updatedAt: NOW,
      }),
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: false,
    }));
    expect(html).toContain("REAL KCEX EXECUTION DISABLED");
    expect(html).toContain("FIXTURE SUBMISSION ONLY · NO KCEX ORDER");
    expect(html).toContain("Assisted Execution");
    expect(html).toContain("Arm for five minutes");
    expect(html).toContain("Create Preview");
    expect(html).toContain("Confirm Single Submission");
    expect(html).toContain("Disarm");
    expect(html).not.toContain("Order filled");
    expect(html).not.toContain("Position open");
  });

  it("applies authoritative execution.state without changing futures or risk data", () => {
    const current = createFakeDashboardSnapshot(true, NOW);
    const nextExecution = AssistedExecutionStateSchema.parse({
      ...current.execution,
      status: "ARMED",
      armedUntil: "2026-09-29T12:05:00.000Z",
      updatedAt: NOW,
    });
    const updated = applyExecutionStateToDashboard(current, nextExecution);
    expect(updated.execution).toEqual(nextExecution);
    expect(updated.futures).toEqual(current.futures);
    expect(updated.risk).toEqual(current.risk);
  });

  it("labels fixture SUBMITTED as awaiting TASK-009 confirmation", () => {
    const auth = AuthStateSchema.parse({
      status: "AUTHENTICATED",
      authProvider: "FAKE",
      credentialsSaved: false,
      liveTrading: false,
      updatedAt: NOW,
    });
    const current = createFakeDashboardSnapshot(true, NOW);
    const snapshot = DashboardSnapshotSchema.parse({
      ...current,
      execution: AssistedExecutionStateSchema.parse({
        status: "SUBMITTED",
        provider: "FIXTURE",
        armedUntil: null,
        activePreview: null,
        lastSubmission: {
          previewId: "50000000-0000-4000-8000-000000000001",
          provider: "FIXTURE",
          symbol: "GPS_USDT",
          side: "LONG",
          status: "SUBMITTED",
          fixtureSubmissionId: "50000000-0000-4000-8000-000000000002",
          submittedAt: NOW,
        },
        reasons: [],
        updatedAt: NOW,
      }),
    });
    const html = renderToStaticMarkup(React.createElement(DashboardView, {
      snapshot,
      auth,
      webSocketConnected: true,
    }));
    expect(html).toContain("SUBMITTED — AWAITING CONFIRMATION IN TASK-009");
    expect(html).not.toContain("Order filled");
    expect(html).not.toContain("Position open");
  });
});
