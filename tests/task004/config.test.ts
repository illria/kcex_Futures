import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/schema.js";

describe("read-only configuration", () => {
  it("defaults the feature off and clamps the polling interval", () => {
    expect(loadConfig({}).KCEX_READONLY_ENABLED).toBe(false);
    expect(loadConfig({ KCEX_READONLY_ENABLED: "true", KCEX_READ_POLL_MS: "2000" }).KCEX_READONLY_ENABLED).toBe(true);
    expect(loadConfig({ KCEX_READ_POLL_MS: "2000" }).KCEX_READ_POLL_MS).toBe(2000);
    expect(() => loadConfig({ KCEX_READ_POLL_MS: "1000" })).toThrow();
  });
});
