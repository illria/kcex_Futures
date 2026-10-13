import { describe, expect, it } from "vitest";
import { KcexPositionConfirmationSource } from "../../apps/server/src/kcex-live/kcex-position-confirmation-source.js";
import { createFakeFuturesSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { KcexFuturesSnapshotSchema } from "../../packages/shared/src/protocol.js";
import { verifiedProfile } from "./helpers.js";

const NOW = "2026-10-01T00:00:00.000Z";

function kcexPositionSnapshot(input: {
  updatedAt?: string;
  side?: "LONG" | "SHORT" | "NONE" | "UNKNOWN";
  size?: number | null;
} = {}) {
  const updatedAt = input.updatedAt ?? NOW;
  const fixture = createFakeFuturesSnapshot(updatedAt);
  return KcexFuturesSnapshotSchema.parse({
    ...fixture,
    source: "KCEX",
    health: "READY",
    status: "READY",
    freshness: "FRESH",
    updatedAt,
    market: { ...fixture.market, source: "KCEX", updatedAt, freshness: "FRESH" },
    account: { ...fixture.account, source: "KCEX", updatedAt },
    contract: { ...fixture.contract, source: "KCEX", updatedAt },
    position: {
      ...fixture.position,
      side: input.side ?? "LONG",
      entryPrice: (input.side ?? "LONG") === "NONE" ? null : 2,
      size: input.size === undefined ? 250 : input.size,
      source: "KCEX",
      health: "READY",
      freshness: "FRESH",
      updatedAt,
    },
    openOrders: { ...fixture.openOrders, source: "KCEX", updatedAt, orders: [] },
  });
}

describe("TASK-013 read-only position confirmation", () => {
  it("confirms only fresh KCEX position evidence matching symbol, side, and verified quantity tolerance", async () => {
    const source = new KcexPositionConfirmationSource({
      readFreshSnapshot: async () => kcexPositionSnapshot(),
      profile: verifiedProfile(),
      now: () => new Date(NOW),
    });
    await expect(source.readEvidence({ side: "LONG", quantity: 250 })).resolves.toMatchObject({
      kind: "MATCHED_OPEN",
      source: "KCEX",
      symbol: "GPS_USDT",
      side: "LONG",
      entryPrice: 2,
      size: 250,
      observedAt: NOW,
    });
  });

  it.each([
    ["stale", kcexPositionSnapshot({ updatedAt: "2026-09-30T23:59:44.999Z" }), "STALE_EVIDENCE"],
    ["wrong side", kcexPositionSnapshot({ side: "SHORT" }), "SIDE_MISMATCH"],
    ["unexpected size", kcexPositionSnapshot({ size: 300 }), "SIZE_MISMATCH"],
  ] as const)("returns UNKNOWN or MISMATCH for %s evidence", async (_name, snapshot, expectedReason) => {
    const source = new KcexPositionConfirmationSource({
      readFreshSnapshot: async () => snapshot,
      profile: verifiedProfile(),
      now: () => new Date(NOW),
    });
    await expect(source.readEvidence({ side: "LONG", quantity: 250 })).resolves.toMatchObject({
      kind: expectedReason === "STALE_EVIDENCE" ? "UNKNOWN" : "MISMATCH",
      reason: expectedReason,
    });
  });

  it("never converts fixture or absent page evidence into a confirmed live position", async () => {
    const fixture = createFakeFuturesSnapshot(NOW);
    const source = new KcexPositionConfirmationSource({
      readFreshSnapshot: async () => fixture,
      profile: verifiedProfile(),
      now: () => new Date(NOW),
    });
    await expect(source.readEvidence({ side: "LONG", quantity: 250 })).resolves.toMatchObject({
      kind: "UNKNOWN",
      reason: "SOURCE_UNAVAILABLE",
    });
  });
});
