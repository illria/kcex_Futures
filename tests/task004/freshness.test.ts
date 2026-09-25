import { describe, expect, it } from "vitest";
import { applySnapshotFreshness, KCEX_READ_STALE_MS } from "../../packages/shared/src/freshness.js";
import { assertFuturesSourceConsistency } from "../../packages/shared/src/futures-invariants.js";
import { createFakeFuturesSnapshot } from "../../packages/shared/src/fake-snapshot.js";

describe("read-only snapshot freshness and source invariants", () => {
  const updatedAt = "2026-01-01T00:00:00.000Z";
  const snapshot = createFakeFuturesSnapshot(updatedAt);

  it("keeps data fresh below the threshold and marks the boundary stale", () => {
    expect(applySnapshotFreshness(snapshot, new Date(updatedAt).getTime() + 5_000).freshness).toBe("FRESH");
    expect(applySnapshotFreshness(snapshot, new Date(updatedAt).getTime() + 14_900).freshness).toBe("FRESH");
    expect(applySnapshotFreshness(snapshot, new Date(updatedAt).getTime() + KCEX_READ_STALE_MS - 1).freshness).toBe("FRESH");
    expect(applySnapshotFreshness(snapshot, new Date(updatedAt).getTime() + KCEX_READ_STALE_MS).freshness).toBe("STALE");
    expect(applySnapshotFreshness(snapshot, new Date(updatedAt).getTime() + KCEX_READ_STALE_MS + 1).freshness).toBe("STALE");
  });

  it("returns UNKNOWN for invalid timestamps and synchronizes child freshness", () => {
    const result = applySnapshotFreshness({ ...snapshot, updatedAt: "not-a-timestamp" }, new Date(updatedAt));
    expect(result.freshness).toBe("UNKNOWN");
    expect(result.market.freshness).toBe("UNKNOWN");
    expect(result.position.freshness).toBe("UNKNOWN");
    expect(result.updatedAt).toBe("not-a-timestamp");
  });

  it("can force cached data stale after the reader stops", () => {
    const result = applySnapshotFreshness(snapshot, new Date(updatedAt), { forceStale: true });
    expect(result.freshness).toBe("STALE");
    expect(result.market.freshness).toBe("STALE");
    expect(result.position.freshness).toBe("STALE");
  });

  it("rejects mixed MOCK and KCEX child sources", () => {
    expect(() => assertFuturesSourceConsistency({
      ...snapshot,
      account: { ...snapshot.account, source: "KCEX" },
    })).toThrow("mixed data sources");
  });
});
