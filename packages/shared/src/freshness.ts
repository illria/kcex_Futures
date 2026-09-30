import type { Freshness, KcexFuturesSnapshot } from "./protocol.js";

export const KCEX_READ_STALE_MS = 15_000;

export interface SnapshotFreshnessOptions {
  forceStale?: boolean;
  staleAfterMs?: number;
}

function toTimestamp(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

function calculateFreshness(
  updatedAt: string,
  now: Date | number | string,
  forceStale: boolean,
  staleAfterMs: number,
): Freshness {
  const updatedAtMs = Date.parse(updatedAt);
  const nowMs = toTimestamp(now);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return "UNKNOWN";
  if (forceStale) return "STALE";
  return nowMs - updatedAtMs < staleAfterMs ? "FRESH" : "STALE";
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
  const requestedStaleAfterMs = options.staleAfterMs ?? KCEX_READ_STALE_MS;
  const staleAfterMs = Number.isFinite(requestedStaleAfterMs)
    ? Math.max(KCEX_READ_STALE_MS, Math.min(180_000, Math.trunc(requestedStaleAfterMs)))
    : KCEX_READ_STALE_MS;
  const freshness = calculateFreshness(snapshot.updatedAt, now, options.forceStale === true, staleAfterMs);
  return {
    ...snapshot,
    freshness,
    market: { ...snapshot.market, freshness },
    position: { ...snapshot.position, freshness },
  };
}
