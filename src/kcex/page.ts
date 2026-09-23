import type { Page } from "playwright";
import type { PageEvidence } from "./evidence.js";
import { KCEX_SELECTORS } from "./selectors.js";
import { DEFAULT_KCEX_BASE_URL, buildGpsUsdtFuturesUrl } from "./urls.js";

async function hasVisibleMatch(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector);
  const count = await locator.count();

  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }

  return false;
}

async function readVisibleTexts(page: Page, selector: string): Promise<string[]> {
  const locator = page.locator(selector);
  const count = await locator.count();
  const values: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false))) continue;

    const value = (await item.innerText().catch(() => item.textContent()))
      ?.trim();
    if (value) values.push(value);
  }

  return values;
}

export async function openGpsFuturesPage(
  page: Page,
  baseUrl: string = DEFAULT_KCEX_BASE_URL,
): Promise<void> {
  await page.goto(buildGpsUsdtFuturesUrl(baseUrl), {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
}

export async function inspectKcexPage(page: Page): Promise<PageEvidence> {
  const [visibleText, accountMenuVisible, loginFormVisible, loginControlVisible, symbolLabels] =
    await Promise.all([
      page.locator("body").innerText().catch(() => ""),
      hasVisibleMatch(page, KCEX_SELECTORS.accountMenu),
      hasVisibleMatch(page, KCEX_SELECTORS.loginForm),
      hasVisibleMatch(page, KCEX_SELECTORS.loginControl),
      readVisibleTexts(page, KCEX_SELECTORS.symbolLabel),
    ]);

  return {
    url: page.url(),
    visibleText,
    accountMenuVisible,
    loginFormVisible,
    loginControlVisible,
    symbolLabels,
  };
}
