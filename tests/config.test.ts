import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/schema.js";

describe("Task 001 configuration", () => {
  it("defaults to headed GPS_USDT inspection with live trading off", () => {
    const config = loadConfig({}, () => undefined);

    expect(config.KCEX_SYMBOL).toBe("GPS_USDT");
    expect(config.BROWSER_HEADLESS).toBe(false);
    expect(config.LIVE_TRADING).toBe(false);
  });

  it("ignores an attempt to enable live trading", () => {
    const warnings: string[] = [];
    const config = loadConfig(
      { LIVE_TRADING: "true" },
      (message) => warnings.push(message),
    );

    expect(config.LIVE_TRADING).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
