import { extractSymbols, normalizeSymbol } from "../utils/symbol.js";
import { getSymbolFromUrl, TARGET_SYMBOL } from "./urls.js";
import type { PageEvidence } from "./evidence.js";

export type LoginState =
  | { status: "LOGGED_IN"; reason: string }
  | { status: "LOGGED_OUT"; reason: string }
  | { status: "UNKNOWN"; reason: string };

export type FuturesPageState =
  | { status: "READY"; symbol: string; reason: string }
  | { status: "MISMATCH"; symbol: string | null; reason: string }
  | { status: "UNKNOWN"; symbol: string | null; reason: string };

const loginTextPattern = /\b(log\s*in|login|sign\s*in)\b|登录|登陆|注册/i;
const loggedInTextPattern = /\b(log\s*out|sign\s*out)\b|退出登录|退出账号/i;

function isFuturesRoute(value: string): boolean {
  try {
    return /\/futures(?:\/|$)/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export function detectLoginState(evidence: PageEvidence): LoginState {
  const hasLoggedInMarker =
    evidence.accountMenuVisible || loggedInTextPattern.test(evidence.visibleText);
  const hasLoginText = loginTextPattern.test(evidence.visibleText);
  const hasLoggedOutMarker =
    (evidence.loginFormVisible || evidence.loginControlVisible) && hasLoginText;

  if (hasLoggedInMarker && hasLoggedOutMarker) {
    return {
      status: "UNKNOWN",
      reason: "Both signed-in and signed-out markers are visible.",
    };
  }

  if (hasLoggedInMarker) {
    return {
      status: "LOGGED_IN",
      reason: "A visible account menu or sign-out marker was found.",
    };
  }

  if (hasLoggedOutMarker) {
    return {
      status: "LOGGED_OUT",
      reason: "A visible login form or login control includes explicit login text.",
    };
  }

  return {
    status: "UNKNOWN",
    reason: "The page does not contain enough positive evidence to determine login state.",
  };
}

export function detectFuturesPage(
  evidence: PageEvidence,
  requestedSymbol: string = TARGET_SYMBOL,
): FuturesPageState {
  const target = normalizeSymbol(requestedSymbol);
  if (!target) {
    return {
      status: "UNKNOWN",
      symbol: null,
      reason: "The requested symbol could not be normalized.",
    };
  }

  const urlSymbol = getSymbolFromUrl(evidence.url);
  const domSymbols = [...new Set(evidence.symbolLabels.flatMap(extractSymbols))];
  const visibleSymbol = domSymbols.length === 1 ? domSymbols[0] : null;
  if (urlSymbol && urlSymbol !== target) {
    return {
      status: "MISMATCH",
      symbol: urlSymbol,
      reason: "The URL identifies " + urlSymbol + " instead of " + target + ".",
    };
  }

  const mismatchedDomSymbol = domSymbols.find((symbol) => symbol !== target);
  if (mismatchedDomSymbol) {
    return {
      status: "MISMATCH",
      symbol: mismatchedDomSymbol,
      reason:
        "A visible contract label identifies " +
        mismatchedDomSymbol +
        " instead of " +
        target +
        ".",
    };
  }

  if (!isFuturesRoute(evidence.url)) {
    return {
      status: "UNKNOWN",
      symbol: null,
      reason: "The current URL does not identify a KCEX Futures route.",
    };
  }

  if (urlSymbol !== target || visibleSymbol !== target) {
    return {
      status: "UNKNOWN",
      symbol: null,
      reason: "Both the Futures URL and a visible contract label must confirm " + target + ".",
    };
  }

  return {
    status: "READY",
    symbol: target,
    reason: "The Futures URL and visible contract label both confirm " + target + ".",
  };
}
