import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/schema.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { PaperTradingService } from "../../apps/server/src/trading/paper-trading-service.js";
import type { StorageService } from "../../apps/server/src/storage/storage-service.js";

const forbiddenRiskSourcePatterns = [
  /playwright/i,
  /readFile(?:Sync)?\s*\(/,
  /\bunlink\s*\(/,
  /\brm\s*\(/,
  /writeFile(?:Sync)?\s*\(/,
  /truncate\s*\(/,
  /KcexAuthAdapter/,
  /KcexAuthenticatedPageSource/,
  /\.click\s*\(/,
  /\.fill\s*\(/,
  /\.press\s*\(/,
  /\.type\s*\(/,
  /selectOption\s*\(/,
  /placeOrder\s*\(/,
  /cancelOrder\s*\(/,
  /closePosition\s*\(/,
  /setLeverage\s*\(/,
  /setMarginMode\s*\(/,
  /setInterval\s*\(/,
  /setTimeout\s*\(/,
];

describe("TASK-007 safety boundaries", () => {
  it("keeps LIVE_TRADING forced off and restricts configured limits to lower ceilings", () => {
    const defaults = loadConfig({}, () => undefined);
    expect(defaults.LIVE_TRADING).toBe(false);
    expect(defaults.KILL_SWITCH_FILE).toBe("./data/KILL_SWITCH");
    expect(defaults.RISK_LIMITS).toMatchObject({
      maxMarginUsdt: 50,
      maxLeverage: 10,
      maxDailyTrades: 10,
      maxDailyLossUsdt: 50,
      maxConsecutiveFailures: 3,
    });
    expect(() => loadConfig({ LIVE_TRADING: "true" }, () => undefined)).toThrow();
    expect(loadConfig({ RISK_MAX_MARGIN_USDT: "25", RISK_MAX_LEVERAGE: "5" }, () => undefined).RISK_LIMITS)
      .toMatchObject({ maxMarginUsdt: 25, maxLeverage: 5 });
    for (const environment of [
      { RISK_MAX_MARGIN_USDT: "50.01" },
      { RISK_MAX_LEVERAGE: "10.1" },
      { RISK_MAX_DAILY_TRADES: "11" },
      { RISK_MAX_DAILY_LOSS_USDT: "50.01" },
      { RISK_MAX_CONSECUTIVE_FAILURES: "4" },
    ]) {
      expect(() => loadConfig(environment, () => undefined)).toThrow();
    }
  });

  it("keeps Risk modules free from browser and mutation APIs", async () => {
    const root = join(process.cwd(), "apps/server/src/risk");
    const entries = await readdir(root, { withFileTypes: true });
    const sourceFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"));
    expect(sourceFiles.length).toBeGreaterThanOrEqual(4);
    for (const file of sourceFiles) {
      const contents = await readFile(join(root, file.name), "utf8");
      for (const pattern of forbiddenRiskSourcePatterns) {
        expect(contents, `${file.name} contains forbidden API pattern ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("fails Paper service construction when the Risk guard is absent", () => {
    expect(() => new PaperTradingService({
      storage: {} as StorageService,
      events: new EventBus(),
      risk: undefined as never,
    })).toThrow();
  });

  it("initializes Risk before Paper construction and recovery", async () => {
    const source = await readFile(join(process.cwd(), "apps/server/src/index.ts"), "utf8");
    const storageReady = source.indexOf("await storage.initialize();");
    const riskReady = source.indexOf("await risk.initialize();");
    const paperConstructed = source.indexOf("const paperTrading = new PaperTradingService(");
    const paperRecovered = source.indexOf("await paperTrading.recover();");
    expect(storageReady).toBeGreaterThanOrEqual(0);
    expect(storageReady).toBeLessThan(riskReady);
    expect(riskReady).toBeLessThan(paperConstructed);
    expect(paperConstructed).toBeLessThan(paperRecovered);
  });
});
