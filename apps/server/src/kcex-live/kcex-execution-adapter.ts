import type { Locator, Page } from "playwright";
import { z } from "zod";
import { assertTrustedKcexUrl } from "../../../../src/kcex/trusted-host.js";
import { parseStrictNumeric } from "../../../../src/kcex/number-parser.js";
import type { KcexLiveSelectorManifest, VerifiedKcexContractProfile } from "../../../../packages/shared/src/live-launch.js";
import type { TrustedPageSource } from "../futures/trusted-page-source.js";
import { deriveKcexQuantity } from "./quantity.js";
import { hasVerifiedKcexMutationSelectors, requireVerifiedKcexSelector } from "./kcex-live-selectors.js";

export const KcexLiveEntryInputSchema = z.object({
  attemptId: z.string().uuid(),
  side: z.enum(["LONG", "SHORT"]),
  dueAt: z.string().datetime(),
  marginUsdt: z.number().finite().positive().max(50),
  expectedQuantity: z.number().finite().positive().optional(),
}).strict();

export const KcexLiveEntryResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("SUBMITTED"), submittedAt: z.string().datetime(), quantity: z.number().positive(), notionalUsdt: z.number().positive() }).strict(),
  z.object({ status: z.literal("FAILED_NOT_SUBMITTED"), reason: z.enum(["PRECHECK_FAILED", "ORDER_REJECTED", "INVALID_CONTRACT_PROFILE", "CONTROL_MISSING"]) }).strict(),
  z.object({ status: z.literal("UNKNOWN"), reason: z.enum(["SUBMIT_OUTCOME_UNKNOWN", "TRUSTED_PAGE_LOST", "PAGE_EVIDENCE_UNKNOWN"]) }).strict(),
]);
export type KcexLiveEntryResult = z.infer<typeof KcexLiveEntryResultSchema>;

interface KcexPageEvidence {
  symbol: string | null;
  availableUsdt: number | null;
  markPrice: number | null;
  marginMode: string | null;
  leverage: number | null;
  position: "FLAT" | "OPEN" | "UNKNOWN";
  openOrders: "EMPTY" | "OPEN" | "UNKNOWN";
  marketOrderSelected: boolean;
  selectedSide: "LONG" | "SHORT" | null;
  summaryMatches: boolean;
  orderRejected: boolean;
  explicitlyNotSubmitted: boolean;
}

export interface KcexExecutionAdapterOptions {
  pageSource: TrustedPageSource;
  selectors: KcexLiveSelectorManifest;
  contractProfile: VerifiedKcexContractProfile;
  isRuntimeAuthorized(): boolean;
  getBlockReasons(): readonly string[];
  refreshPreflight?(): Promise<void>;
  now?: () => Date;
}

async function visibleLocator(page: Page, selector: string): Promise<Locator | null> {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function readText(page: Page, selector: string): Promise<string | null> {
  const locator = await visibleLocator(page, selector);
  if (!locator) return null;
  return (await locator.innerText().catch(() => "")).trim() || (await locator.inputValue().catch(() => "")).trim() || null;
}

async function selected(locator: Locator | null): Promise<boolean> {
  if (!locator) return false;
  const pressed = await locator.getAttribute("aria-pressed").catch(() => null);
  const selectedValue = await locator.getAttribute("aria-selected").catch(() => null);
  const checked = await locator.getAttribute("aria-checked").catch(() => null);
  const active = await locator.getAttribute("data-state").catch(() => null);
  return pressed === "true" || selectedValue === "true" || checked === "true" || active === "active";
}

/**
 * The only production KCEX entry writer. It accepts only scheduler side and
 * slot identity; all selectors and contract semantics come from the local
 * verification report. A submit attempt is never retried.
 */
export class KcexExecutionAdapter {
  private readonly now: () => Date;
  private readonly submittedSlots = new Set<string>();

  constructor(private readonly options: KcexExecutionAdapterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async submit(inputValue: unknown): Promise<KcexLiveEntryResult> {
    const input = KcexLiveEntryInputSchema.parse(inputValue);
    if (this.submittedSlots.has(input.attemptId)) return { status: "UNKNOWN", reason: "SUBMIT_OUTCOME_UNKNOWN" };
    if (this.options.contractProfile.status !== "VERIFIED" || !hasVerifiedKcexMutationSelectors(this.options.selectors)) {
      return { status: "FAILED_NOT_SUBMITTED", reason: "INVALID_CONTRACT_PROFILE" };
    }
    if (!this.assertAutomationReady()) return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" };

    let submitAttempted = false;
    try {
      return await this.options.pageSource.withTrustedPage(async (page) => {
        assertTrustedKcexUrl(page.url());
        const current = await this.readEvidence(page, input.side, "0");
        if (current.symbol !== "GPS_USDT" || current.position !== "FLAT" || current.openOrders !== "EMPTY"
          || current.availableUsdt === null || current.availableUsdt < input.marginUsdt || current.markPrice === null
          || !["ISOLATED", "CROSS"].includes(current.marginMode?.toUpperCase() ?? "") || current.leverage === null) {
          return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" } as const;
        }

        const derived = deriveKcexQuantity({
          profile: this.options.contractProfile,
          markPrice: current.markPrice,
          marginUsdt: input.marginUsdt,
          leverage: 10,
        });
        if (input.expectedQuantity !== undefined && derived.quantity !== input.expectedQuantity) {
          return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" } as const;
        }
        const margin = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "marginInput"));
        const quantity = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "quantityInput"));
        const isolated = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "isolatedControl"));
        const leverage = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "leverageControl"));
        const market = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "marketOrderTab"));
        const submit = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "orderSubmit"));
        if (!margin || !quantity || !isolated || !leverage || !market || !submit) {
          return { status: "FAILED_NOT_SUBMITTED", reason: "CONTROL_MISSING" } as const;
        }

        if (current.marginMode?.toUpperCase() !== "ISOLATED") {
          assertTrustedKcexUrl(page.url());
          if (this.options.contractProfile.marginModeSemantics === "DIRECT_INPUT") {
            const tagName = await isolated.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
            if (tagName === "select") {
              const isolatedLabel = await isolated.evaluate((element) => {
                const select = element as HTMLSelectElement;
                const matches = Array.from(select.options).filter((option) => option.label.trim().toUpperCase() === "ISOLATED");
                return matches.length === 1 ? matches[0].label : null;
              }).catch(() => null);
              if (!isolatedLabel) return { status: "FAILED_NOT_SUBMITTED", reason: "CONTROL_MISSING" } as const;
              await isolated.selectOption({ label: isolatedLabel }, { timeout: 5_000 });
            } else {
              await isolated.fill("ISOLATED", { timeout: 5_000 });
            }
          } else {
            await isolated.click({ timeout: 5_000 });
          }
          assertTrustedKcexUrl(page.url());
        }

        if (current.leverage !== 10) {
          assertTrustedKcexUrl(page.url());
          if (this.options.contractProfile.leverageSemantics === "DIRECT_INPUT") {
            await leverage.fill("10", { timeout: 5_000 });
          } else if (this.options.contractProfile.leverageSemantics === "MENU_OPTION") {
            await leverage.click({ timeout: 5_000 });
          } else {
            await leverage.click({ timeout: 5_000 });
            assertTrustedKcexUrl(page.url());
            const dialogInput = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "leverageDialogInput"));
            const dialogSubmit = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, "leverageDialogSubmit"));
            if (!dialogInput || !dialogSubmit) return { status: "FAILED_NOT_SUBMITTED", reason: "CONTROL_MISSING" } as const;
            await dialogInput.fill("10", { timeout: 5_000 });
            assertTrustedKcexUrl(page.url());
            await dialogSubmit.click({ timeout: 5_000 });
          }
          assertTrustedKcexUrl(page.url());
        }
        if (!current.marketOrderSelected && (this.options.contractProfile.marketOrderSemantics === "TAB_CONTROL"
          || this.options.contractProfile.marketOrderSemantics === "ORDER_TYPE_SELECTOR")) {
          assertTrustedKcexUrl(page.url());
          await market.click({ timeout: 5_000 });
          assertTrustedKcexUrl(page.url());
        }
        assertTrustedKcexUrl(page.url());
        await margin.fill(String(input.marginUsdt), { timeout: 5_000 });
        assertTrustedKcexUrl(page.url());
        await quantity.fill(derived.inputValue, { timeout: 5_000 });

        assertTrustedKcexUrl(page.url());
        const sideKey = input.side === "LONG" ? "longControl" : "shortControl";
        const sideControl = await visibleLocator(page, requireVerifiedKcexSelector(this.options.selectors, sideKey));
        if (!sideControl) return { status: "FAILED_NOT_SUBMITTED", reason: "CONTROL_MISSING" } as const;
        if (current.selectedSide !== input.side) {
          assertTrustedKcexUrl(page.url());
          await sideControl.click({ timeout: 5_000 });
          assertTrustedKcexUrl(page.url());
        }

        const finalEvidence = await this.readEvidence(page, input.side, derived.inputValue);
        if (
          finalEvidence.symbol !== "GPS_USDT"
          || finalEvidence.position !== "FLAT"
          || finalEvidence.openOrders !== "EMPTY"
          || finalEvidence.availableUsdt === null || finalEvidence.availableUsdt < input.marginUsdt
          || finalEvidence.marginMode?.toUpperCase() !== "ISOLATED"
          || finalEvidence.leverage !== 10
          || !finalEvidence.marketOrderSelected
          || finalEvidence.selectedSide !== input.side
          || !finalEvidence.summaryMatches
          || !this.assertAutomationReady()
        ) {
          return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" } as const;
        }

        // Refresh disk-backed Kill Switch and RiskEngine state at the final
        // submit boundary, after the final DOM evidence check and immediately
        // before the single click. Canary callers refresh their complete gate
        // list through the same callback.
        await this.options.refreshPreflight?.();
        assertTrustedKcexUrl(page.url());
        if (!this.assertAutomationReady()) {
          return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" } as const;
        }

        // Mark before awaiting the single click: timeout/disconnect is UNKNOWN and cannot retry.
        this.submittedSlots.add(input.attemptId);
        submitAttempted = true;
        assertTrustedKcexUrl(page.url());
        await submit.click({ timeout: 10_000 });
        assertTrustedKcexUrl(page.url());
        const afterSubmit = await this.readEvidence(page, input.side, derived.inputValue);
        if (afterSubmit.orderRejected && afterSubmit.explicitlyNotSubmitted) {
          return { status: "FAILED_NOT_SUBMITTED", reason: "ORDER_REJECTED" } as const;
        }
        if (afterSubmit.orderRejected) return { status: "UNKNOWN", reason: "SUBMIT_OUTCOME_UNKNOWN" } as const;
        return {
          status: "SUBMITTED",
          submittedAt: this.clockNow().toISOString(),
          quantity: derived.quantity,
          notionalUsdt: derived.notionalUsdt,
        } as const;
      });
    } catch {
      if (submitAttempted) return { status: "UNKNOWN", reason: "SUBMIT_OUTCOME_UNKNOWN" };
      try {
        assertTrustedKcexUrl(await this.options.pageSource.withTrustedPage((page) => Promise.resolve(page.url())));
      } catch {
        return { status: "UNKNOWN", reason: "TRUSTED_PAGE_LOST" };
      }
      return { status: "FAILED_NOT_SUBMITTED", reason: "PRECHECK_FAILED" };
    }
  }

  private assertAutomationReady(): boolean {
    return this.options.isRuntimeAuthorized() && this.options.getBlockReasons().length === 0;
  }

  private async readEvidence(page: Page, side: "LONG" | "SHORT", quantity: string): Promise<KcexPageEvidence> {
    assertTrustedKcexUrl(page.url());
    const selector = (key: keyof KcexLiveSelectorManifest) => requireVerifiedKcexSelector(this.options.selectors, key);
    const symbol = await readText(page, selector("symbol"));
    const priceText = await readText(page, selector("markPrice"));
    const balanceText = await readText(page, selector("availableUsdt"));
    const marginMode = await readText(page, selector("marginMode"));
    const leverageText = await readText(page, selector("leverage"));
    const flat = await visibleLocator(page, selector("positionFlat"));
    const open = await visibleLocator(page, selector("positionOpen"));
    const openOrders = await visibleLocator(page, selector("openOrders"));
    const emptyOrders = await visibleLocator(page, selector("emptyOrders"));
    const market = await visibleLocator(page, selector("marketOrderTab"));
    const long = await visibleLocator(page, selector("longControl"));
    const short = await visibleLocator(page, selector("shortControl"));
    const summary = await readText(page, selector("orderSummary"));
    const rejection = await visibleLocator(page, selector("orderRejected"));
    const explicitlyNotSubmitted = await visibleLocator(page, selector("orderNotSubmitted"));
    const position = flat && !open ? "FLAT" : open && !flat ? "OPEN" : "UNKNOWN";
    const longSelected = await selected(long);
    const shortSelected = await selected(short);
    const selectedSide = longSelected && !shortSelected ? "LONG" : shortSelected && !longSelected ? "SHORT" : null;
    const displayedQuantity = summary?.match(/(?:qty|quantity|size)\s*[:=]?\s*([\d.,]+)/i)?.[1]?.replace(/,/g, "") ?? null;
    const summarySide = summary?.toUpperCase().includes(side) ? side : null;
    const summaryMatches = Number(displayedQuantity) === Number(quantity) && summarySide === side;
    return {
      symbol: symbol?.toUpperCase().replace(/\s+/g, "") ?? null,
      availableUsdt: balanceText === null ? null : parseStrictNumeric(balanceText),
      markPrice: priceText === null ? null : parseStrictNumeric(priceText),
      marginMode,
      leverage: leverageText === null ? null : parseStrictNumeric(leverageText.replace(/x/ig, "")),
      position,
      openOrders: emptyOrders && !openOrders ? "EMPTY" : openOrders && !emptyOrders ? "OPEN" : "UNKNOWN",
      marketOrderSelected: await selected(market),
      selectedSide,
      summaryMatches,
      orderRejected: rejection !== null,
      explicitlyNotSubmitted: explicitlyNotSubmitted !== null,
    };
  }

  private clockNow(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("KCEX execution clock is invalid.");
    return value;
  }
}
