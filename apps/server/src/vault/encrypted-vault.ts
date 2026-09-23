import { randomBytes, scrypt, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const VAULT_AAD = Buffer.from("kcex-futures-vault:v1", "utf8");
const scryptAsync = promisify(scrypt);

const CredentialSchema = z
  .object({ account: z.string().trim().min(1).max(320), password: z.string().min(1).max(4096) })
  .strict();

const EnvelopeSchema = z
  .object({
    version: z.literal(1),
    kdf: z.literal("scrypt"),
    params: z.object({ n: z.literal(SCRYPT_N), r: z.literal(SCRYPT_R), p: z.literal(SCRYPT_P) }).strict(),
    salt: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    iv: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    tag: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

type Credential = z.infer<typeof CredentialSchema>;
export type EncryptedVaultEnvelope = z.infer<typeof EnvelopeSchema>;

export class VaultUnlockError extends Error {
  constructor() {
    super("Unable to unlock the credential vault.");
    this.name = "VaultUnlockError";
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super("The credential vault is locked.");
    this.name = "VaultLockedError";
  }
}

async function deriveKey(masterKey: Buffer, salt: Buffer): Promise<Buffer> {
  return (await scryptAsync(masterKey, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  })) as Buffer;
}

function assertEnvelopeLengths(envelope: EncryptedVaultEnvelope): void {
  if (
    Buffer.from(envelope.salt, "base64").length !== SALT_LENGTH ||
    Buffer.from(envelope.iv, "base64").length !== IV_LENGTH ||
    Buffer.from(envelope.tag, "base64").length !== TAG_LENGTH ||
    Buffer.from(envelope.ciphertext, "base64").length === 0
  ) {
    throw new Error("Invalid vault envelope.");
  }
}

export class EncryptedCredentialVault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private credentials: Credential | null = null;
  private saved = false;

  constructor(private readonly filePath: string) {}

  get isUnlocked(): boolean {
    return this.key !== null;
  }

  get credentialsSaved(): boolean {
    return this.saved;
  }

  get hasCredentials(): boolean {
    return this.credentials !== null;
  }

  async unlock(masterKey: string): Promise<{ credentialsSaved: boolean }> {
    this.lock();
    const masterKeyBytes = Buffer.from(masterKey, "utf8");
    if (masterKeyBytes.length === 0) throw new VaultUnlockError();

    try {
      const serialized = await readFile(this.filePath, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });

      if (serialized === null) {
        const salt = randomBytes(SALT_LENGTH);
        this.key = await deriveKey(masterKeyBytes, salt);
        this.salt = salt;
        this.credentials = null;
        this.saved = false;
        return { credentialsSaved: false };
      }

      let key: Buffer | null = null;
      let plaintext: Buffer | null = null;
      try {
        const envelope = EnvelopeSchema.parse(JSON.parse(serialized));
        assertEnvelopeLengths(envelope);
        const salt = Buffer.from(envelope.salt, "base64");
        key = await deriveKey(masterKeyBytes, salt);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
        decipher.setAAD(VAULT_AAD);
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, "base64")),
          decipher.final(),
        ]);
        const credentials = CredentialSchema.parse(JSON.parse(plaintext.toString("utf8")));
        this.key = key;
        this.salt = salt;
        this.credentials = credentials;
        this.saved = true;
        key = null;
        return { credentialsSaved: true };
      } catch {
        throw new VaultUnlockError();
      } finally {
        key?.fill(0);
        plaintext?.fill(0);
      }
    } catch (error) {
      this.lock();
      if (error instanceof VaultUnlockError) throw error;
      throw new VaultUnlockError();
    } finally {
      masterKeyBytes.fill(0);
    }
  }

  async saveCredentials(
    account: string,
    password: string,
    persist: boolean,
  ): Promise<{ credentialsSaved: boolean }> {
    if (!this.key || !this.salt) throw new VaultLockedError();
    const credentials = CredentialSchema.parse({ account, password });

    let installed = false;
    try {
      if (persist) {
        const envelope = this.encrypt(credentials);
        await this.writeEnvelope(envelope);
      } else {
        await rm(this.filePath, { force: true });
      }

      this.clearCredentials();
      this.credentials = credentials;
      this.saved = persist;
      installed = true;
      return { credentialsSaved: persist };
    } finally {
      if (!installed) {
        credentials.account = "";
        credentials.password = "";
      }
    }
  }

  async deleteCredentials(): Promise<{ credentialsSaved: false }> {
    if (!this.key) throw new VaultLockedError();
    await rm(this.filePath, { force: true });
    this.clearCredentials();
    return { credentialsSaved: false };
  }

  getAccountForFakeAuth(): string | null {
    if (!this.key || !this.credentials) return null;
    return this.credentials.account;
  }

  lock(): void {
    this.key?.fill(0);
    this.salt?.fill(0);
    this.key = null;
    this.salt = null;
    this.clearCredentials();
  }

  private clearCredentials(): void {
    if (this.credentials) {
      this.credentials.account = "";
      this.credentials.password = "";
    }
    this.credentials = null;
    this.saved = false;
  }

  private encrypt(credentials: Credential): EncryptedVaultEnvelope {
    if (!this.key || !this.salt) throw new VaultLockedError();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(VAULT_AAD);
    const plaintext = Buffer.from(JSON.stringify(credentials), "utf8");
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      try {
        return {
          version: 1,
          kdf: "scrypt",
          params: { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
          salt: this.salt.toString("base64"),
          iv: iv.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
        };
      } finally {
        ciphertext.fill(0);
        iv.fill(0);
      }
    } finally {
      plaintext.fill(0);
    }
  }

  private async writeEnvelope(envelope: EncryptedVaultEnvelope): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`;
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
