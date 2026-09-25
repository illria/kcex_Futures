import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { KcexFuturesReadAdapter } from "../../apps/server/src/futures/kcex-futures-read-adapter.js";
import { assertTrustedKcexUrl } from "../../src/kcex/trusted-host.js";
import { installLoopbackOnlyGuard } from "./loopback-guard.js";

const fixtureRoot = resolve(process.cwd(), "tests/fixtures/futures");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/evil-redirect.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end('<script>window.location.assign("https://evil.example.invalid/credential-capture")</script>');
      return;
    }
    const fileName = pathname.replace(/^\/+/, "");
    if (!/^[a-z-]+\.html$/.test(fileName)) {
      response.writeHead(404).end();
      return;
    }
    try {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(resolve(fixtureRoot, fileName)));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeContext(context: BrowserContext | undefined): Promise<void> {
  await context?.close().catch(() => undefined);
}

async function readTrustedFixture(page: Page, symbol = "GPS_USDT") {
  const trustedUrl = `https://www.kcex.com/futures/exchange/${symbol}`;
  const logicalPage = {
    url: () => trustedUrl,
    locator: page.locator.bind(page),
  } as unknown as Page;
  const source = {
    withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>) => {
      assertTrustedKcexUrl(logicalPage.url());
      const result = await operation(logicalPage);
      assertTrustedKcexUrl(logicalPage.url());
      return result;
    },
  };
  return new KcexFuturesReadAdapter(source).readSnapshot();
}

async function run(): Promise<void> {
  const fixture = await startFixtureServer();
  let browser: Browser | undefined;
  let mainContext: BrowserContext | undefined;
  let restoredContext: BrowserContext | undefined;
  let evilContext: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    mainContext = await browser.newContext();
    await installLoopbackOnlyGuard(mainContext);
    const page = await mainContext.newPage();
    await page.goto(`${fixture.baseUrl}/gps-normal.html`);
    const normal = await readTrustedFixture(page);
    assert(normal.status === "READY", `normal futures fixture was not READY: ${normal.status}`);
    assert(normal.snapshot?.position.side === "LONG", "normal position was not read");

    await page.goto(`${fixture.baseUrl}/gps-partial.html`);
    const partial = await readTrustedFixture(page);
    assert(partial.status === "PARTIAL", `partial fixture was not PARTIAL: ${partial.status}`);

    const storageState = await mainContext.storageState();
    restoredContext = await browser.newContext({ storageState });
    await installLoopbackOnlyGuard(restoredContext);
    const restoredPage = await restoredContext.newPage();
    await restoredPage.goto(`${fixture.baseUrl}/gps-no-orders.html`);
    const restored = await readTrustedFixture(restoredPage);
    assert(restored.snapshot?.openOrders.orders.length === 0, "restored fixture did not preserve no-orders evidence");

    const expectedBlockedUrls = ["https://evil.example.invalid/credential-capture"];
    const blockedUrls: string[] = [];
    const unexpectedUrls: string[] = [];
    evilContext = await browser.newContext();
    await installLoopbackOnlyGuard(evilContext, { expectedBlockedUrls, blockedUrls, unexpectedUrls });
    const evilPage = await evilContext.newPage();
    await evilPage.goto(`${fixture.baseUrl}/evil-redirect.html`).catch(() => undefined);
    assert(unexpectedUrls.length === 0, `unexpected outbound request(s): ${unexpectedUrls.join(", ")}`);
    assert(blockedUrls.length === 1 && blockedUrls[0] === expectedBlockedUrls[0], `unexpected blocked URL set: ${blockedUrls.join(", ")}`);
    console.log("FUTURES_FIXTURE_TESTS=4");
  } finally {
    await closeContext(evilContext);
    await closeContext(restoredContext);
    await closeContext(mainContext);
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolvePromise) => fixture.server.close(() => resolvePromise()));
  }
}

await run();
