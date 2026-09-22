import { symbolFromUrl } from "../utils/symbol.js";

export const TARGET_SYMBOL = "GPS_USDT" as const;
export const DEFAULT_KCEX_BASE_URL = "https://www.kcex.com";

export function buildGpsUsdtFuturesUrl(
  baseUrl: string = DEFAULT_KCEX_BASE_URL,
): string {
  return new URL("/futures/exchange/" + TARGET_SYMBOL, baseUrl).toString();
}

export function getSymbolFromUrl(value: string): string | null {
  return symbolFromUrl(value);
}
