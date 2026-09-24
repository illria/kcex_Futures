import { randomBytes, scrypt, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MASTER_KEY_MIN_LENGTH } from "../../../../packages/shared/src/protocol.js";
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
export type TemporaryVaultCredentials = Readonly<Credential>;
export type EncryptedVaultEnvelope = z.infer<typeof EnvelopeSchema>;
type CredentialOperation<T> = (credentials: TemporaryVaultCredentials) => T | Promise<T>;

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

export class VaultCredentialsRequiredError extends Error {
  constructor() {
    super("Credentials are required.");
    this.name = "VaultCredentialsRequiredError";
  }
}

async function deriveKey(masterKey: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(masterKey, salt, KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
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

function clearCredential(credential: Credential | null): void {
  if (!credential) return;
  credential.account = "";
  credential.password = "";
}

async function withTemporaryCredential<T>(
  credential: Credential,
  operation: CredentialOperation<T>,
  activeCredentials?: Set<Credential>,
): Promise<T> {
  activeCredentials?.add(credential);
  try {
    return await operation(credential);
  } finally {
    clearCredential(credential);
    activeCredentials?.delete(credential);
  }
}

async function withDecryptedEnvelope<T>(
  key: Buffer,
  envelope: EncryptedVaultEnvelope,
  operation: CredentialOperation<T>,
  activeCredentials?: Set<Credential>,
): Promise<T> {
  let salt: Buffer | null = null;
  let iv: Buffer | null = null;
  let tag: Buffer | null = null;
  let ciphertext: Buffer | null = null;
  let plaintextChunk: Buffer | null = null;
  let finalChunk: Buffer | null = null;
  let plaintext: Buffer | null = null;
  let serialized = "";
  let credential: Credential | null = null;

  try {
    assertEnvelopeLengths(envelope);
    salt = Buffer.from(envelope.salt, "base64");
    iv = Buffer.from(envelope.iv, "base64");
    tag = Buffer.from(envelope.tag, "base64");
    ciphertext = Buffer.from(envelope.ciphertext, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(tag);
    plaintextChunk = decipher.update(ciphertext);
    finalChunk = decipher.final();
    plaintext = Buffer.concat([plaintextChunk, finalChunk]);
    serialized = plaintext.toString("utf8");
    credential = CredentialSchema.parse(JSON.parse(serialized));
  } catch {
    clearCredential(credential);
    throw new VaultUnlockError();
  } finally {
    serialized = "";
    plaintextChunk?.fill(0);
    finalChunk?.fill(0);
    plaintext?.fill(0);
    salt?.fill(0);
    iv?.fill(0);
    tag?.fill(0);
    ciphertext?.fill(0);
  }

  if (!credential) throw new VaultUnlockError();
  return withTemporaryCredential(credential, operation, activeCredentials);
}

export class EncryptedCredentialVault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private memoryCredentials: Credential | null = null;
  private activeCredentials = new Set<Credential>();
  private saved = false;

  constructor(private readonly filePath: string) {}

  get isUnlocked(): boolean {
    return this.key !== null;
  }

  get credentialsSaved(): boolean {
    return this.saved;
  }

  get hasCredentials(): boolean {
    return this.saved || this.memoryCredentials !== null;
  }

  async unlock(masterKey: string): Promise<{ credentialsSaved: boolean }> {
    this.lock();
    if (masterKey.length < MASTER_KEY_MIN_LENGTH || masterKey.length > 4096) {
      throw new VaultUnlockError();
    }

    const masterKeyBytes = Buffer.from(masterKey, "utf8");
    let nextKey: Buffer | null = null;
    let nextSalt: Buffer | null = null;
    try {
      const serialized = await readFile(this.filePath, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });

      if (serialized === null) {
        nextSalt = randomBytes(SALT_LENGTH);
        nextKey = await deriveKey(masterKeyBytes, nextSalt);
        this.key = nextKey;
        this.salt = nextSalt;
        nextKey = null;
        nextSalt = null;
        this.saved = false;
        return { credentialsSaved: false };
      }

      try {
        const envelope = EnvelopeSchema.parse(JSON.parse(serialized));
        assertEnvelopeLengths(envelope);
        nextSalt = Buffer.from(envelope.salt, "base64");
        nextKey = await deriveKey(masterKeyBytes, nextSalt);
        await withDecryptedEnvelope(nextKey, envelope, async () => undefined);

        this.key = nextKey;
        this.salt = nextSalt;
        nextKey = null;
        nextSalt = null;
        this.saved = true;
        return { credentialsSaved: true };
      } catch {
        throw new VaultUnlockError();
      }
    } catch (error) {
      this.lock();
      if (error instanceof VaultUnlockError) throw error;
      throw new VaultUnlockError();
    } finally {
      masterKeyBytes.fill(0);
      nextKey?.fill(0);
      nextSalt?.fill(0);
    }
  }

  async saveCredentials(
    account: string,
    password: string,
    persist: boolean,
  ): Promise<{ credentialsSaved: boolean }> {
    if (!this.key || !this.salt) throw new VaultLockedError();
    const credentials = CredentialSchema.parse({ account, password });
    let transferredToMemory = false;

    try {
      if (persist) {
        const envelope = this.encrypt(credentials);
        await this.writeEnvelope(envelope);
      } else {
        await rm(this.filePath, { force: true });
      }

      this.clearActiveCredentials();
      this.clearMemoryCredentials();
      this.saved = persist;
      if (!persist) {
        this.memoryCredentials = credentials;
        transferredToMemory = true;
      }
      return { credentialsSaved: persist };
    } finally {
      if (!transferredToMemory) clearCredential(credentials);
    }
  }

  async deleteCredentials(): Promise<{ credentialsSaved: false }> {
    if (!this.key) throw new VaultLockedError();
    await rm(this.filePath, { force: true });
    this.clearActiveCredentials();
    this.clearMemoryCredentials();
    this.saved = false;
    return { credentialsSaved: false };
  }

  async withDecryptedCredentials<T>(operation: CredentialOperation<T>): Promise<T> {
    const key = this.key;
    if (!key) throw new VaultLockedError();

    if (this.memoryCredentials) {
      const temporary = {
        account: this.memoryCredentials.account,
        password: this.memoryCredentials.password,
      };
      return withTemporaryCredential(temporary, operation, this.activeCredentials);
    }

    if (!this.saved) throw new VaultCredentialsRequiredError();
    let envelope: EncryptedVaultEnvelope;
    try {
      const serialized = await readFile(this.filePath, "utf8");
      envelope = EnvelopeSchema.parse(JSON.parse(serialized));
    } catch (error) {
      if (error instanceof VaultUnlockError) throw error;
      throw new VaultUnlockError();
    }
    return withDecryptedEnvelope(key, envelope, operation, this.activeCredentials);
  }

  lock(): void {
    this.key?.fill(0);
    this.salt?.fill(0);
    this.key = null;
    this.salt = null;
    this.clearActiveCredentials();
    this.clearMemoryCredentials();
    this.saved = false;
  }

  private clearActiveCredentials(): void {
    for (const credential of this.activeCredentials) clearCredential(credential);
    this.activeCredentials.clear();
  }

  private clearMemoryCredentials(): void {
    clearCredential(this.memoryCredentials);
    this.memoryCredentials = null;
  }

  private encrypt(credentials: Credential): EncryptedVaultEnvelope {
    if (!this.key || !this.salt) throw new VaultLockedError();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(VAULT_AAD);
    let serialized = "";
    let plaintext: Buffer | null = null;
    let ciphertext: Buffer | null = null;
    try {
      serialized = JSON.stringify(credentials);
      plaintext = Buffer.from(serialized, "utf8");
      ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
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
      serialized = "";
      plaintext?.fill(0);
      ciphertext?.fill(0);
      iv.fill(0);
    }
  }

  private async writeEnvelope(envelope: EncryptedVaultEnvelope): Promise<void> {
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
