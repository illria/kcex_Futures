import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { BrowserContext, Page } from "playwright";
import { launchPersistentBrowser } from "./browser/launch.js";
import { loadConfig } from "./config/schema.js";
import { logger } from "./logging/logger.js";
import { detectFuturesPage, detectLoginState } from "./kcex/state.js";
import { inspectKcexPage, openGpsFuturesPage } from "./kcex/page.js";
import type { LoginState, FuturesPageState } from "./kcex/state.js";

function printSummary(
  profileDir: string,
  login: LoginState,
  futures: FuturesPageState,
): void {
  console.log("");
  console.log("KCEX Futures Bootstrap");
  console.log("");
  console.log("Browser: READY");
  console.log("Profile: " + profileDir);
  console.log("Login: " + login.status);
  console.log("Requested Symbol: GPS_USDT");
  console.log("Page Symbol: " + (futures.symbol ?? "UNKNOWN"));
  console.log("Futures Page: " + futures.status);
  console.log("Live Trading: OFF");

  if (login.status === "LOGGED_OUT") {
    console.log(
      "Action: log in manually in the opened browser, then press Enter to re-check.",
    );
  } else if (login.status === "UNKNOWN") {
    console.log("Login detail: " + login.reason);
  }

  if (futures.status !== "READY") {
    console.log("Page detail: " + futures.reason);
  }
}

async function recheckAfterManualLogin(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await terminal.question(
      "After signing in manually in the browser, press Enter to re-check (or Ctrl+C to stop): ",
    );
    return true;
  } finally {
    terminal.close();
  }
}

async function saveDiagnosticScreenshot(page: Page): Promise<void> {
  try {
    const directory = resolve("screenshots");
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = resolve(directory, "task-001-" + timestamp + ".png");
    await page.screenshot({ path: destination, fullPage: true, timeout: 10_000 });
    logger.info({ path: destination }, "Saved a local read-only diagnostic screenshot.");
  } catch (error) {
    logger.warn({ err: error }, "Could not save a diagnostic screenshot.");
  }
}

async function inspectOnce(page: Page, baseUrl: string) {
  try {
    await openGpsFuturesPage(page, baseUrl);
  } catch (error) {
    logger.warn({ err: error }, "Could not fully navigate to the requested Futures page.");
  }

  const evidence = await inspectKcexPage(page);
  return {
    login: detectLoginState(evidence),
    futures: detectFuturesPage(evidence),
  };
}

async function run(): Promise<void> {
  const config = loadConfig();
  let context: BrowserContext | undefined;

  try {
    context = await launchPersistentBrowser(config);
    const page = context.pages()[0] ?? (await context.newPage());
    let result = await inspectOnce(page, config.KCEX_BASE_URL);

    if (
      result.login.status === "LOGGED_OUT" &&
      (await recheckAfterManualLogin())
    ) {
      result = await inspectOnce(page, config.KCEX_BASE_URL);
    }

    printSummary(config.BROWSER_PROFILE_DIR, result.login, result.futures);

    if (
      result.login.status === "UNKNOWN" ||
      result.futures.status !== "READY"
    ) {
      await saveDiagnosticScreenshot(page);
    }

    logger.info(
      {
        login: result.login.status,
        page: result.futures.status,
        symbol: result.futures.symbol,
        liveTrading: config.LIVE_TRADING,
      },
      "Read-only Task 001 inspection completed.",
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Browser startup failed. Confirm Chromium is installed with npm run browser:install.",
    );
    process.exitCode = 1;
  } finally {
    await context?.close().catch((error: unknown) => {
      logger.warn({ err: error }, "Could not close the persistent browser context cleanly.");
    });
  }
}

await run();
