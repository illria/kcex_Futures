import type { BrowserContext, Locator, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { KcexAuthAdapter } from "../../apps/server/src/auth/kcex-auth-adapter.js";
import { KCEX_SELECTORS } from "../../src/kcex/selectors.js";

type Marker = "accountInput" | "passwordInput" | "loginSubmit" | "otpInput" | "otpSubmit" | "accountMenu" | "captcha" | "loginError" | "loginForm" | "loginControl" | "googleOAuthStart";

interface FixtureState {
  url: string;
  bodyText: string;
  bodyReads: number;
  visible: Set<Marker>;
  filled: { account: boolean; password: boolean; otp: boolean };
  onLoginSubmit?: () => void;
  onOtpSubmit?: () => void;
  onGoogleClick?: () => void;
}

function pageFixture(options: {
  redirectTo?: string;
  url?: string;
  bodyText?: string;
  visible?: Marker[];
  onLoginSubmit?: () => void;
  onOtpSubmit?: () => void;
  onGoogleClick?: () => void;
  googleOAuthSelector?: string;
} = {}): { page: Page; state: FixtureState } {
  const state: FixtureState = {
    url: options.url ?? "https://www.kcex.com/login",
    bodyText: options.bodyText ?? "",
    bodyReads: 0,
    visible: new Set(options.visible ?? []),
    filled: { account: false, password: false, otp: false },
    onLoginSubmit: options.onLoginSubmit,
    onOtpSubmit: options.onOtpSubmit,
    onGoogleClick: options.onGoogleClick,
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
    if (selector === KCEX_SELECTORS.loginControl) return "loginControl";
    if (selector === options.googleOAuthSelector && options.googleOAuthSelector) return "googleOAuthStart";
    return null;
  };

  const locator = (selector: string) => {
    const marker = markerForSelector(selector);
    const visible = marker === "body" || (marker !== null && state.visible.has(marker));
    const stub = {
      count: async () => visible ? 1 : 0,
      nth: () => stub,
      isVisible: async () => visible,
      innerText: async () => {
        if (marker === "body") state.bodyReads += 1;
        return marker === "body" ? state.bodyText : "";
      },
      textContent: async () => {
        if (marker === "body") state.bodyReads += 1;
        return marker === "body" ? state.bodyText : "";
      },
      fill: async () => {
        if (marker === "accountInput") state.filled.account = true;
        if (marker === "passwordInput") state.filled.password = true;
        if (marker === "otpInput") state.filled.otp = true;
      },
      click: async () => {
        if (marker === "loginSubmit") state.onLoginSubmit?.();
        if (marker === "otpSubmit") state.onOtpSubmit?.();
        if (marker === "googleOAuthStart") state.onGoogleClick?.();
      },
    } as unknown as Locator;
    return stub;
  };

  const page = {
    url: () => state.url,
    isClosed: () => false,
    goto: async (target: string) => {
      state.url = options.redirectTo ?? target;
      return null;
    },
    waitForLoadState: async () => undefined,
    waitForEvent: async () => null,
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

  it.each([
    ["account menu", "AUTHENTICATED", ["accountMenu"]],
    ["OTP input", "OTP_REQUIRED", ["otpInput", "otpSubmit"]],
    ["captcha", "MANUAL_CHALLENGE", ["captcha"]],
    ["login form", "SESSION_LOST", ["loginForm"]],
    ["login control", "SESSION_LOST", ["loginControl"]],
    ["insufficient evidence", "AUTH_UNKNOWN", []],
  ] as const)("checkSession returns the trusted %s result", async (_name, expected, visible) => {
    const fixture = pageFixture({
      bodyText: expected === "AUTHENTICATED" ? "Sign out" : expected === "OTP_REQUIRED" ? "Email verification" : "",
      visible: [...visible],
    });
    const adapter = new KcexAuthAdapter({ page: fixture.page });
    await expect(adapter.checkSession()).resolves.toBe(expected);
  });

  it("does not treat generic body sign-out text as authenticated evidence", async () => {
    const fixture = pageFixture({ bodyText: "Log out" });
    const adapter = new KcexAuthAdapter({ page: fixture.page });
    await expect(adapter.checkSession()).resolves.toBe("AUTH_UNKNOWN");
  });

  it("returns only safe browser health flags without exposing page details", () => {
    const fixture = pageFixture();
    const health = new KcexAuthAdapter({ page: fixture.page }).inspectBrowserHealth();
    expect(health).toEqual({ browserConnected: true, pageAvailable: true, pageClosed: false, trustedPage: true });
    expect(Object.keys(health).sort()).toEqual(["browserConnected", "pageAvailable", "pageClosed", "trustedPage"]);
    expect(JSON.stringify(health)).not.toContain("kcex.com");
  });

  it.each([
    ["account menu", ["accountMenu"]],
    ["OTP input", ["otpInput", "otpSubmit"]],
  ] as const)("checkSession fails closed on an untrusted URL with %s", async (_name, visible) => {
    const fixture = pageFixture({
      url: "https://evil.example.invalid/futures/exchange/GPS_USDT",
      bodyText: visible[0] === "accountMenu" ? "Sign out" : "Email verification",
      visible: [...visible],
    });
    const adapter = new KcexAuthAdapter({ page: fixture.page });
    await expect(adapter.checkSession()).resolves.toBe("AUTH_UNKNOWN");
  });

  it("rejects an untrusted KCEX base URL before a page can be opened", () => {
    expect(() => new KcexAuthAdapter({ baseUrl: "https://evil.example.invalid" })).toThrow();
    expect(() => new KcexAuthAdapter({ baseUrl: "https://www.kcex.com/futures" })).toThrow();
  });

  it("keeps Google OAuth user-driven until a trusted KCEX account marker returns", async () => {
    const fixture = pageFixture({
      bodyText: "Google Password and verification challenge",
      visible: ["googleOAuthStart"],
      googleOAuthSelector: "#google-oauth-start",
    });
    fixture.state.onGoogleClick = () => { fixture.state.url = "https://accounts.google.com/signin"; };
    const adapter = new KcexAuthAdapter({ page: fixture.page, googleOAuthSelector: "#google-oauth-start" });
    await expect(adapter.startGoogleOAuth()).resolves.toBe("GOOGLE_OAUTH_PENDING");
    await expect(adapter.checkSession()).resolves.toBe("GOOGLE_OAUTH_PENDING");
    expect(fixture.state.filled).toEqual({ account: false, password: false, otp: false });
    expect(fixture.state.bodyReads).toBe(0);

    fixture.state.url = "https://www.kcex.com/futures/usdt/GPS_USDT";
    fixture.state.bodyText = "Account menu";
    fixture.state.visible = new Set(["accountMenu"]);
    await expect(adapter.checkSession()).resolves.toBe("AUTHENTICATED");
    expect(fixture.state.filled).toEqual({ account: false, password: false, otp: false });
  });

  it("exports only exact KCEX-origin browser state after OAuth", async () => {
    const context = {
      storageState: async () => ({
        cookies: [
          { name: "KCEX_SESSION", value: "fixture-kcex-session", domain: ".www.kcex.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
          { name: "SID", value: "fixture-google-session", domain: ".accounts.google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
        ],
        origins: [
          { origin: "https://www.kcex.com", localStorage: [{ name: "kcex-state", value: "fixture-kcex-local-state" }] },
          { origin: "https://accounts.google.com", localStorage: [{ name: "google-state", value: "fixture-google-local-state" }] },
        ],
      }),
    } as unknown as BrowserContext;
    const adapter = new KcexAuthAdapter({ context });
    const exported = await adapter.exportSession();
    expect(exported).toMatchObject({
      cookies: [{ name: "KCEX_SESSION", value: "fixture-kcex-session", domain: ".www.kcex.com" }],
      origins: [{ origin: "https://www.kcex.com" }],
    });
    expect(JSON.stringify(exported)).not.toContain("google");
  });
});
