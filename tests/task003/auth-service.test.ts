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
  constructor(
    private readonly restored: AuthAdapterResult = "AUTHENTICATED",
    private readonly loginResult: AuthAdapterResult = "AUTHENTICATED",
  ) {}
  async login(_credentials: AuthCredentials): Promise<AuthAdapterResult> { return this.loginResult; }
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

  it.each([
    ["SESSION_LOST", "VAULT_UNLOCKED", false],
    ["AUTH_FAILED", "VAULT_UNLOCKED", false],
    ["MANUAL_CHALLENGE", "MANUAL_CHALLENGE", true],
    ["AUTH_UNKNOWN", "AUTH_UNKNOWN", true],
    ["OTP_REQUIRED", "OTP_REQUIRED", true],
  ] as const)("preserves the fail-closed restore result %s", async (restoredResult, expectedStatus, keepsSession) => {
    const directory = await mkdtemp(join(tmpdir(), "kcex-task003-auth-result-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const vaultPath = join(directory, "credentials.vault.json");
    const sessionPath = join(directory, "session.enc.json");
    const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

    const seedVault = new EncryptedCredentialVault(vaultPath);
    const seedStore = new EncryptedSessionStore(seedVault, sessionPath);
    const seed = new AuthService(seedVault, new EventBus(), logger, new SessionFixtureAdapter(), undefined, undefined, seedStore);
    await seed.unlock(MASTER_KEY);
    await seed.saveCredentials("fixture@example.test", "fixture-password", true);
    expect((await seed.login()).status).toBe("AUTHENTICATED");
    seed.close();

    const restoredVault = new EncryptedCredentialVault(vaultPath);
    const restoredStore = new EncryptedSessionStore(restoredVault, sessionPath);
    const service = new AuthService(
      restoredVault,
      new EventBus(),
      logger,
      new SessionFixtureAdapter(restoredResult),
      60_000,
      Date.now,
      restoredStore,
    );
    expect((await service.unlock(MASTER_KEY)).status).toBe(expectedStatus);
    expect(await restoredStore.hasSession()).toBe(keepsSession);
    if (restoredResult === "OTP_REQUIRED") {
      expect((await service.submitOtp(Buffer.from("123456", "utf8"))).status).toBe("AUTHENTICATED");
    }
    service.close();
  });

  it("emits SUBMITTING_OTP while an OTP candidate is being submitted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kcex-task003-auth-otp-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const vault = new EncryptedCredentialVault(join(directory, "credentials.vault.json"));
    const events = new EventBus();
    const statuses: string[] = [];
    const unsubscribe = events.subscribe((event) => {
      if (event.type === "auth.state") statuses.push(event.payload.status);
    });
    const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
    const service = new AuthService(vault, events, logger, new SessionFixtureAdapter("AUTHENTICATED", "OTP_REQUIRED"));
    await service.unlock(MASTER_KEY);
    await service.saveCredentials("fixture@example.test", "fixture-password", false);
    expect((await service.login()).status).toBe("OTP_REQUIRED");
    await service.submitOtp(Buffer.from("123456", "utf8"));
    unsubscribe();
    expect(statuses).toContain("SUBMITTING_OTP");
    service.close();
  });
});
