import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "playwright";
import { KCEX_SELECTORS } from "../../../../src/kcex/selectors.js";
import { assertTrustedKcexBaseUrl, assertTrustedKcexUrl } from "../../../../src/kcex/trusted-host.js";
import { buildGpsUsdtFuturesUrl, DEFAULT_KCEX_BASE_URL } from "../../../../src/kcex/urls.js";
import type { AuthAdapter, AuthAdapterResult, AuthCredentials } from "./auth-adapter.js";

export interface KcexAuthAdapterOptions {
  baseUrl?: string;
  headless?: boolean;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
}

async function visibleLocator(page: Page, selector: string): Promise<Locator | null> {
  const locator = page.locator(selector);
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function visibleText(page: Page): Promise<string> {
  return page.locator("body").innerText().catch(() => "");
}

/**
 * KCEX page automation is deliberately isolated behind this adapter. The
 * selectors are fixture-friendly candidates and are marked deferred until a
 * user-approved manual DOM review confirms them.
 */
export class KcexAuthAdapter implements AuthAdapter {
  readonly provider = "KCEX" as const;
  private browser: Browser | null;
  private context: BrowserContext | null;
  private page: Page | null;
  private readonly ownsBrowser: boolean;
  private readonly ownsContext: boolean;
  private readonly baseUrl: string;
  private readonly loginUrl: string;
  private readonly headless: boolean;

  constructor(options: KcexAuthAdapterOptions = {}) {
    this.browser = options.browser ?? null;
    this.context = options.context ?? null;
    this.page = options.page ?? null;
    this.ownsBrowser = !options.browser && !options.page && !options.context;
    this.ownsContext = !options.context && !options.page;
    this.headless = options.headless ?? true;
    this.baseUrl = options.baseUrl ?? DEFAULT_KCEX_BASE_URL;
    assertTrustedKcexBaseUrl(this.baseUrl);
    this.loginUrl = new URL("/login", this.baseUrl).toString();
  }

  async login(credentials: AuthCredentials): Promise<AuthAdapterResult> {
    try {
      const page = await this.ensurePage();
      await page.goto(this.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      // The final URL is the security boundary. No DOM marker may influence
      // the auth result until the redirected page has passed this check.
      this.assertTrustedPage(page);
      const initial = await this.detectResult(page, false);
      if (initial === "AUTHENTICATED" || initial === "MANUAL_CHALLENGE" || initial === "OTP_REQUIRED") {
        return initial;
      }

      const accountInput = await visibleLocator(page, KCEX_SELECTORS.accountInput);
      const passwordInput = await visibleLocator(page, KCEX_SELECTORS.passwordInput);
      const submit = await visibleLocator(page, KCEX_SELECTORS.loginSubmit);
      if (!accountInput || !passwordInput || !submit) return "AUTH_UNKNOWN";

      this.assertTrustedPage(page);
      await accountInput.fill(credentials.account);
      this.assertTrustedPage(page);
      await passwordInput.fill(credentials.password);
      this.assertTrustedPage(page);
      await submit.click({ timeout: 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      this.assertTrustedPage(page);
      return this.detectResult(page, true);
    } catch {
      return "AUTH_UNKNOWN";
    }
  }

  async submitOtp(candidate: Buffer): Promise<AuthAdapterResult> {
    let code = "";
    try {
      const page = this.page;
      if (!page) return "AUTH_UNKNOWN";
      this.assertTrustedPage(page);
      const input = await visibleLocator(page, KCEX_SELECTORS.otpInput);
      const submit = await visibleLocator(page, KCEX_SELECTORS.otpSubmit);
      if (!input || !submit) return "AUTH_UNKNOWN";
      code = candidate.toString("utf8");
      this.assertTrustedPage(page);
      await input.fill(code);
      this.assertTrustedPage(page);
      await submit.click({ timeout: 10_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      this.assertTrustedPage(page);
      return this.detectResult(page, true);
    } catch {
      return "AUTH_UNKNOWN";
    } finally {
      code = "";
    }
  }

  async checkSession(): Promise<AuthAdapterResult> {
    try {
      if (!this.page) return "AUTH_UNKNOWN";
      this.assertTrustedPage(this.page);
      const result = await this.detectResult(this.page, false);
      if (result === "AUTHENTICATED") return result;
      if (result === "MANUAL_CHALLENGE" || result === "AUTH_UNKNOWN") return result;
      return "SESSION_LOST";
    } catch {
      return "AUTH_UNKNOWN";
    }
  }

  async restoreSession(storageState: unknown): Promise<AuthAdapterResult> {
    try {
      await this.resetOwnedContext();
      const page = await this.ensurePage(storageState);
      await page.goto(buildGpsUsdtFuturesUrl(this.baseUrl), {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      this.assertTrustedPage(page);
      return this.checkSession();
    } catch {
      return "AUTH_UNKNOWN";
    }
  }

  async exportSession(): Promise<unknown> {
    if (!this.context) return null;
    return this.context.storageState();
  }

  async close(): Promise<void> {
    if (this.ownsContext) await this.context?.close().catch(() => undefined);
    if (this.ownsBrowser) await this.browser?.close().catch(() => undefined);
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  private async ensurePage(storageState?: unknown): Promise<Page> {
    if (this.page && storageState === undefined) return this.page;
    if (!this.browser && !this.context) this.browser = await chromium.launch({ headless: this.headless });
    if (!this.context || storageState !== undefined) {
      if (this.context && this.ownsContext) await this.context.close().catch(() => undefined);
      if (!this.browser) throw new Error("A browser is required to create a KCEX context.");
      this.context = await this.browser.newContext({
        storageState: storageState as BrowserContextOptions["storageState"],
        viewport: { width: 1440, height: 960 },
      });
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    return this.page;
  }

  private async resetOwnedContext(): Promise<void> {
    if (this.ownsContext && this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
    }
  }

  private assertTrustedPage(page: Page): void {
    assertTrustedKcexUrl(page.url());
  }

  private async detectResult(page: Page, afterSubmit: boolean): Promise<AuthAdapterResult> {
    const text = await visibleText(page);
    const captcha = await visibleLocator(page, KCEX_SELECTORS.captcha);
    if (captcha || /captcha|security\s+check|verify\s+you\s+are\s+human|robot|安全验证/i.test(text)) {
      return "MANUAL_CHALLENGE";
    }

    const accountMenu = await visibleLocator(page, KCEX_SELECTORS.accountMenu);
    if (accountMenu || /\b(log\s*out|sign\s*out)\b|退出登录|退出账号/i.test(text)) {
      return "AUTHENTICATED";
    }

    const otpInput = await visibleLocator(page, KCEX_SELECTORS.otpInput);
    if (otpInput || /email\s+verification|verification\s+code|one[- ]time\s+code|邮箱验证码/i.test(text)) {
      return "OTP_REQUIRED";
    }

    if (afterSubmit) {
      const loginError = await visibleLocator(page, KCEX_SELECTORS.loginError);
      if (loginError || /invalid|incorrect|failed|密码错误|登录失败/i.test(text)) return "AUTH_FAILED";
      const loginForm = await visibleLocator(page, KCEX_SELECTORS.loginForm);
      if (loginForm) return "AUTH_FAILED";
    }

    return "AUTH_UNKNOWN";
  }
}
