import type { Locator, Page } from "playwright";
import { z } from "zod";
import { deriveProtectionPrice } from "../../../../packages/shared/src/protection.js";
import type { KcexLiveSelectorManifest, VerifiedKcexContractProfile } from "../../../../packages/shared/src/live-launch.js";
import { assertTrustedKcexUrl } from "../../../../src/kcex/trusted-host.js";
import type { TrustedPageSource } from "../futures/trusted-page-source.js";
import { requireVerifiedKcexSelector } from "./kcex-live-selectors.js";

export const KcexProtectionInputSchema = z.object({
  executionAttemptId: z.string().uuid(),
  symbol: z.literal("GPS_USDT"),
  side: z.enum(["LONG", "SHORT"]),
  entryPrice: z.number().finite().positive(),
  positionSize: z.number().finite().positive(),
  leverage: z.literal(10),
  takeProfit: z.object({ basis: z.enum(["PRICE_PCT", "ROI_PCT"]), value: z.number().positive() }).strict(),
  stopLoss: z.object({ basis: z.enum(["PRICE_PCT", "ROI_PCT"]), value: z.number().positive() }).strict(),
}).strict();

export const KcexProtectionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ACTIVE"), verifiedAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("UNKNOWN"), reason: z.enum(["PROTECTION_OUTCOME_UNKNOWN", "POSITION_MISMATCH", "TRUSTED_PAGE_LOST"]) }).strict(),
  z.object({ status: z.literal("FAILED_NOT_SUBMITTED"), reason: z.literal("PRECHECK_FAILED") }).strict(),
]);

export interface KcexProtectionAdapterOptions {
  pageSource: TrustedPageSource;
  selectors: KcexLiveSelectorManifest;
  profile: VerifiedKcexContractProfile;
  readPosition(page: Page): Promise<{ symbol: string; side: string; entryPrice: number | null; size: number | null; observedAt: string; fresh: boolean }>;
  persistPlanned(input: z.infer<typeof KcexProtectionInputSchema>, tpTarget: number, slTarget: number): Promise<void>;
  verifyProtection(page: Page, input: z.infer<typeof KcexProtectionInputSchema>, tpTarget: number, slTarget: number): Promise<boolean>;
  now?: () => Date;
}

async function visible(page: Page, selector: string): Promise<Locator | null> {
  const locator = page.locator(selector);
  if (!await locator.count().catch(() => 0)) return null;
  return await locator.isVisible().catch(() => false) ? locator : null;
}

/** Real TP/SL writer. It persists PLANNED before any DOM mutation and never retries an ambiguous submit. */
export class KcexProtectionAdapter {
  private readonly now: () => Date;
  private readonly attempted = new Set<string>();

  constructor(private readonly options: KcexProtectionAdapterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async activate(inputValue: unknown): Promise<z.infer<typeof KcexProtectionResultSchema>> {
    const input = KcexProtectionInputSchema.parse(inputValue);
    if (this.attempted.has(input.executionAttemptId) || this.options.profile.status !== "VERIFIED") {
      return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" };
    }
    const semantics = this.options.profile.takeProfitStopLossSemantics;
    if (semantics === "UNVERIFIED") return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" };
    const tpTarget = protectionInputValue(input.takeProfit, semantics, "TAKE_PROFIT", input.side, input.entryPrice, input.leverage);
    const slTarget = protectionInputValue(input.stopLoss, semantics, "STOP_LOSS", input.side, input.entryPrice, input.leverage);
    let submitAttempted = false;
    try {
      this.attempted.add(input.executionAttemptId);
      await this.options.persistPlanned(input, tpTarget, slTarget);
      return await this.options.pageSource.withTrustedPage(async (page) => {
        assertTrustedKcexUrl(page.url());
        const position = await this.options.readPosition(page);
        const age = this.now().getTime() - Date.parse(position.observedAt);
        if (!position.fresh || !Number.isFinite(age) || age < -1_000 || age > 15_000
          || position.symbol !== input.symbol || position.side !== input.side
          || position.entryPrice !== input.entryPrice || position.size !== input.positionSize) {
          return { status: "UNKNOWN", reason: "POSITION_MISMATCH" } as const;
        }
        const tp = await visible(page, requireVerifiedKcexSelector(this.options.selectors, "takeProfitControl"));
        const sl = await visible(page, requireVerifiedKcexSelector(this.options.selectors, "stopLossControl"));
        const submit = await visible(page, requireVerifiedKcexSelector(this.options.selectors, "protectionSubmit"));
        if (!tp || !sl || !submit) return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" } as const;
        assertTrustedKcexUrl(page.url());
        await tp.fill(formatProtectionInput(tpTarget, semantics, this.options.profile), { timeout: 5_000 });
        assertTrustedKcexUrl(page.url());
        await sl.fill(formatProtectionInput(slTarget, semantics, this.options.profile), { timeout: 5_000 });
        assertTrustedKcexUrl(page.url());
        const stillSamePosition = await this.options.readPosition(page);
        if (!stillSamePosition.fresh || stillSamePosition.symbol !== input.symbol || stillSamePosition.side !== input.side
          || stillSamePosition.entryPrice !== input.entryPrice || stillSamePosition.size !== input.positionSize) {
          return { status: "UNKNOWN", reason: "POSITION_MISMATCH" } as const;
        }
        submitAttempted = true;
        assertTrustedKcexUrl(page.url());
        await submit.click({ timeout: 10_000 });
        assertTrustedKcexUrl(page.url());
        if (!await this.options.verifyProtection(page, input, tpTarget, slTarget)) {
          return { status: "UNKNOWN", reason: "PROTECTION_OUTCOME_UNKNOWN" } as const;
        }
        return { status: "ACTIVE", verifiedAt: this.now().toISOString() } as const;
      });
    } catch {
      return submitAttempted
        ? { status: "UNKNOWN", reason: "PROTECTION_OUTCOME_UNKNOWN" }
        : { status: "UNKNOWN", reason: "TRUSTED_PAGE_LOST" };
    }
  }
}

function formatTarget(value: number, precision: number): string {
  const formatted = value.toFixed(precision);
  if (Number(formatted) <= 0) throw new Error("Protection target precision is invalid.");
  return formatted;
}

function protectionInputValue(
  leg: { basis: "PRICE_PCT" | "ROI_PCT"; value: number },
  semantics: "TARGET_PRICE_INPUT" | "ROI_INPUT_PERCENT" | "UNVERIFIED",
  legType: "TAKE_PROFIT" | "STOP_LOSS",
  side: "LONG" | "SHORT",
  entryPrice: number,
  leverage: number,
): number {
  if (semantics === "TARGET_PRICE_INPUT" && leg.basis === "PRICE_PCT") {
    return deriveProtectionPrice({ side, entryPrice, leverage, legType, ...leg });
  }
  if (semantics === "TARGET_PRICE_INPUT" && leg.basis === "ROI_PCT") {
    return deriveProtectionPrice({ side, entryPrice, leverage, legType, ...leg });
  }
  if (semantics === "ROI_INPUT_PERCENT") {
    const roiPercent = leg.basis === "ROI_PCT" ? leg.value : leg.value * leverage;
    if (!Number.isFinite(roiPercent) || roiPercent < 0.1 || roiPercent > 500) throw new Error("PROTECTION_ROI_OUT_OF_RANGE");
    return roiPercent;
  }
  throw new Error("PROTECTION_SEMANTICS_MISMATCH");
}

function formatProtectionInput(
  value: number,
  semantics: "TARGET_PRICE_INPUT" | "ROI_INPUT_PERCENT" | "UNVERIFIED",
  profile: VerifiedKcexContractProfile,
): string {
  if (semantics === "ROI_INPUT_PERCENT") return String(value);
  const formatted = formatTarget(value, profile.pricePrecision);
  const tickUnits = formatted ? Number(formatted) / profile.tickSize : Number.NaN;
  if (!Number.isFinite(tickUnits) || Math.abs(tickUnits - Math.round(tickUnits)) > 1e-8) {
    throw new Error("PROTECTION_TARGET_NOT_ALIGNED_TO_TICK");
  }
  return formatted;
}
