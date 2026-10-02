import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/schema.js";

describe("Task 001 configuration", () => {
  it("defaults to headed GPS_USDT inspection with live trading off", () => {
    const config = loadConfig({}, () => undefined);

    expect(config.KCEX_SYMBOL).toBe("GPS_USDT");
    expect(config.BROWSER_HEADLESS).toBe(false);
    expect(config.AUTH_PROVIDER).toBe("FAKE");
    expect(config.LIVE_TRADING).toBe(false);
    expect(config.LIVE_EXECUTION_PROVIDER).toBe("DISABLED");
    expect(config.PAPER_FEE_RATE).toBe(0);
  });

  it("accepts fixture and KCEX providers while live execution remains independently gated", () => {
    expect(loadConfig({ LIVE_EXECUTION_PROVIDER: "FIXTURE" }, () => undefined).LIVE_EXECUTION_PROVIDER).toBe("FIXTURE");
    expect(loadConfig({ LIVE_EXECUTION_PROVIDER: "KCEX" }, () => undefined).LIVE_EXECUTION_PROVIDER).toBe("KCEX");
  });

  it("accepts only a bounded finite simulated paper fee rate", () => {
    expect(loadConfig({ PAPER_FEE_RATE: "0.0001" }, () => undefined).PAPER_FEE_RATE).toBe(0.0001);
    expect(() => loadConfig({ PAPER_FEE_RATE: "-0.1" }, () => undefined)).toThrow();
    expect(() => loadConfig({ PAPER_FEE_RATE: "0.0101" }, () => undefined)).toThrow();
    expect(() => loadConfig({ PAPER_FEE_RATE: "NaN" }, () => undefined)).toThrow();
  });

  it("requires provider and explicit platform authorization before LIVE_TRADING=true", () => {
    expect(() => loadConfig({ LIVE_TRADING: "true" }, () => undefined)).toThrow();
    expect(() => loadConfig({ LIVE_TRADING: "true", LIVE_EXECUTION_PROVIDER: "KCEX" }, () => undefined)).toThrow();
    expect(loadConfig({
      LIVE_TRADING: "true",
      AUTH_PROVIDER: "KCEX",
      LIVE_EXECUTION_PROVIDER: "KCEX",
      KCEX_AUTOMATION_AUTHORIZED: "true",
    }, () => undefined).LIVE_TRADING).toBe(true);
    expect(() => loadConfig({
      LIVE_TRADING: "true",
      AUTH_PROVIDER: "KCEX",
      LIVE_EXECUTION_PROVIDER: "KCEX",
      KCEX_AUTOMATION_AUTHORIZED: "true",
      KCEX_BASE_URL: "https://evil.example.invalid",
    }, () => undefined)).toThrow();
    expect(loadConfig({}, () => undefined).KCEX_AUTOMATION_AUTHORIZED).toBe(false);
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
