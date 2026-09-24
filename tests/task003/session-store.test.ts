import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedSessionStore } from "../../apps/server/src/session/encrypted-session-store.js";
import { EncryptedCredentialVault, VaultUnlockError } from "../../apps/server/src/vault/encrypted-vault.js";

const MASTER_KEY = "task003-session-master-key-fixture";
const PASSWORD = "task003-session-password-fixture";

describe("encrypted Playwright session store", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "kcex-task003-session-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const vaultPath = join(directory, "credentials.vault.json");
    const sessionPath = join(directory, "session.enc.json");
    const vault = new EncryptedCredentialVault(vaultPath);
    await vault.unlock(MASTER_KEY);
    await vault.saveCredentials("fixture@example.test", PASSWORD, true);
    return { directory, vaultPath, sessionPath, vault, store: new EncryptedSessionStore(vault, sessionPath) };
  }

  it("round-trips storage state through an encrypted envelope and clears callback state", async () => {
    const value = await fixture();
    const storageState = { cookies: [{ name: "session", value: "fixture-cookie" }], origins: [] };
    await value.store.save(storageState);

    const serialized = await readFile(value.sessionPath, "utf8");
    expect(serialized).not.toContain("fixture-cookie");
    expect(serialized).not.toContain(PASSWORD);
    expect(await value.store.hasSession()).toBe(true);

    let retained: Record<string, unknown> | undefined;
    const seen = await value.store.withStorageState((state) => {
      retained = state as Record<string, unknown>;
      return JSON.stringify(state);
    });
    expect(seen).toContain("fixture-cookie");
    expect(JSON.stringify(retained)).not.toContain("fixture-cookie");
    expect(await readdir(value.directory)).toEqual(["credentials.vault.json", "session.enc.json"]);
  });

  it("rotates the random session IV and rejects a wrong vault key", async () => {
    const value = await fixture();
    await value.store.save({ cookies: [], origins: [] });
    const first = JSON.parse(await readFile(value.sessionPath, "utf8")) as { iv: string; tag: string };
    await value.store.save({ cookies: [{ name: "rotated", value: "value" }], origins: [] });
    const second = JSON.parse(await readFile(value.sessionPath, "utf8")) as { iv: string; tag: string };
    expect(first.iv).not.toBe(second.iv);
    expect(first.tag).toHaveLength(24);
    await value.vault.lock();
    const wrongVault = new EncryptedCredentialVault(value.vaultPath);
    await expect(wrongVault.unlock("task003-wrong-master-key-fixture")).rejects.toBeInstanceOf(VaultUnlockError);
  });

  it("clears sensitive strings from caller-owned storage state after encrypting", async () => {
    const value = await fixture();
    const state = {
      cookies: [{ name: "session", value: "fixture_session_secret" }],
      origins: [{ origin: "http://127.0.0.1", localStorage: [{ name: "session", value: "fixture_session_secret" }] }],
    };

    await value.store.save(state);

    expect(JSON.stringify(state)).not.toContain("fixture_session_secret");
    expect(await readFile(value.sessionPath, "utf8")).not.toContain("fixture_session_secret");
  });

  it("deletes an encrypted session without leaving temporary files", async () => {
    const value = await fixture();
    await value.store.save({ cookies: [], origins: [] });
    await value.store.clear();
    expect(await value.store.hasSession()).toBe(false);
    expect(await readdir(value.directory)).toEqual(["credentials.vault.json"]);
  });
});
