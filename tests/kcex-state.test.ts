import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { collectPageEvidence } from "../src/kcex/evidence.js";
import { detectFuturesPage, detectLoginState } from "../src/kcex/state.js";
import { normalizeSymbol } from "../src/utils/symbol.js";

function fixture(name: string, url: string) {
  const window = new Window();
  const html = readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8");
  window.document.write(html);

  return {
    evidence: collectPageEvidence(window.document, url),
    close: () => window.close(),
  };
}

describe("read-only login detection with fixture DOMs", () => {
  it("recognizes positive logged-in account-menu evidence", () => {
    const page = fixture("logged-in.html", "https://www.kcex.com/");
    expect(detectLoginState(page.evidence).status).toBe("LOGGED_IN");
    page.close();
  });

  it("recognizes an explicit login form as logged out", () => {
    const page = fixture("logged-out.html", "https://www.kcex.com/login");
    expect(detectLoginState(page.evidence).status).toBe("LOGGED_OUT");
    page.close();
  });

  it("returns UNKNOWN when login evidence is insufficient", () => {
    const page = fixture("unknown-login.html", "https://www.kcex.com/");
    expect(detectLoginState(page.evidence).status).toBe("UNKNOWN");
    page.close();
  });
});

describe("GPS_USDT Futures page detection with fixture DOMs", () => {
  it("normalizes common symbol spellings", () => {
    expect(normalizeSymbol(" gps / usdt ")).toBe("GPS_USDT");
    expect(normalizeSymbol("GPS-USDT")).toBe("GPS_USDT");
    expect(normalizeSymbol("not-a-symbol")).toBeNull();
  });

  it("requires the Futures URL and visible symbol to confirm GPS_USDT", () => {
    const page = fixture(
      "gps-usdt.html",
      "https://www.kcex.com/futures/exchange/GPS_USDT",
    );
    expect(detectFuturesPage(page.evidence)).toMatchObject({
      status: "READY",
      symbol: "GPS_USDT",
    });
    page.close();
  });

  it("rejects a visible wrong symbol even when the URL requests GPS_USDT", () => {
    const page = fixture(
      "wrong-symbol.html",
      "https://www.kcex.com/futures/exchange/GPS_USDT",
    );
    expect(detectFuturesPage(page.evidence)).toMatchObject({
      status: "MISMATCH",
      symbol: "BTC_USDT",
    });
    page.close();
  });

  it("returns UNKNOWN when the URL has a symbol but the visible page does not confirm it", () => {
    const page = fixture(
      "insufficient-symbol.html",
      "https://www.kcex.com/futures/exchange/GPS_USDT",
    );
    expect(detectFuturesPage(page.evidence)).toMatchObject({
      status: "UNKNOWN",
      symbol: null,
    });
    page.close();
  });
});
