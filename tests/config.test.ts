import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/schema.js";

describe("Task 001 configuration", () => {
  it("defaults to headed GPS_USDT inspection with live trading off", () => {
    const config = loadConfig({}, () => undefined);

    expect(config.KCEX_SYMBOL).toBe("GPS_USDT");
    expect(config.BROWSER_HEADLESS).toBe(false);
    expect(config.AUTH_PROVIDER).toBe("FAKE");
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

  it("requires an explicit provider value for KCEX adapter selection", () => {
    expect(loadConfig({ AUTH_PROVIDER: "KCEX" }, () => undefined).AUTH_PROVIDER).toBe("KCEX");
  });

  it("fails before KCEX adapter startup when the base URL is not the confirmed origin", () => {
    expect(() => loadConfig({ AUTH_PROVIDER: "KCEX", KCEX_BASE_URL: "https://evil.example.invalid" }, () => undefined)).toThrow();
    expect(() => loadConfig({ AUTH_PROVIDER: "KCEX", KCEX_BASE_URL: "https://www.kcex.com/futures" }, () => undefined)).toThrow();
    expect(loadConfig({ AUTH_PROVIDER: "FAKE", KCEX_BASE_URL: "https://fixture.example.invalid" }, () => undefined).AUTH_PROVIDER).toBe("FAKE");
  });
});
