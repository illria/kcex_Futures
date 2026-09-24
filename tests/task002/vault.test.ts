import { readFile, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedCredentialVault, VaultUnlockError } from "../../apps/server/src/vault/encrypted-vault.js";
import {
  createAuthFixture,
  TEST_ACCOUNT,
  TEST_MASTER_KEY,
  TEST_PASSWORD,
} from "./helpers.js";

describe("encrypted credential vault", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("encrypts credentials and decrypts them after a new vault instance unlocks", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.vault.unlock(TEST_MASTER_KEY);
    await fixture.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);
    fixture.vault.lock();

    const restored = new EncryptedCredentialVault(fixture.filePath);
    const result = await restored.unlock(TEST_MASTER_KEY);

    expect(result.credentialsSaved).toBe(true);
    expect(restored.isUnlocked).toBe(true);
    expect(restored.hasCredentials).toBe(true);
    expect(restored).not.toHaveProperty("credentials");
    expect((restored as unknown as Record<string, unknown>).memoryCredentials).toBeNull();
    expect(JSON.stringify(restored)).not.toContain(TEST_PASSWORD);
    restored.lock();
  });

  it("exposes persisted credentials only during a callback and clears the transient object", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.vault.unlock(TEST_MASTER_KEY);
    await fixture.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);
    fixture.vault.lock();

    const restored = new EncryptedCredentialVault(fixture.filePath);
    await restored.unlock(TEST_MASTER_KEY);
    const plaintextLength = Buffer.byteLength(JSON.stringify({
      account: TEST_ACCOUNT,
      password: TEST_PASSWORD,
    }));
    const fillSpy = vi.spyOn(Buffer.prototype, "fill");
    let retained: { account: string; password: string } | undefined;
    const seen = await restored.withDecryptedCredentials((credentials) => {
      retained = credentials;
      return { account: credentials.account, password: credentials.password };
    });
    const plaintextBuffers = fillSpy.mock.contexts.filter(
      (context): context is Buffer => Buffer.isBuffer(context) && context.length === plaintextLength,
    );
    fillSpy.mockRestore();

    expect(seen).toEqual({ account: TEST_ACCOUNT, password: TEST_PASSWORD });
    expect(retained).toEqual({ account: "", password: "" });
    expect(plaintextBuffers.length).toBeGreaterThanOrEqual(3);
    expect(plaintextBuffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect((restored as unknown as Record<string, unknown>).memoryCredentials).toBeNull();
    expect(JSON.stringify(restored)).not.toContain(TEST_PASSWORD);
    restored.lock();
  });

  it("keeps save=false credentials memory-only and clears them on delete", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.vault.unlock(TEST_MASTER_KEY);
    await fixture.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, false);

    let retained: { account: string; password: string } | undefined;
    const account = await fixture.vault.withDecryptedCredentials((credentials) => {
      retained = credentials;
      return credentials.account;
    });
    expect(account).toBe(TEST_ACCOUNT);
    expect(retained).toEqual({ account: "", password: "" });
    expect(fixture.vault.credentialsSaved).toBe(false);
    expect(fixture.vault.hasCredentials).toBe(true);
    await expect(readFile(fixture.filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await fixture.vault.deleteCredentials();
    expect(fixture.vault.hasCredentials).toBe(false);
    expect((fixture.vault as unknown as Record<string, unknown>).memoryCredentials).toBeNull();
    await expect(fixture.vault.withDecryptedCredentials(() => true)).rejects.toThrow();
  });

  it("clears an in-flight transient credential reference when credentials are deleted", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.vault.unlock(TEST_MASTER_KEY);
    await fixture.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, false);

    let observed: Readonly<{ account: string; password: string }> | undefined;
    let resumeCallback: () => void = () => undefined;
    const inFlight = fixture.vault.withDecryptedCredentials(async (credentials) => {
      observed = credentials;
      await new Promise<void>((resolve) => {
        resumeCallback = resolve;
      });
      return true;
    });

    await fixture.vault.deleteCredentials();
    expect(observed).toEqual({ account: "", password: "" });
    resumeCallback();
    await expect(inFlight).resolves.toBe(true);
  });

  it("refuses master keys shorter than the shared minimum", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await expect(fixture.vault.unlock("12345678901")).rejects.toBeInstanceOf(VaultUnlockError);
    expect(fixture.vault.isUnlocked).toBe(false);
    await expect(fixture.vault.unlock("123456789012")).resolves.toEqual({ credentialsSaved: false });
    expect(fixture.vault.isUnlocked).toBe(true);
  });

  it("rejects a wrong master key", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.vault.unlock(TEST_MASTER_KEY);
    await fixture.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);

    const wrongKeyVault = new EncryptedCredentialVault(fixture.filePath);
    await expect(wrongKeyVault.unlock("wrong-master-key-fixture")).rejects.toBeInstanceOf(VaultUnlockError);
    expect(wrongKeyVault.isUnlocked).toBe(false);
  });

  it("uses random salts and IVs and authenticates the encrypted envelope", async () => {
    const first = await createAuthFixture();
    cleanup = first.cleanup;
    const secondDir = await createAuthFixture();
    const second = new EncryptedCredentialVault(secondDir.filePath);
    try {
      await first.vault.unlock(TEST_MASTER_KEY);
      await first.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);
      const initial = JSON.parse(await readFile(first.filePath, "utf8")) as {
        salt: string; iv: string; tag: string;
      };
      await first.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);
      const rotated = JSON.parse(await readFile(first.filePath, "utf8")) as {
        salt: string; iv: string; tag: string;
      };

      await second.unlock(TEST_MASTER_KEY);
      await second.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);
      const independent = JSON.parse(await readFile(secondDir.filePath, "utf8")) as {
        salt: string; iv: string; tag: string;
      };

      expect(Buffer.from(initial.salt, "base64")).toHaveLength(16);
      expect(Buffer.from(initial.tag, "base64")).toHaveLength(16);
      expect(rotated.salt).toBe(initial.salt);
      expect(rotated.iv).not.toBe(initial.iv);
      expect(independent.salt).not.toBe(initial.salt);
    } finally {
      second.lock();
      await secondDir.cleanup();
    }
  });

  it("persists only ciphertext and no master key or plaintext credential files", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.vault.unlock(TEST_MASTER_KEY);
    await fixture.vault.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, true);

    const serialized = await readFile(fixture.filePath, "utf8");
    expect(serialized).not.toContain(TEST_MASTER_KEY);
    expect(serialized).not.toContain(TEST_ACCOUNT);
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(JSON.parse(serialized)).not.toHaveProperty("masterKey");
    expect(await readdir(fixture.directory)).toEqual(["credentials.vault.json"]);
  });
});
