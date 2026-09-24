import type { BrowserContext } from "playwright";

export interface LoopbackGuardOptions {
  expectedBlockedUrls?: readonly string[];
  blockedUrls?: string[];
  unexpectedUrls?: string[];
}

export async function installLoopbackOnlyGuard(
  context: BrowserContext,
  options: LoopbackGuardOptions = {},
): Promise<void> {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    let hostname = "";
    try {
      hostname = new URL(requestUrl).hostname;
    } catch {
      await route.abort();
      options.unexpectedUrls?.push(requestUrl);
      throw new Error(`Non-loopback browser request blocked: ${requestUrl}`);
    }
    if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
      await route.continue();
      return;
    }

    await route.abort();
    if (options.expectedBlockedUrls?.includes(requestUrl)) {
      options.blockedUrls?.push(requestUrl);
      return;
    }
    options.unexpectedUrls?.push(requestUrl);
    throw new Error(`Unexpected non-loopback browser request blocked: ${requestUrl}`);
  });
}
