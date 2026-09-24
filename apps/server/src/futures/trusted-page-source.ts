import type { Page } from "playwright";
import type { AuthStatus } from "../../../../packages/shared/src/protocol.js";
import { KcexAuthAdapter } from "../auth/kcex-auth-adapter.js";

export interface TrustedPageSource {
  withTrustedPage<T>(operation: (page: Page) => Promise<T>): Promise<T>;
}

/**
 * Read-only consumers share the already authenticated adapter page. They do
 * not create a second browser or receive credentials/storage state.
 */
export class KcexAuthenticatedPageSource implements TrustedPageSource {
  constructor(
    private readonly adapter: KcexAuthAdapter,
    private readonly authStatus: () => AuthStatus,
  ) {}

  async withTrustedPage<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    if (this.authStatus() !== "AUTHENTICATED") {
      throw new Error("A trusted authenticated KCEX session is required for read-only extraction.");
    }
    return this.adapter.withTrustedPage(operation);
  }
}
