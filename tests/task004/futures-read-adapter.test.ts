import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { KcexFuturesReadAdapter } from "../../apps/server/src/futures/kcex-futures-read-adapter.js";
import type { TrustedPageSource } from "../../apps/server/src/futures/trusted-page-source.js";
import { assertTrustedKcexUrl } from "../../src/kcex/trusted-host.js";

const fixtureRoot = resolve(process.cwd(), "tests/fixtures/futures");

class FixtureLocator {
  constructor(private readonly elements: Element[]) {}

  locator(selector: string): FixtureLocator {
    return new FixtureLocator(this.elements.flatMap((element) => [...element.querySelectorAll(selector)]));
  }

  count(): Promise<number> { return Promise.resolve(this.elements.length); }
  nth(index: number): FixtureLocator { return new FixtureLocator(this.elements[index] ? [this.elements[index]] : []); }
  isVisible(): Promise<boolean> { return Promise.resolve(this.elements.length > 0); }
  innerText(): Promise<string> { return Promise.resolve(this.elements[0]?.textContent?.trim() ?? ""); }
  textContent(): Promise<string | null> { return Promise.resolve(this.elements[0]?.textContent ?? null); }
  getAttribute(name: string): Promise<string | null> { return Promise.resolve(this.elements[0]?.getAttribute(name) ?? null); }
}

function fixturePage(html: string, url: string): Page {
  const window = new Window();
  window.document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  const root = new FixtureLocator([window.document.documentElement as unknown as Element]);
  return {
    url: () => url,
    locator: (selector: string) => root.locator(selector),
  } as unknown as Page;
}

async function sourceFromFixture(name: string, url = "https://www.kcex.com/futures/exchange/GPS_USDT"): Promise<TrustedPageSource> {
  const html = await readFile(resolve(fixtureRoot, name), "utf8");
  const page = fixturePage(html, url);
  return {
    withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>) => {
      assertTrustedKcexUrl(page.url());
      const result = await operation(page);
      assertTrustedKcexUrl(page.url());
      return result;
    },
  };
}

describe("KCEX futures read-only adapter", () => {
  it("reads market, account, contract, position, and open orders without mutation APIs", async () => {
    const result = await new KcexFuturesReadAdapter(await sourceFromFixture("gps-normal.html")).readSnapshot();
    expect(result.status).toBe("READY");
    expect(result.snapshot?.market.lastPrice).toBe(0.012345);
    expect(result.snapshot?.account.availableUsdt).toBe(523.45);
    expect(result.snapshot?.contract.leverage).toBe(10);
    expect(result.snapshot?.position.side).toBe("LONG");
    expect(result.snapshot?.position.size).toBe(5000);
    expect(result.snapshot?.position.unrealizedPnl).toBe(1.23);
    expect(result.snapshot?.openOrders.orders).toHaveLength(2);
  });

  it("distinguishes no position and no open orders from unknown evidence", async () => {
    const noPosition = await new KcexFuturesReadAdapter(await sourceFromFixture("gps-no-position.html")).readSnapshot();
    expect(noPosition.snapshot?.position.side).toBe("NONE");
    expect(noPosition.snapshot?.position.health).toBe("READY");
    expect(noPosition.snapshot?.openOrders.orders).toHaveLength(0);
    const noOrders = await new KcexFuturesReadAdapter(await sourceFromFixture("gps-no-orders.html")).readSnapshot();
    expect(noOrders.snapshot?.openOrders.ordersHealth).toBe("READY");
    expect(noOrders.snapshot?.position.side).toBe("SHORT");
    expect(noOrders.snapshot?.position.unrealizedPnl).toBe(-0.42);
  });

  it("returns null for missing or malformed values and reports partial health", async () => {
    const partial = await new KcexFuturesReadAdapter(await sourceFromFixture("gps-partial.html")).readSnapshot();
    expect(partial.status).toBe("PARTIAL");
    expect(partial.snapshot?.market.markPrice).toBeNull();
    const malformed = await new KcexFuturesReadAdapter(await sourceFromFixture("malformed-numbers.html")).readSnapshot();
    expect(malformed.snapshot?.market.lastPrice).toBeNull();
    expect(malformed.snapshot?.contract.leverage).toBeNull();
    expect(malformed.snapshot?.health).toBe("PARTIAL");
  });

  it("fails closed for wrong symbols, login pages, and challenges", async () => {
    const wrong = await new KcexFuturesReadAdapter(await sourceFromFixture("wrong-symbol.html", "https://www.kcex.com/futures/exchange/BTC_USDT")).readSnapshot();
    expect(wrong.status).toBe("SYMBOL_MISMATCH");
    const lost = await new KcexFuturesReadAdapter(await sourceFromFixture("session-lost.html")).readSnapshot();
    expect(lost.status).toBe("SESSION_LOST");
    const challengePage = fixturePage('<main data-testid="captcha">Manual security challenge</main>', "https://www.kcex.com/futures/exchange/GPS_USDT");
    const challengeSource: TrustedPageSource = {
      withTrustedPage: async <T>(operation: (page: Page) => Promise<T>): Promise<T> => operation(challengePage),
    };
    const challenge = await new KcexFuturesReadAdapter(challengeSource).readSnapshot();
    expect(challenge.status).toBe("MANUAL_CHALLENGE");
  });

  it("rejects an untrusted page even when it contains account evidence", async () => {
    const html = await readFile(resolve(fixtureRoot, "gps-normal.html"), "utf8");
    const page = fixturePage(`${html}<div data-testid="account-menu">account</div>`, "https://evil.example.invalid/futures/GPS_USDT");
    const result = await new KcexFuturesReadAdapter({ withTrustedPage: async (operation) => operation(page) }).readSnapshot();
    expect(result.status).toBe("UNKNOWN");
  });

  it("never invokes Playwright mutation methods", async () => {
    const html = await readFile(resolve(fixtureRoot, "gps-normal.html"), "utf8");
    const page = fixturePage(html, "https://www.kcex.com/futures/exchange/GPS_USDT");
    const forbidden = new Set(["click", "fill", "press", "type", "check", "uncheck", "selectOption", "drag", "setInputFiles"]);
    let mutationCalls = 0;
    const guardedPage = new Proxy(page as unknown as object, {
      get(target, property, receiver) {
        if (typeof property === "string" && forbidden.has(property)) {
          mutationCalls += 1;
          throw new Error("READ_ONLY_VIOLATION");
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as Page;
    const result = await new KcexFuturesReadAdapter({
      withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>): Promise<T> => operation(guardedPage),
    }).readSnapshot();
    expect(result.status).toBe("READY");
    expect(mutationCalls).toBe(0);
  });
});
