import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type BrowserContextOptions } from "playwright";
import type { AppConfig } from "../config/schema.js";

/** TASK-001 scaffold only; TASK-003 should prefer encrypted storage state. */
export async function launchPersistentBrowser(
  config: AppConfig,
): Promise<BrowserContext> {
  const profilePath = resolve(config.BROWSER_PROFILE_DIR);
  await mkdir(profilePath, { recursive: true, mode: 0o700 });

  return chromium.launchPersistentContext(profilePath, {
    headless: config.BROWSER_HEADLESS,
    viewport: { width: 1440, height: 960 },
  });
}

/**
 * TASK-003 auth sessions use an in-memory browser context. The caller may pass
 * decrypted storageState for one context creation; it is never written here.
 */
export async function launchEphemeralBrowserContext(
  config: AppConfig,
  storageState?: BrowserContextOptions["storageState"],
): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
  const browser = await chromium.launch({
    headless: config.BROWSER_HEADLESS,
  });
  const context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 960 },
  });
  return {
    context,
    close: async () => {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
