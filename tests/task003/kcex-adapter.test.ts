import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { KcexAuthAdapter } from "../../apps/server/src/auth/kcex-auth-adapter.js";

function pageFixture(url: string): { page: Page; filled: { account: boolean; password: boolean } } {
  const filled = { account: false, password: false };
  const locator = (selector: string) => {
    const visible = selector.includes("email") || selector.includes("username") || selector.includes("password") || selector.includes("login-submit");
    const stub = {
      count: async () => visible ? 1 : 0,
      nth: () => stub,
      isVisible: async () => visible,
      innerText: async () => "",
      textContent: async () => "",
      fill: async () => {
        if (selector.includes("password")) filled.password = true;
        if (selector.includes("email") || selector.includes("username")) filled.account = true;
      },
      click: async () => undefined,
    } as unknown as Locator;
    return stub;
  };
  const page = {
    url: () => url,
    goto: async () => null,
    locator,
  } as unknown as Page;
  return { page, filled };
}

describe("KcexAuthAdapter credential host gate", () => {
  it("stops before filling credentials after an untrusted redirect", async () => {
    const fixture = pageFixture("https://evil.example.invalid/login");
    const adapter = new KcexAuthAdapter({ page: fixture.page });
    await expect(adapter.login({ account: "fixture@example.test", password: "fixture-password" })).resolves.toBe("AUTH_UNKNOWN");
    expect(fixture.filled).toEqual({ account: false, password: false });
  });
});
