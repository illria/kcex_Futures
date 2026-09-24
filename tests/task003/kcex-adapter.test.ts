import type { Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { KcexAuthAdapter } from "../../apps/server/src/auth/kcex-auth-adapter.js";
import { KCEX_SELECTORS } from "../../src/kcex/selectors.js";

type Marker = "accountInput" | "passwordInput" | "loginSubmit" | "otpInput" | "otpSubmit" | "accountMenu" | "captcha" | "loginError" | "loginForm";

interface FixtureState {
  url: string;
  bodyText: string;
  visible: Set<Marker>;
  filled: { account: boolean; password: boolean; otp: boolean };
  onLoginSubmit?: () => void;
  onOtpSubmit?: () => void;
}

function pageFixture(options: {
  redirectTo?: string;
  bodyText?: string;
  visible?: Marker[];
  onLoginSubmit?: () => void;
  onOtpSubmit?: () => void;
} = {}): { page: Page; state: FixtureState } {
  const state: FixtureState = {
    url: "https://www.kcex.com/login",
    bodyText: options.bodyText ?? "",
    visible: new Set(options.visible ?? []),
    filled: { account: false, password: false, otp: false },
    onLoginSubmit: options.onLoginSubmit,
    onOtpSubmit: options.onOtpSubmit,
  };

  const markerForSelector = (selector: string): Marker | "body" | null => {
    if (selector === "body") return "body";
    if (selector === KCEX_SELECTORS.accountInput) return "accountInput";
    if (selector === KCEX_SELECTORS.passwordInput) return "passwordInput";
    if (selector === KCEX_SELECTORS.loginSubmit) return "loginSubmit";
    if (selector === KCEX_SELECTORS.otpInput) return "otpInput";
    if (selector === KCEX_SELECTORS.otpSubmit) return "otpSubmit";
    if (selector === KCEX_SELECTORS.accountMenu) return "accountMenu";
    if (selector === KCEX_SELECTORS.captcha) return "captcha";
    if (selector === KCEX_SELECTORS.loginError) return "loginError";
    if (selector === KCEX_SELECTORS.loginForm) return "loginForm";
    return null;
  };

  const locator = (selector: string) => {
    const marker = markerForSelector(selector);
    const visible = marker === "body" || (marker !== null && state.visible.has(marker));
    const stub = {
      count: async () => visible ? 1 : 0,
      nth: () => stub,
      isVisible: async () => visible,
      innerText: async () => marker === "body" ? state.bodyText : "",
      textContent: async () => marker === "body" ? state.bodyText : "",
      fill: async () => {
        if (marker === "accountInput") state.filled.account = true;
        if (marker === "passwordInput") state.filled.password = true;
        if (marker === "otpInput") state.filled.otp = true;
      },
      click: async () => {
        if (marker === "loginSubmit") state.onLoginSubmit?.();
        if (marker === "otpSubmit") state.onOtpSubmit?.();
      },
    } as unknown as Locator;
    return stub;
  };

  const page = {
    url: () => state.url,
    goto: async (target: string) => {
      state.url = options.redirectTo ?? target;
      return null;
    },
    waitForLoadState: async () => undefined,
    locator,
  } as unknown as Page;
  return { page, state };
}

const credentials = { account: "fixture@example.test", password: "fixture-password" };

describe("KcexAuthAdapter result handling", () => {
  it("maps a trusted login page to OTP_REQUIRED and a trusted OTP page to AUTHENTICATED", async () => {
    const fixture = pageFixture({
      visible: ["accountInput", "passwordInput", "loginSubmit"],
    });
    fixture.state.onLoginSubmit = () => {
      fixture.state.bodyText = "Email verification";
      fixture.state.visible = new Set(["otpInput", "otpSubmit"]);
    };
    fixture.state.onOtpSubmit = () => {
      fixture.state.bodyText = "Sign out";
      fixture.state.visible = new Set(["accountMenu"]);
    };
    const adapter = new KcexAuthAdapter({ page: fixture.page });

    await expect(adapter.login(credentials)).resolves.toBe("OTP_REQUIRED");
    expect(fixture.state.filled).toMatchObject({ account: true, password: true });
    const code = Buffer.from("123456", "utf8");
    await expect(adapter.submitOtp(code)).resolves.toBe("AUTHENTICATED");
    expect(fixture.state.filled.otp).toBe(true);
    code.fill(0);
  });

  it.each([
    ["login error", "AUTH_FAILED", { bodyText: "Invalid credentials", visible: ["loginError", "loginForm"] as Marker[] }],
    ["captcha", "MANUAL_CHALLENGE", { bodyText: "Security check", visible: ["captcha"] as Marker[] }],
    ["unknown", "AUTH_UNKNOWN", { bodyText: "", visible: [] as Marker[] }],
  ] as const)("maps a trusted %s result", async (_name, expected, result) => {
    const fixture = pageFixture({
      visible: ["accountInput", "passwordInput", "loginSubmit"],
    });
    fixture.state.onLoginSubmit = () => {
      fixture.state.bodyText = result.bodyText;
      fixture.state.visible = new Set(result.visible);
    };
    const adapter = new KcexAuthAdapter({ page: fixture.page });
    await expect(adapter.login(credentials)).resolves.toBe(expected);
    expect(fixture.state.filled).toMatchObject({ account: true, password: true });
  });

  it("checks the trusted host before DOM detection after an untrusted redirect", async () => {
    for (const visible of [["accountMenu"], ["otpInput", "otpSubmit"]] as Marker[][]) {
      const fixture = pageFixture({
        redirectTo: "https://evil.example.invalid/login",
        bodyText: visible.includes("accountMenu") ? "Sign out" : "Email verification",
        visible,
      });
      const adapter = new KcexAuthAdapter({ page: fixture.page });
      await expect(adapter.login(credentials)).resolves.toBe("AUTH_UNKNOWN");
      expect(fixture.state.filled).toEqual({ account: false, password: false, otp: false });
    }
  });

  it("rejects an untrusted KCEX base URL before a page can be opened", () => {
    expect(() => new KcexAuthAdapter({ baseUrl: "https://evil.example.invalid" })).toThrow();
    expect(() => new KcexAuthAdapter({ baseUrl: "https://www.kcex.com/futures" })).toThrow();
  });
});
