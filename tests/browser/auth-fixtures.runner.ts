import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { installLoopbackOnlyGuard } from "./loopback-guard.js";

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
  let evilContext: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext();
    await installLoopbackOnlyGuard(context);

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
      await installLoopbackOnlyGuard(restoredContext);
      const restoredPage = await restoredContext.newPage();
      await restoredPage.goto(`${fixture.baseUrl}/authenticated.html`);
      assert(await restoredPage.locator('[data-testid="account-menu"]').isVisible(), "storage-state restore fixture failed");
    } finally {
      await closeContext(restoredContext);
    }

    const expectedBlockedUrls = ["https://evil.example.invalid/credential-capture"];
    const blockedUrls: string[] = [];
    const unexpectedUrls: string[] = [];
    evilContext = await browser.newContext();
    await installLoopbackOnlyGuard(evilContext, { expectedBlockedUrls, blockedUrls, unexpectedUrls });
    const evilPage = await evilContext.newPage();
    await evilPage.goto(`${fixture.baseUrl}/evil-redirect.html`).catch(() => undefined);
    assert(unexpectedUrls.length === 0, `unexpected outbound request(s): ${unexpectedUrls.join(", ")}`);
    assert(blockedUrls.length === 1, `expected one blocked URL, received ${blockedUrls.length}`);
    assert(blockedUrls[0] === expectedBlockedUrls[0], `unexpected blocked URL: ${blockedUrls[0] ?? "<none>"}`);
    console.log("BROWSER_FIXTURE_TESTS=4");
  } finally {
    if (evilContext) await closeContext(evilContext);
    if (context) await closeContext(context);
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolvePromise) => fixture.server.close(() => resolvePromise()));
  }
}

await run();
