import type { Locator, Page } from "playwright";
import {
  assertTrustedKcexUrl,
  isTrustedKcexUrl,
} from "../../../../src/kcex/trusted-host.js";
import { getSymbolFromUrl } from "../../../../src/kcex/urls.js";
import { normalizeSymbol } from "../../../../src/utils/symbol.js";
import { parseStrictNumeric } from "../../../../src/kcex/number-parser.js";
import { KCEX_FUTURES_READ_SELECTORS } from "../../../../src/kcex/futures-read-selectors.js";
import { assertFuturesSourceConsistency } from "../../../../packages/shared/src/futures-invariants.js";
import type {
  ContractSnapshot,
  FuturesReadStatus,
  KcexFuturesSnapshot,
  OpenOrderSnapshot,
  OpenOrdersSnapshot,
  PositionSnapshot,
  ReadHealth,
  SelectorEvidenceField,
} from "../../../../packages/shared/src/protocol.js";
import type { TrustedPageSource } from "./trusted-page-source.js";

export interface FuturesReadAdapter {
  readSnapshot(): Promise<FuturesSnapshotResult>;
}

export interface FuturesSnapshotResult {
  status: FuturesReadStatus;
  snapshot?: KcexFuturesSnapshot;
  reason?: string;
  diagnostics?: FuturesReadDiagnostics;
}

export interface FuturesReadDiagnostics {
  authenticated: boolean;
  trustedPage: boolean;
  loginControlsVisible: boolean;
  challengeVisible: boolean;
  evidence: {
    symbol: boolean;
    market: boolean;
    account: boolean;
    contract: boolean;
    position: boolean;
    openOrders: boolean;
  };
  missingFields: SelectorEvidenceField[];
}

type ReadSelectors = typeof KCEX_FUTURES_READ_SELECTORS;

export interface KcexFuturesReadAdapterOptions {
  pageSource: TrustedPageSource;
  selectors?: ReadSelectors;
  now?: () => Date;
}

async function visibleLocator(parent: Page | Locator, selector: string): Promise<Locator | null> {
  const locator = parent.locator(selector);
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function readText(locator: Locator | null): Promise<string | null> {
  if (!locator) return null;
  const text = await locator.innerText().catch(() => null);
  if (text !== null) return text.trim();
  const content = await locator.textContent().catch(() => null);
  return content?.trim() || null;
}

async function readVisibleText(parent: Page | Locator, selector: string): Promise<string | null> {
  return readText(await visibleLocator(parent, selector));
}

function healthFor(values: Array<number | null>): ReadHealth {
  const available = values.filter((value) => value !== null).length;
  if (available === values.length) return "READY";
  return available === 0 ? "UNKNOWN" : "PARTIAL";
}

function readNonnegative(value: string | null): number | null {
  const parsed = parseStrictNumeric(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function readSigned(value: string | null): number | null {
  return parseStrictNumeric(value);
}

function readMarginMode(value: string | null): ContractSnapshot["marginMode"] {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "ISOLATED" || normalized?.includes("ISOLATED")) return "ISOLATED";
  if (normalized === "CROSS" || normalized?.includes("CROSS")) return "CROSS";
  return "UNKNOWN";
}

function readPositionSide(value: string | null): PositionSnapshot["side"] {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "LONG" || normalized?.includes("LONG")) return "LONG";
  if (normalized === "SHORT" || normalized?.includes("SHORT")) return "SHORT";
  if (normalized === "NONE" || normalized?.includes("NO POSITION")) return "NONE";
  return "UNKNOWN";
}

function readOrderSide(value: string | null): OpenOrderSnapshot["side"] {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "LONG" || normalized?.includes("LONG")) return "LONG";
  if (normalized === "SHORT" || normalized?.includes("SHORT")) return "SHORT";
  return "UNKNOWN";
}

function readOrderType(value: string | null): OpenOrderSnapshot["type"] {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "LIMIT" || normalized?.includes("LIMIT")) return "LIMIT";
  if (normalized === "MARKET" || normalized?.includes("MARKET")) return "MARKET";
  if (normalized === "TRIGGER" || normalized?.includes("TRIGGER")) return "TRIGGER";
  if (normalized === "TP" || normalized?.includes("TAKE PROFIT")) return "TP";
  if (normalized === "SL" || normalized?.includes("STOP LOSS")) return "SL";
  return "UNKNOWN";
}

function readBoolean(value: string | null): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "no") return false;
  return null;
}

function readDomSymbol(value: string | null): string | null {
  if (!value) return null;
  const exact = normalizeSymbol(value);
  if (exact) return exact;
  const match = value.toUpperCase().match(/[A-Z0-9]{2,}\s*[_/-]\s*[A-Z0-9]{2,}/);
  return match ? normalizeSymbol(match[0]) : null;
}

export class KcexFuturesReadAdapter implements FuturesReadAdapter {
  private readonly pageSource: TrustedPageSource;
  private readonly selectors: ReadSelectors;
  private readonly now: () => Date;

  constructor(
    sourceOrOptions: TrustedPageSource | KcexFuturesReadAdapterOptions,
    selectors: ReadSelectors = KCEX_FUTURES_READ_SELECTORS,
    now: () => Date = () => new Date(),
  ) {
    if ("pageSource" in sourceOrOptions) {
      this.pageSource = sourceOrOptions.pageSource;
      this.selectors = sourceOrOptions.selectors ?? KCEX_FUTURES_READ_SELECTORS;
      this.now = sourceOrOptions.now ?? (() => new Date());
    } else {
      this.pageSource = sourceOrOptions;
      this.selectors = selectors;
      this.now = now;
    }
  }

  async readSnapshot(): Promise<FuturesSnapshotResult> {
    try {
      return await this.pageSource.withTrustedPage(async (page) => {
        const url = page.url();
        assertTrustedKcexUrl(url);

        const diagnostics: FuturesReadDiagnostics = {
          authenticated: true,
          trustedPage: true,
          loginControlsVisible: false,
          challengeVisible: false,
          evidence: { symbol: false, market: false, account: false, contract: false, position: false, openOrders: false },
          missingFields: [],
        };

        const captcha = await visibleLocator(page, this.selectors.captcha);
        if (captcha) {
          diagnostics.challengeVisible = true;
          return { status: "MANUAL_CHALLENGE" as const, reason: "KCEX challenge is visible.", diagnostics };
        }
        const loginForm = await visibleLocator(page, this.selectors.loginForm);
        const loginControl = await visibleLocator(page, this.selectors.loginControl);
        if (loginForm || loginControl) {
          diagnostics.loginControlsVisible = true;
          return { status: "SESSION_LOST" as const, reason: "KCEX login controls are visible.", diagnostics };
        }

        const urlSymbol = getSymbolFromUrl(url);
        if (urlSymbol && urlSymbol !== "GPS_USDT") {
          return { status: "SYMBOL_MISMATCH", reason: "Trusted KCEX page is showing a different symbol.", diagnostics };
        }
        const symbolLocator = await visibleLocator(page, this.selectors.symbol);
        const domSymbol = readDomSymbol(await readText(symbolLocator));
        if (domSymbol && domSymbol !== "GPS_USDT") {
          return { status: "SYMBOL_MISMATCH", reason: "Trusted KCEX page is showing a different symbol.", diagnostics };
        }
        diagnostics.evidence.symbol = urlSymbol === "GPS_USDT" || domSymbol === "GPS_USDT";
        if (!diagnostics.evidence.symbol) diagnostics.missingFields.push("symbol");
        if (!diagnostics.evidence.symbol) {
          return { status: "UNKNOWN", reason: "Trusted page has no explicit GPS_USDT symbol evidence.", diagnostics };
        }

        const timestamp = this.now().toISOString();
        const lastPriceLocator = await visibleLocator(page, this.selectors.lastPrice);
        const markPriceLocator = await visibleLocator(page, this.selectors.markPrice);
        const lastPrice = readNonnegative(await readText(lastPriceLocator));
        const markPrice = readNonnegative(await readText(markPriceLocator));
        diagnostics.evidence.market = lastPriceLocator !== null && markPriceLocator !== null;
        if (!lastPriceLocator) diagnostics.missingFields.push("lastPrice");
        if (!markPriceLocator) diagnostics.missingFields.push("markPrice");
        const marketHealth = healthFor([lastPrice, markPrice]);
        const market = {
          symbol: "GPS_USDT" as const,
          lastPrice,
          markPrice,
          source: "KCEX" as const,
          health: marketHealth,
          freshness: "FRESH" as const,
          updatedAt: timestamp,
        };

        const availableLocator = await visibleLocator(page, this.selectors.availableUsdt);
        const availableUsdt = readNonnegative(await readText(availableLocator));
        diagnostics.evidence.account = availableLocator !== null;
        if (!availableLocator) diagnostics.missingFields.push("availableUsdt");
        const accountHealth: ReadHealth = availableUsdt === null ? "UNKNOWN" : "READY";
        const account = {
          asset: "USDT" as const,
          availableUsdt,
          source: "KCEX" as const,
          health: accountHealth,
          updatedAt: timestamp,
        };

        const marginModeLocator = await visibleLocator(page, this.selectors.marginMode);
        const leverageLocator = await visibleLocator(page, this.selectors.leverage);
        const marginMode = readMarginMode(await readText(marginModeLocator));
        const leverage = readNonnegative(await readText(leverageLocator));
        diagnostics.evidence.contract = marginModeLocator !== null && leverageLocator !== null;
        if (!marginModeLocator) diagnostics.missingFields.push("marginMode");
        if (!leverageLocator) diagnostics.missingFields.push("leverage");
        const contractHealth: ReadHealth = marginMode !== "UNKNOWN" && leverage !== null
          ? "READY"
          : marginMode === "UNKNOWN" && leverage === null ? "UNKNOWN" : "PARTIAL";
        const contract: ContractSnapshot = {
          symbol: "GPS_USDT",
          marginMode,
          leverage,
          source: "KCEX",
          health: contractHealth,
          updatedAt: timestamp,
        };

        const emptyPosition = await visibleLocator(page, this.selectors.positionEmpty);
        const positionContainer = await visibleLocator(page, this.selectors.positionContainer);
        const positionSideLocator = emptyPosition ? null : await visibleLocator(positionContainer ?? page, this.selectors.positionSide);
        diagnostics.evidence.position = emptyPosition !== null || (positionContainer !== null && positionSideLocator !== null);
        if (!diagnostics.evidence.position) diagnostics.missingFields.push("positionEvidence");
        let position: PositionSnapshot;
        if (emptyPosition) {
          position = {
            symbol: "GPS_USDT",
            side: "NONE",
            entryPrice: null,
            size: null,
            unrealizedPnl: null,
            source: "KCEX",
            health: "READY",
            freshness: "FRESH",
            updatedAt: timestamp,
          };
        } else {
          const side = readPositionSide(await readText(positionSideLocator));
          const entryPrice = readNonnegative(await readVisibleText(positionContainer ?? page, this.selectors.positionEntry));
          const size = readNonnegative(await readVisibleText(positionContainer ?? page, this.selectors.positionSize));
          const unrealizedPnl = readSigned(await readVisibleText(positionContainer ?? page, this.selectors.positionUnrealizedPnl));
          const positionHealth: ReadHealth = !positionContainer || side === "UNKNOWN"
            ? "UNKNOWN"
            : healthFor([entryPrice, size, unrealizedPnl]);
          position = {
            symbol: "GPS_USDT",
            side,
            entryPrice,
            size,
            unrealizedPnl,
            source: "KCEX",
            health: positionHealth,
            freshness: "FRESH",
            updatedAt: timestamp,
          };
        }

        const emptyOrders = await visibleLocator(page, this.selectors.openOrdersEmpty);
        const table = emptyOrders ? null : await visibleLocator(page, this.selectors.openOrdersTable);
        diagnostics.evidence.openOrders = emptyOrders !== null || table !== null;
        if (!diagnostics.evidence.openOrders) diagnostics.missingFields.push("openOrdersEvidence");
        let openOrders: OpenOrdersSnapshot;
        if (emptyOrders) {
          openOrders = { symbol: "GPS_USDT", orders: [], ordersHealth: "READY", source: "KCEX", updatedAt: timestamp };
        } else {
          if (!table) {
            openOrders = { symbol: "GPS_USDT", orders: [], ordersHealth: "UNKNOWN", source: "KCEX", updatedAt: timestamp };
          } else {
            const rows = table.locator(this.selectors.openOrderRows);
            const rowCount = Math.min(await rows.count().catch(() => 0), 100);
            const orders: OpenOrderSnapshot[] = [];
            let ordersHealth: ReadHealth = rowCount === 0 ? "UNKNOWN" : "READY";
            for (let index = 0; index < rowCount; index += 1) {
              const row = rows.nth(index);
              const price = readNonnegative(await readVisibleText(row, this.selectors.openOrderPrice));
              const quantity = readNonnegative(await readVisibleText(row, this.selectors.openOrderQuantity));
              const filledQuantity = readNonnegative(await readVisibleText(row, this.selectors.openOrderFilled));
              const side = readOrderSide(await readVisibleText(row, this.selectors.openOrderSide));
              const type = readOrderType(await readVisibleText(row, this.selectors.openOrderType));
              const reduceOnly = readBoolean(await readVisibleText(row, this.selectors.openOrderReduceOnly));
              const status = await readVisibleText(row, this.selectors.openOrderStatus);
              if (side === "UNKNOWN" || type === "UNKNOWN" || price === null || quantity === null) ordersHealth = "PARTIAL";
              orders.push({ symbol: "GPS_USDT", side, type, price, quantity, filledQuantity, reduceOnly, status, source: "KCEX" });
            }
            openOrders = { symbol: "GPS_USDT", orders, ordersHealth, source: "KCEX", updatedAt: timestamp };
          }
        }

        const fieldHealth = [marketHealth, accountHealth, contractHealth, position.health, openOrders.ordersHealth];
        const health: ReadHealth = fieldHealth.every((value) => value === "READY")
          ? "READY"
          : fieldHealth.every((value) => value === "UNKNOWN") ? "UNKNOWN" : "PARTIAL";
        const snapshot: KcexFuturesSnapshot = {
          symbol: "GPS_USDT",
          market,
          account,
          contract,
          position,
          openOrders,
          source: "KCEX",
          health,
          status: health === "READY" ? "READY" : health === "UNKNOWN" ? "UNKNOWN" : "PARTIAL",
          freshness: "FRESH",
          updatedAt: timestamp,
        };
        assertFuturesSourceConsistency(snapshot);
        return { status: snapshot.status, snapshot, diagnostics };
      });
    } catch (error) {
      return {
        status: "UNKNOWN",
        reason: error instanceof Error && /trusted kcex|untrusted/i.test(error.message)
          ? "KCEX page trust validation failed."
          : "Trusted page read failed.",
        diagnostics: {
          authenticated: false,
          trustedPage: false,
          loginControlsVisible: false,
          challengeVisible: false,
          evidence: { symbol: false, market: false, account: false, contract: false, position: false, openOrders: false },
          missingFields: [],
        },
      };
    }
  }
}

export function isTrustedReadPageUrl(value: string): boolean {
  return isTrustedKcexUrl(value);
}
