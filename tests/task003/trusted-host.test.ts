import { describe, expect, it } from "vitest";
import { assertTrustedKcexUrl, isTrustedKcexUrl } from "../../src/kcex/trusted-host.js";

describe("TASK-003 trusted KCEX host gate", () => {
  it("accepts only the confirmed HTTPS www.kcex.com host", () => {
    expect(isTrustedKcexUrl("https://www.kcex.com/login")).toBe(true);
    expect(() => assertTrustedKcexUrl("https://www.kcex.com/futures/exchange/GPS_USDT")).not.toThrow();
  });

  it("rejects HTTP, arbitrary hosts, subdomains, IPs, ports, and embedded credentials", () => {
    for (const value of [
      "http://www.kcex.com/login",
      "https://evil.example/login",
      "https://login.kcex.com/login",
      "https://127.0.0.1/login",
      "https://localhost/login",
      "https://www.kcex.com:8443/login",
      "https://user:password@www.kcex.com/login",
    ]) {
      expect(isTrustedKcexUrl(value), value).toBe(false);
      expect(() => assertTrustedKcexUrl(value), value).toThrow();
    }
  });
});
