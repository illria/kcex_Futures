import { readFile, readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(restored.getAccountForFakeAuth()).toBe(TEST_ACCOUNT);
    restored.lock();
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
