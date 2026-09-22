import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { AppConfig } from "../config/schema.js";

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
