import { z } from "zod";
import type { KcexFuturesSnapshot } from "../../../../packages/shared/src/protocol.js";
import type { VerifiedKcexContractProfile } from "../../../../packages/shared/src/live-launch.js";

export const KcexLivePositionEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("MATCHED_OPEN"), source: z.literal("KCEX"), symbol: z.literal("GPS_USDT"), side: z.enum(["LONG", "SHORT"]), entryPrice: z.number().positive(), size: z.number().positive(), observedAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("NO_POSITION"), source: z.literal("KCEX"), observedAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("MISMATCH"), source: z.literal("KCEX"), reason: z.enum(["SYMBOL_MISMATCH", "SIDE_MISMATCH", "SIZE_MISMATCH", "INVALID_POSITION"]), observedAt: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("UNKNOWN"), source: z.literal("KCEX"), reason: z.enum(["SOURCE_UNAVAILABLE", "STALE_EVIDENCE", "INVALID_EVIDENCE"]), observedAt: z.string().datetime() }).strict(),
]);
export type KcexLivePositionEvidence = z.infer<typeof KcexLivePositionEvidenceSchema>;

export interface KcexPositionConfirmationSourceOptions {
  readFreshSnapshot(): Promise<KcexFuturesSnapshot | null>;
  profile: VerifiedKcexContractProfile;
  now?: () => Date;
  maxAgeMs?: number;
}

/** Confirms entries only from a new read-only KCEX snapshot, never from a button result. */
export class KcexPositionConfirmationSource {
  private readonly now: () => Date;
  private readonly maxAgeMs: number;

  constructor(private readonly options: KcexPositionConfirmationSourceOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxAgeMs = options.maxAgeMs ?? 15_000;
    if (!Number.isSafeInteger(this.maxAgeMs) || this.maxAgeMs < 1_000 || this.maxAgeMs > 15_000) throw new RangeError("Position evidence age is outside the supported bound.");
  }

  async readEvidence(expected: { side: "LONG" | "SHORT"; quantity: number }): Promise<KcexLivePositionEvidence> {
    const observedAt = this.clockNow().toISOString();
    if (this.options.profile.status !== "VERIFIED") return { kind: "UNKNOWN", source: "KCEX", reason: "INVALID_EVIDENCE", observedAt };
    let snapshot: KcexFuturesSnapshot | null;
    try {
      snapshot = await this.options.readFreshSnapshot();
    } catch {
      return { kind: "UNKNOWN", source: "KCEX", reason: "SOURCE_UNAVAILABLE", observedAt };
    }
    if (!snapshot || snapshot.source !== "KCEX" || snapshot.symbol !== "GPS_USDT" || snapshot.position.source !== "KCEX") {
      return { kind: "UNKNOWN", source: "KCEX", reason: "SOURCE_UNAVAILABLE", observedAt };
    }
    const timestamp = Date.parse(snapshot.updatedAt);
    const nowMs = this.clockNow().getTime();
    if (!Number.isFinite(timestamp) || timestamp > nowMs + 1_000 || nowMs - timestamp > this.maxAgeMs || snapshot.freshness !== "FRESH") {
      return { kind: "UNKNOWN", source: "KCEX", reason: "STALE_EVIDENCE", observedAt };
    }
    const position = snapshot.position;
    if (position.health !== "READY" || position.freshness !== "FRESH") {
      return { kind: "UNKNOWN", source: "KCEX", reason: "INVALID_EVIDENCE", observedAt: snapshot.updatedAt };
    }
    if (position.side === "NONE" && position.size === null) return { kind: "NO_POSITION", source: "KCEX", observedAt: snapshot.updatedAt };
    if (position.symbol !== "GPS_USDT") return { kind: "MISMATCH", source: "KCEX", reason: "SYMBOL_MISMATCH", observedAt: snapshot.updatedAt };
    if (position.side === "UNKNOWN" || position.entryPrice === null || position.entryPrice <= 0 || position.size === null || position.size <= 0) {
      return { kind: "MISMATCH", source: "KCEX", reason: "INVALID_POSITION", observedAt: snapshot.updatedAt };
    }
    if (position.side !== expected.side) return { kind: "MISMATCH", source: "KCEX", reason: "SIDE_MISMATCH", observedAt: snapshot.updatedAt };
    const deviationBps = Math.ceil(Math.abs(position.size - expected.quantity) / expected.quantity * 10_000);
    if (deviationBps > this.options.profile.maximumNotionalDeviationBps) {
      return { kind: "MISMATCH", source: "KCEX", reason: "SIZE_MISMATCH", observedAt: snapshot.updatedAt };
    }
    return {
      kind: "MATCHED_OPEN",
      source: "KCEX",
      symbol: "GPS_USDT",
      side: position.side,
      entryPrice: position.entryPrice,
      size: position.size,
      observedAt: snapshot.updatedAt,
    };
  }

  private clockNow(): Date {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Position confirmation clock is invalid.");
    return date;
  }
}
