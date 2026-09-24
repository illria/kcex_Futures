import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";

const fixtureRoot = resolve(process.cwd(), "tests/fixtures/auth");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname).replace(/^\/+/, "");
    const fileName = requested || "unknown.html";
    if (!/^[a-z-]+\.html$/.test(fileName)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(resolve(fixtureRoot, fileName));
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => undefined);
}

async function run(): Promise<void> {
  const fixture = await startFixtureServer();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let externalAttempt = false;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await context.route("**/*", async (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        externalAttempt = true;
        await route.abort();
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/login.html`);
    assert(await page.locator('[data-testid="login-form"]').isVisible(), "login fixture was not rendered");
    await page.fill('input[name="email"]', "fixture@example.test");
    await page.fill('input[name="password"]', "fixture-password");
    await page.click('[data-testid="login-submit"]');
    await page.waitForURL(`${fixture.baseUrl}/otp.html`);
    assert(await page.locator('input[autocomplete="one-time-code"]').isVisible(), "OTP fixture was not rendered");
    await page.fill('input[name="code"]', "000000");
    await page.click('[data-testid="otp-submit"]');
    await page.waitForURL(`${fixture.baseUrl}/authenticated.html`);
    assert(await page.locator('[data-testid="account-menu"]').isVisible(), "authenticated fixture was not detected");

    await page.goto(`${fixture.baseUrl}/failed.html`);
    assert(await page.locator('[role="alert"]').isVisible(), "failed fixture was not rendered");
    await page.goto(`${fixture.baseUrl}/captcha.html`);
    assert(await page.locator('[data-testid="captcha"]').isVisible(), "captcha fixture was not rendered");
    await page.goto(`${fixture.baseUrl}/unknown.html`);
    assert((await page.locator("body").innerText()).includes("without authentication evidence"), "unknown fixture was not rendered");

    await page.goto(`${fixture.baseUrl}/authenticated.html`);
    await context.addCookies([{ name: "fixture_session", value: "fixture-only", domain: "127.0.0.1", path: "/" }]);
    const storageState = await context.storageState();
    const restoredContext = await browser.newContext({ storageState });
    try {
      const restoredPage = await restoredContext.newPage();
      await restoredPage.goto(`${fixture.baseUrl}/authenticated.html`);
      assert(await restoredPage.locator('[data-testid="account-menu"]').isVisible(), "storage-state restore fixture failed");
    } finally {
      await closeContext(restoredContext);
    }

    await page.goto(`${fixture.baseUrl}/evil-redirect.html`).catch(() => undefined);
    assert(externalAttempt, "network guard did not observe the blocked external redirect");
    console.log("BROWSER_FIXTURE_TESTS=4");
  } finally {
    if (context) await closeContext(context);
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolvePromise) => fixture.server.close(() => resolvePromise()));
  }
}

await run();
