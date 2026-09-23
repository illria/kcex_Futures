import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { AuthService } from "../../apps/server/src/auth/auth-service.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { EncryptedCredentialVault } from "../../apps/server/src/vault/encrypted-vault.js";

export const TEST_MASTER_KEY = "task002-local-master-key-fixture-7b4d";
export const TEST_ACCOUNT = "fixture-account@example.test";
export const TEST_PASSWORD = "fixture-password-never-plaintext-91ce";

export async function createAuthFixture(options: {
  otpTtlMs?: number;
  now?: () => number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kcex-task002-test-"));
  const filePath = join(directory, "credentials.vault.json");
  const vault = new EncryptedCredentialVault(filePath);
  const events = new EventBus();
  const logger = { info: () => undefined } as unknown as Logger;
  const auth = new AuthService(
    vault,
    events,
    logger,
    undefined,
    options.otpTtlMs,
    options.now,
  );

  return {
    directory,
    filePath,
    vault,
    events,
    auth,
    async cleanup() {
      auth.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
