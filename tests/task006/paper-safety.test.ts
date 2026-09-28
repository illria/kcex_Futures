import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Paper trading side-effect boundary", () => {
  it("keeps PaperTradingService independent of KCEX, Playwright, and mutation methods", async () => {
    const source = await readFile(new URL("../../apps/server/src/trading/paper-trading-service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/playwright|KcexAuthAdapter|TrustedPageSource/i);
    for (const forbidden of [
      ".click(",
      ".fill(",
      ".press(",
      ".type(",
      ".selectOption(",
      "placeOrder(",
      "cancelOrder(",
      "setLeverage(",
      "setMarginMode(",
      "closePosition(",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
