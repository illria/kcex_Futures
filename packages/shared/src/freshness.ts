import type { Freshness, KcexFuturesSnapshot } from "./protocol.js";

export const KCEX_READ_STALE_MS = 15_000;

export interface SnapshotFreshnessOptions {
  forceStale?: boolean;
}

function toTimestamp(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function calculateFreshness(updatedAt: string, now: Date | number | string, forceStale: boolean): Freshness {
  const updatedAtMs = Date.parse(updatedAt);
  const nowMs = toTimestamp(now);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return "UNKNOWN";
  if (forceStale) return "STALE";
  return nowMs - updatedAtMs < KCEX_READ_STALE_MS ? "FRESH" : "STALE";
}

/**
 * Materialize freshness from the immutable read timestamp. This returns a
 * clone so callers cannot accidentally rewrite the timestamp or cached data.
 */
export function applySnapshotFreshness(
  snapshot: KcexFuturesSnapshot,
  now: Date | number | string = new Date(),
  options: SnapshotFreshnessOptions = {},
): KcexFuturesSnapshot {
  const freshness = calculateFreshness(snapshot.updatedAt, now, options.forceStale === true);
  return {
    ...snapshot,
    freshness,
    market: { ...snapshot.market, freshness },
    position: { ...snapshot.position, freshness },
  };
}
