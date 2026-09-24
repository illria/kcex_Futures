import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../../apps/server/src/auth/auth-service.js";
import type { AuthAdapter, AuthAdapterResult, AuthCredentials } from "../../apps/server/src/auth/auth-adapter.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { EncryptedSessionStore } from "../../apps/server/src/session/encrypted-session-store.js";
import { EncryptedCredentialVault } from "../../apps/server/src/vault/encrypted-vault.js";

const MASTER_KEY = "task003-auth-master-key-fixture";

class SessionFixtureAdapter implements AuthAdapter {
  readonly provider = "KCEX" as const;
  constructor(private readonly restored: AuthAdapterResult = "AUTHENTICATED") {}
  async login(_credentials: AuthCredentials): Promise<AuthAdapterResult> { return "AUTHENTICATED"; }
  async submitOtp(_candidate: Buffer): Promise<AuthAdapterResult> { return "AUTHENTICATED"; }
  async checkSession(): Promise<AuthAdapterResult> { return this.restored; }
  async restoreSession(_storageState: unknown): Promise<AuthAdapterResult> { return this.restored; }
  async exportSession(): Promise<unknown> { return { cookies: [{ name: "fixture", value: "encrypted-only" }], origins: [] }; }
}

describe("TASK-003 auth session restore", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => Promise.all(cleanup.splice(0).map((fn) => fn())));

  it("restores a valid encrypted session after vault unlock and clears an invalid one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kcex-task003-auth-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const vaultPath = join(directory, "credentials.vault.json");
    const sessionPath = join(directory, "session.enc.json");
    const firstVault = new EncryptedCredentialVault(vaultPath);
    const firstStore = new EncryptedSessionStore(firstVault, sessionPath);
    const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
    const first = new AuthService(firstVault, new EventBus(), logger, new SessionFixtureAdapter(), undefined, undefined, firstStore);
    await first.unlock(MASTER_KEY);
    await first.saveCredentials("fixture@example.test", "fixture-password", true);
    expect((await first.login()).status).toBe("AUTHENTICATED");
    first.close();

    const restoredVault = new EncryptedCredentialVault(vaultPath);
    const restored = new AuthService(
      restoredVault,
      new EventBus(),
      logger,
      new SessionFixtureAdapter("AUTHENTICATED"),
      undefined,
      undefined,
      new EncryptedSessionStore(restoredVault, sessionPath),
    );
    expect((await restored.unlock(MASTER_KEY)).status).toBe("AUTHENTICATED");
    restored.close();

    const failedVault = new EncryptedCredentialVault(vaultPath);
    const failedStore = new EncryptedSessionStore(failedVault, sessionPath);
    const failed = new AuthService(
      failedVault,
      new EventBus(),
      logger,
      new SessionFixtureAdapter("SESSION_LOST"),
      undefined,
      undefined,
      failedStore,
    );
    expect((await failed.unlock(MASTER_KEY)).status).toBe("VAULT_UNLOCKED");
    expect(await failedStore.hasSession()).toBe(false);
    failed.close();
  });
});
