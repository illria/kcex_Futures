import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium, type Locator, type Page } from "playwright";
import { KcexSelectorKeySchema, type KcexLiveSelectorManifest, type VerifiedKcexContractProfile } from "../../packages/shared/src/live-launch.js";
import { KcexExecutionAdapter } from "../../apps/server/src/kcex-live/kcex-execution-adapter.js";
import { KcexProtectionAdapter } from "../../apps/server/src/kcex-live/kcex-protection-adapter.js";
import type { TrustedPageSource } from "../../apps/server/src/futures/trusted-page-source.js";

const fixtureHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Loopback KCEX fixture</title></head>
<body>
  <div id="symbol">GPS_USDT</div><div id="last-price">1.99</div><div id="mark-price">2.00</div>
  <div id="available-usdt">1000</div><div id="margin-mode">CROSS</div><div id="leverage">5x</div>
  <div id="position-flat">No position</div><div id="position-open" hidden>Position open</div>
  <div id="open-orders" hidden>Open orders</div><div id="empty-orders">No open orders</div>
  <button id="isolated" type="button">ISOLATED</button>
  <input id="isolated-direct-input" value="CROSS">
  <input id="leverage-input" value="5"><button id="market-order" type="button" aria-pressed="false">MARKET</button>
  <button id="leverage-dialog-trigger" type="button">Leverage settings</button>
  <input id="leverage-dialog-input" value="5" hidden>
  <button id="leverage-dialog-submit" type="button" hidden>Apply leverage</button>
  <input id="margin" value="0"><input id="quantity" value="0">
  <button id="long" type="button" aria-pressed="false">Open Long</button>
  <button id="short" type="button" aria-pressed="false">Open Short</button>
  <div id="order-summary">No side selected</div>
  <button id="submit" type="button" data-submit-count="0">Submit order</button>
  <div id="rejected" hidden>Order rejected</div><div id="not-submitted" hidden>Not submitted</div>
  <input id="take-profit" value=""><input id="stop-loss" value="">
  <button id="protection-submit" type="button" data-submit-count="0">Submit TP/SL</button>
  <div id="protection-evidence" hidden></div>
  <script>
    const marginMode = document.querySelector('#margin-mode');
    const leverageInput = document.querySelector('#leverage-input');
    const quantityInput = document.querySelector('#quantity');
    const summary = document.querySelector('#order-summary');
    const long = document.querySelector('#long');
    const short = document.querySelector('#short');
    document.querySelector('#isolated').addEventListener('click', () => { marginMode.textContent = 'ISOLATED'; });
    document.querySelector('#isolated-direct-input').addEventListener('input', (event) => { marginMode.textContent = event.currentTarget.value; });
    leverageInput.addEventListener('input', () => { document.querySelector('#leverage').textContent = leverageInput.value + 'x'; });
    document.querySelector('#leverage-dialog-trigger').addEventListener('click', () => {
      document.querySelector('#leverage-dialog-input').hidden = false;
      document.querySelector('#leverage-dialog-submit').hidden = false;
    });
    document.querySelector('#leverage-dialog-submit').addEventListener('click', () => {
      document.querySelector('#leverage').textContent = document.querySelector('#leverage-dialog-input').value + 'x';
      document.querySelector('#leverage-dialog-input').hidden = true;
      document.querySelector('#leverage-dialog-submit').hidden = true;
    });
    document.querySelector('#market-order').addEventListener('click', (event) => { event.currentTarget.setAttribute('aria-pressed', 'true'); });
    const selectSide = (side) => {
      long.setAttribute('aria-pressed', String(side === 'LONG'));
      short.setAttribute('aria-pressed', String(side === 'SHORT'));
      summary.textContent = side + ' quantity: ' + quantityInput.value;
    };
    long.addEventListener('click', () => selectSide('LONG'));
    short.addEventListener('click', () => selectSide('SHORT'));
    quantityInput.addEventListener('input', () => {
      if (long.getAttribute('aria-pressed') === 'true') selectSide('LONG');
      if (short.getAttribute('aria-pressed') === 'true') selectSide('SHORT');
    });
    document.querySelector('#submit').addEventListener('click', (event) => {
      const button = event.currentTarget;
      button.dataset.submitCount = String(Number(button.dataset.submitCount) + 1);
    });
    document.querySelector('#protection-submit').addEventListener('click', (event) => {
      const button = event.currentTarget;
      button.dataset.submitCount = String(Number(button.dataset.submitCount) + 1);
      const evidence = document.querySelector('#protection-evidence');
      evidence.textContent = button.dataset.partial === 'true'
        ? 'TP ' + document.querySelector('#take-profit').value
        : 'TP ' + document.querySelector('#take-profit').value + ' SL ' + document.querySelector('#stop-loss').value;
      evidence.hidden = false;
    });
  </script>
</body></html>`;

function selectorManifest(overrides: Partial<Record<string, string>> = {}): KcexLiveSelectorManifest {
  const selectors = Object.fromEntries(KcexSelectorKeySchema.options.map((key) => [key, {
    selector: overrides[key] ?? `#${selectorId(key)}`,
    status: "VERIFIED" as const,
  }])) as KcexLiveSelectorManifest;
  return selectors;
}

function selectorId(key: string): string {
  const aliases: Record<string, string> = {
    symbol: "symbol", lastPrice: "last-price", markPrice: "mark-price", availableUsdt: "available-usdt",
    marginMode: "margin-mode", leverage: "leverage", positionOpen: "position-open", positionFlat: "position-flat",
    leverageDialogInput: "leverage-dialog-input", leverageDialogSubmit: "leverage-dialog-submit",
    openOrders: "open-orders", emptyOrders: "empty-orders", marketOrderTab: "market-order", longControl: "long",
    shortControl: "short", marginInput: "margin", quantityInput: "quantity", isolatedControl: "isolated",
    leverageControl: "leverage-input", orderSummary: "order-summary", orderSubmit: "submit", orderRejected: "rejected",
    orderNotSubmitted: "not-submitted", takeProfitControl: "take-profit", stopLossControl: "stop-loss",
    protectionSubmit: "protection-submit", protectionEvidence: "protection-evidence",
  };
  return aliases[key] ?? `unused-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function wrapLocator(locator: Locator, selector: string, onSubmit?: () => void, throwAfterSubmit = false): Locator {
  return new Proxy(locator, {
    get(target, property) {
      if (property === "click" && selector === "#submit" && onSubmit) {
        return async (...args: Parameters<Locator["click"]>) => {
          await target.click(...args);
          onSubmit?.();
          if (throwAfterSubmit) throw new Error("Fixture submit response timed out after click.");
        };
      }
      if (property === "nth") return (index: number) => wrapLocator(target.nth(index), selector, onSubmit, throwAfterSubmit);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeTrustedPage(page: Page, options: { untrusted?: boolean; redirectAfterSubmit?: () => void; throwAfterSubmit?: boolean } = {}): Page {
  let url = options.untrusted ? "https://evil.example.invalid/login" : "https://www.kcex.com/futures/usdt/GPS_USDT";
  return new Proxy(page, {
    get(target, property) {
      if (property === "url") return () => url;
      if (property === "locator") return (selector: string) => wrapLocator(target.locator(selector), selector, () => {
        options.redirectAfterSubmit?.();
        if (options.redirectAfterSubmit) url = "https://evil.example.invalid/after-submit";
      }, options.throwAfterSubmit);
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeProfile(overrides: Partial<VerifiedKcexContractProfile> = {}): VerifiedKcexContractProfile {
  return {
    status: "VERIFIED" as const,
    symbol: "GPS_USDT" as const,
    quantityUnit: "GPS" as const,
    contractSize: null,
    quantityStep: 0.1,
    minQuantity: 0.1,
    maxQuantity: 100_000,
    minNotionalUsdt: null,
    maxNotionalUsdt: null,
    quantityPrecision: 1,
    pricePrecision: 2,
    tickSize: 0.01,
    marginModeSemantics: "MENU_OPTION" as const,
    leverageSemantics: "DIRECT_INPUT" as const,
    marketOrderSemantics: "TAB_CONTROL" as const,
    takeProfitStopLossSemantics: "TARGET_PRICE_INPUT" as const,
    maximumNotionalDeviationBps: 100,
    verifiedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

async function main(): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind to loopback.");
  const unexpectedOutbound: string[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (["127.0.0.1", "localhost", "::1"].includes(requestUrl.hostname)) {
      await route.continue();
      return;
    }
    unexpectedOutbound.push(requestUrl.href);
    await route.abort();
  });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/fixture`, { waitUntil: "domcontentloaded" });
    const selectors = selectorManifest();
    const source: TrustedPageSource = {
      withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>) => operation(makeTrustedPage(page)),
    };
    const adapter = new KcexExecutionAdapter({
      pageSource: source,
      selectors,
      contractProfile: makeProfile(),
      isRuntimeAuthorized: () => true,
      getBlockReasons: () => [],
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });

    const long = await adapter.submit({
      attemptId: "11111111-1111-4111-8111-111111111111",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(long.status, "SUBMITTED", "LONG fixture should pass all final evidence gates");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "1");
    assert.equal(await page.locator("#margin-mode").innerText(), "ISOLATED");
    assert.equal(await page.locator("#leverage").innerText(), "10x");
    assert.match(await page.locator("#order-summary").innerText(), /^LONG quantity: 250\.0$/);

    const duplicate = await adapter.submit({
      attemptId: "11111111-1111-4111-8111-111111111111",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(duplicate.status, "UNKNOWN", "the same attempt id cannot submit twice");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "1");

    const short = await adapter.submit({
      attemptId: "22222222-2222-4222-8222-222222222222",
      side: "SHORT",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(short.status, "SUBMITTED", "SHORT maps through its verified selector");
    assert.match(await page.locator("#order-summary").innerText(), /^SHORT quantity: 250\.0$/);
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "2");

    await page.locator("#margin-mode").evaluate((element) => { element.textContent = "CROSS"; });
    const directMarginSelectors = selectorManifest({ isolatedControl: "#isolated-direct-input" });
    const directMarginAdapter = new KcexExecutionAdapter({
      pageSource: source,
      selectors: directMarginSelectors,
      contractProfile: makeProfile({ marginModeSemantics: "DIRECT_INPUT" }),
      isRuntimeAuthorized: () => true,
      getBlockReasons: () => [],
    });
    const directMargin = await directMarginAdapter.submit({
      attemptId: "77777777-7777-4777-8777-777777777777",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(directMargin.status, "SUBMITTED", "verified direct-input margin mode semantics use the input control");
    assert.equal(await page.locator("#margin-mode").innerText(), "ISOLATED");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "3");

    await page.locator("#leverage").evaluate((element) => { element.textContent = "5x"; });
    await page.locator("#market-order").evaluate((element) => { element.setAttribute("aria-pressed", "false"); });
    const dialogLeverageSelectors = selectorManifest({ leverageControl: "#leverage-dialog-trigger" });
    const dialogLeverageAdapter = new KcexExecutionAdapter({
      pageSource: source,
      selectors: dialogLeverageSelectors,
      contractProfile: makeProfile({ leverageSemantics: "DIALOG_INPUT", marketOrderSemantics: "ORDER_TYPE_SELECTOR" }),
      isRuntimeAuthorized: () => true,
      getBlockReasons: () => [],
    });
    const dialogLeverage = await dialogLeverageAdapter.submit({
      attemptId: "88888888-8888-4888-8888-888888888888",
      side: "SHORT",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(dialogLeverage.status, "SUBMITTED", "verified dialog leverage semantics use the separate dialog controls");
    assert.equal(await page.locator("#leverage").innerText(), "10x");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "4");

    await page.locator("#symbol").evaluate((element) => { element.textContent = "OTHER_USDT"; });
    const wrongSymbol = await adapter.submit({
      attemptId: "99999999-9999-4999-8999-999999999999",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(wrongSymbol.status, "FAILED_NOT_SUBMITTED", "wrong symbol blocks before submit");
    await page.locator("#symbol").evaluate((element) => { element.textContent = "GPS_USDT"; });

    await page.locator("#position-flat").evaluate((element) => { (element as HTMLElement).hidden = true; });
    await page.locator("#position-open").evaluate((element) => { (element as HTMLElement).hidden = false; });
    const alreadyOpen = await adapter.submit({
      attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(alreadyOpen.status, "FAILED_NOT_SUBMITTED", "an existing position blocks entry");
    await page.locator("#position-flat").evaluate((element) => { (element as HTMLElement).hidden = false; });
    await page.locator("#position-open").evaluate((element) => { (element as HTMLElement).hidden = true; });

    await page.locator("#submit").evaluate((element) => { (element as HTMLElement).hidden = true; });
    const missingSubmit = await adapter.submit({
      attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(missingSubmit.status, "FAILED_NOT_SUBMITTED", "a missing submit control blocks without mutation");
    await page.locator("#submit").evaluate((element) => { (element as HTMLElement).hidden = false; });
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "4");

    const blockedPageSource: TrustedPageSource = {
      withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>) => operation(makeTrustedPage(page, { untrusted: true })),
    };
    const untrustedAdapter = new KcexExecutionAdapter({
      pageSource: blockedPageSource,
      selectors,
      contractProfile: makeProfile(),
      isRuntimeAuthorized: () => true,
      getBlockReasons: () => [],
    });
    const untrusted = await untrustedAdapter.submit({
      attemptId: "33333333-3333-4333-8333-333333333333",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(untrusted.status, "UNKNOWN", "an untrusted page is not order evidence");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "4");

    const redirectingSource: TrustedPageSource = {
      withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>) => operation(makeTrustedPage(page, {
        redirectAfterSubmit: () => undefined,
      })),
    };
    const redirectingAdapter = new KcexExecutionAdapter({
      pageSource: redirectingSource,
      selectors,
      contractProfile: makeProfile(),
      isRuntimeAuthorized: () => true,
      getBlockReasons: () => [],
    });
    const redirected = await redirectingAdapter.submit({
      attemptId: "44444444-4444-4444-8444-444444444444",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(redirected.status, "UNKNOWN", "a redirect after the single submit has an ambiguous outcome");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "5");
    const redirectedRetry = await redirectingAdapter.submit({
      attemptId: "44444444-4444-4444-8444-444444444444",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(redirectedRetry.status, "UNKNOWN", "an ambiguous submit attempt cannot be retried");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "5");

    const timeoutSource: TrustedPageSource = {
      withTrustedPage: async <T>(operation: (trustedPage: Page) => Promise<T>) => operation(makeTrustedPage(page, { throwAfterSubmit: true })),
    };
    const timeoutAdapter = new KcexExecutionAdapter({
      pageSource: timeoutSource,
      selectors,
      contractProfile: makeProfile(),
      isRuntimeAuthorized: () => true,
      getBlockReasons: () => [],
    });
    const timedOut = await timeoutAdapter.submit({
      attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(timedOut.status, "UNKNOWN", "a submit timeout after click is ambiguous");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "6");
    const timeoutRetry = await timeoutAdapter.submit({
      attemptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      side: "LONG",
      dueAt: "2026-10-01T00:00:00.000Z",
      marginUsdt: 50,
    });
    assert.equal(timeoutRetry.status, "UNKNOWN", "an ambiguous timed out attempt cannot be retried");
    assert.equal(await page.locator("#submit").getAttribute("data-submit-count"), "6");

    await page.locator("#position-flat").evaluate((element) => { (element as HTMLElement).hidden = true; });
    await page.locator("#position-open").evaluate((element) => { (element as HTMLElement).hidden = false; });
    const protectionInput = {
      executionAttemptId: "55555555-5555-4555-8555-555555555555",
      symbol: "GPS_USDT" as const,
      side: "LONG" as const,
      entryPrice: 2,
      positionSize: 250,
      leverage: 10 as const,
      takeProfit: { basis: "PRICE_PCT" as const, value: 1 },
      stopLoss: { basis: "PRICE_PCT" as const, value: 1 },
    };
    let plannedProtections = 0;
    const protectionAdapter = new KcexProtectionAdapter({
      pageSource: source,
      selectors,
      profile: makeProfile(),
      readPosition: async () => ({
        symbol: "GPS_USDT",
        side: "LONG",
        entryPrice: 2,
        size: 250,
        observedAt: "2026-10-01T00:00:00.000Z",
        fresh: true,
      }),
      persistPlanned: async () => { plannedProtections += 1; },
      verifyProtection: async (trustedPage) => {
        return await trustedPage.locator("#protection-evidence").innerText() === "TP 2.02 SL 1.98";
      },
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });
    const protection = await protectionAdapter.activate(protectionInput);
    assert.equal(protection.status, "ACTIVE", "TP and SL become active only with read-back evidence");
    assert.equal(await page.locator("#take-profit").inputValue(), "2.02");
    assert.equal(await page.locator("#stop-loss").inputValue(), "1.98");
    assert.equal(await page.locator("#protection-submit").getAttribute("data-submit-count"), "1");
    assert.equal(plannedProtections, 1, "the protection plan is persisted before fixture mutation");

    const ambiguousProtectionAdapter = new KcexProtectionAdapter({
      pageSource: source,
      selectors,
      profile: makeProfile(),
      readPosition: async () => ({
        symbol: "GPS_USDT",
        side: "LONG",
        entryPrice: 2,
        size: 250,
        observedAt: "2026-10-01T00:00:00.000Z",
        fresh: true,
      }),
      persistPlanned: async () => { plannedProtections += 1; },
      verifyProtection: async (trustedPage) => {
        const evidenceText = await trustedPage.locator("#protection-evidence").innerText();
        return evidenceText.includes("TP 2.02") && evidenceText.includes("SL 1.98");
      },
      now: () => new Date("2026-10-01T00:00:00.000Z"),
    });
    const ambiguousProtectionInput = { ...protectionInput, executionAttemptId: "66666666-6666-4666-8666-666666666666" };
    await page.locator("#protection-submit").evaluate((element) => { (element as HTMLElement).dataset.partial = "true"; });
    const ambiguousProtection = await ambiguousProtectionAdapter.activate(ambiguousProtectionInput);
    assert.equal(ambiguousProtection.status, "UNKNOWN", "missing TP/SL evidence is an ambiguous mutation outcome");
    assert.equal(await page.locator("#protection-evidence").innerText(), "TP 2.02", "the fixture simulates TP evidence without SL evidence");
    assert.equal(await page.locator("#protection-submit").getAttribute("data-submit-count"), "2");
    const duplicateProtection = await ambiguousProtectionAdapter.activate(ambiguousProtectionInput);
    assert.equal(duplicateProtection.status, "FAILED_NOT_SUBMITTED", "an ambiguous protection attempt cannot be submitted twice");
    assert.equal(await page.locator("#protection-submit").getAttribute("data-submit-count"), "2");
    assert.equal(plannedProtections, 2);

    assert.deepEqual(unexpectedOutbound, [], "the browser fixture must not make any non-loopback request");
    process.stdout.write("TASK-013 live adapter browser fixtures passed: LONG/SHORT, verified margin/leverage semantics, quantity, wrong symbol, open position, missing submit, untrusted host, submit timeout, TP/SL, partial protection ambiguity, duplicate prevention, loopback-only network.\n");
  } finally {
    await context.close();
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "TASK-013 live fixture failed."}\n`);
  process.exitCode = 1;
});
