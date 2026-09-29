import { describe, expect, it } from "vitest";
import { FixtureExecutionAdapter } from "../../apps/server/src/execution/fixture-execution-adapter.js";
import type { AssistedLivePreview } from "../../packages/shared/src/execution.js";

const preview: AssistedLivePreview = {
  previewId: "10000000-0000-4000-8000-000000000001",
  symbol: "GPS_USDT",
  side: "LONG",
  orderType: "MARKET",
  marginMode: "ISOLATED",
  marginUsdt: 50,
  leverage: 10,
  provider: "FIXTURE",
  referencePrice: 0.0123,
  createdAt: "2026-09-29T12:00:00.000Z",
  expiresAt: "2026-09-29T12:01:00.000Z",
};

describe("fixture-only execution adapter", () => {
  it("accepts exactly one fixture submission and returns SUBMITTED, not a fill", async () => {
    const adapter = new FixtureExecutionAdapter({
      now: () => new Date("2026-09-29T12:00:01.000Z"),
      idGenerator: () => "20000000-0000-4000-8000-000000000001",
    });
    await expect(adapter.submit(preview)).resolves.toEqual({
      status: "SUBMITTED",
      fixtureSubmissionId: "20000000-0000-4000-8000-000000000001",
      submittedAt: "2026-09-29T12:00:01.000Z",
    });
    expect(adapter.submitCalls).toBe(1);
  });

  it("can return a configured fixture failure without retry", async () => {
    const adapter = new FixtureExecutionAdapter({
      now: () => new Date("2026-09-29T12:00:02.000Z"),
      failureKind: "EXECUTION_FAILED",
    });
    await expect(adapter.submit(preview)).resolves.toMatchObject({ status: "FAILED", failureKind: "EXECUTION_FAILED" });
    expect(adapter.submitCalls).toBe(1);
  });
});
