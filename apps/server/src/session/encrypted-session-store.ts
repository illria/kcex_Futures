import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  EncryptedCredentialVault,
  type EncryptedSessionEnvelope,
  VaultLockedError,
} from "../vault/encrypted-vault.js";

const SessionEnvelopeSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("session"),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string().min(1),
  })
  .strict();

type StorageStateOperation<T> = (storageState: unknown) => T | Promise<T>;

function clearSensitiveValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) clearSensitiveValue(entry);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      (value as Record<string, unknown>)[key] = "";
    } else {
      clearSensitiveValue(entry);
    }
  }
}

function isStorageState(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Persists only an AES-GCM envelope. Decrypted Playwright storage state is
 * available through one callback and is cleared as soon as that callback ends.
 */
export class EncryptedSessionStore {
  constructor(
    private readonly vault: EncryptedCredentialVault,
    private readonly filePath: string,
  ) {}

  async hasSession(): Promise<boolean> {
    try {
      return (await stat(this.filePath)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async save(storageState: unknown): Promise<void> {
    if (!isStorageState(storageState)) throw new Error("Invalid browser storage state.");
    if (!this.vault.isUnlocked) throw new VaultLockedError();

    let serialized = "";
    let plaintext: Buffer | null = null;
    try {
      const encoded = JSON.stringify(storageState);
      if (!encoded) throw new Error("Invalid browser storage state.");
      serialized = encoded;
      plaintext = Buffer.from(serialized, "utf8");
      const envelope = await this.vault.sealSession(plaintext);
      await this.writeEnvelope(envelope);
    } finally {
      serialized = "";
      plaintext?.fill(0);
      // Playwright storage state is caller-owned input. Once encryption has
      // completed, remove cookie and origin strings from that object too.
      clearSensitiveValue(storageState);
    }
  }

  async withStorageState<T>(operation: StorageStateOperation<T>): Promise<T> {
    if (!this.vault.isUnlocked) throw new VaultLockedError();
    const envelope = await this.readEnvelope();
    return this.vault.withDecryptedSession(envelope, async (plaintext) => {
      let serialized = "";
      let storageState: unknown;
      try {
        serialized = plaintext.toString("utf8");
        storageState = JSON.parse(serialized);
        if (!isStorageState(storageState)) throw new Error("Invalid browser storage state.");
        return await operation(storageState);
      } finally {
        serialized = "";
        clearSensitiveValue(storageState);
      }
    });
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  private async readEnvelope(): Promise<EncryptedSessionEnvelope> {
    let serialized = "";
    try {
      serialized = await readFile(this.filePath, "utf8");
      return SessionEnvelopeSchema.parse(JSON.parse(serialized));
    } finally {
      serialized = "";
    }
  }

  private async writeEnvelope(envelope: EncryptedSessionEnvelope): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const suffix = randomBytes(8);
    const temporaryPath = this.filePath + "." + suffix.toString("hex") + ".tmp";
    suffix.fill(0);
    try {
      await writeFile(temporaryPath, JSON.stringify(envelope), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
