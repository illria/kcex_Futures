import type { Logger } from "pino";
import {
  AuthStateSchema,
  type AuthState,
  type AuthStatus,
} from "../../../../packages/shared/src/protocol.js";
import { EventBus } from "../realtime/event-bus.js";
import { EncryptedSessionStore } from "../session/encrypted-session-store.js";
import { FakeAuthAdapter } from "./fake-auth-adapter.js";
import type { AuthAdapter, AuthAdapterResult } from "./auth-adapter.js";
import {
  EncryptedCredentialVault,
  VaultCredentialsRequiredError,
} from "../vault/encrypted-vault.js";

interface PendingOtp {
  expiresAt: number;
  timer: NodeJS.Timeout;
}

export class AuthService {
  private status: AuthStatus = "APP_LOCKED";
  private updatedAt = new Date().toISOString();
  private credentialsSaved = false;
  private pendingOtp: PendingOtp | null = null;

  constructor(
    private readonly vault: EncryptedCredentialVault,
    private readonly events: EventBus,
    private readonly logger: Logger,
    private readonly adapter: AuthAdapter = new FakeAuthAdapter(),
    private readonly otpTtlMs = 120_000,
    private readonly now: () => number = Date.now,
    private readonly sessionStore?: EncryptedSessionStore,
  ) {}

  getState(): AuthState {
    this.expireOtpIfNeeded();
    return this.snapshot();
  }

  async unlock(masterKey: string): Promise<AuthState> {
    this.clearPendingOtp();
    this.vault.lock();
    this.credentialsSaved = false;
    if (this.status !== "APP_LOCKED") this.transition("APP_LOCKED");

    const result = await this.vault.unlock(masterKey);
    this.credentialsSaved = result.credentialsSaved;

    if (this.sessionStore && await this.sessionStore.hasSession()) {
      this.transition("SESSION_CHECK");
      const restored = await this.restoreEncryptedSession();
      if (restored === "AUTHENTICATED") {
        this.transition("AUTHENTICATED");
        return this.snapshot();
      }
      await this.sessionStore.clear().catch(() => undefined);
    }

    this.transition(result.credentialsSaved ? "VAULT_UNLOCKED" : "CREDENTIALS_REQUIRED");
    return this.snapshot();
  }

  async saveCredentials(
    account: string,
    password: string,
    persist: boolean,
  ): Promise<{ credentialsSaved: boolean }> {
    const result = await this.vault.saveCredentials(account, password, persist);
    this.credentialsSaved = result.credentialsSaved;
    if (this.status === "CREDENTIALS_REQUIRED") this.transition("VAULT_UNLOCKED");
    return result;
  }

  async deleteCredentials(): Promise<{ credentialsSaved: false }> {
    const result = await this.vault.deleteCredentials();
    this.credentialsSaved = false;
    this.clearPendingOtp();
    await this.sessionStore?.clear();
    this.transition("CREDENTIALS_REQUIRED");
    return result;
  }

  async login(): Promise<AuthState> {
    if (!this.vault.isUnlocked) return this.snapshot();
    if (!this.vault.hasCredentials) {
      this.transition("CREDENTIALS_REQUIRED");
      return this.snapshot();
    }

    this.clearPendingOtp();
    this.transition("LOGGING_IN");
    let result: AuthAdapterResult;
    try {
      result = await this.vault.withDecryptedCredentials((credentials) => this.adapter.login(credentials));
    } catch (error) {
      if (error instanceof VaultCredentialsRequiredError) {
        this.transition("CREDENTIALS_REQUIRED");
        return this.snapshot();
      }
      this.transition("AUTH_FAILED");
      return this.snapshot();
    }
    await this.applyAdapterResult(result);
    return this.snapshot();
  }

  async submitOtp(candidate: Buffer): Promise<AuthState> {
    const pending = this.pendingOtp;
    if (!pending || pending.expiresAt <= this.now() || this.status !== "OTP_REQUIRED") {
      this.clearPendingOtp();
      candidate.fill(0);
      this.transition("AUTH_FAILED");
      return this.snapshot();
    }

    this.clearPendingOtp();
    try {
      await this.applyAdapterResult(await this.adapter.submitOtp(candidate));
      return this.snapshot();
    } finally {
      candidate.fill(0);
    }
  }

  async checkSession(): Promise<AuthState> {
    this.clearPendingOtp();
    this.transition("SESSION_CHECK");
    await this.applyAdapterResult(await this.adapter.checkSession());
    return this.snapshot();
  }

  close(): void {
    this.clearPendingOtp();
    this.vault.lock();
    this.credentialsSaved = false;
    this.status = "APP_LOCKED";
    void Promise.resolve(this.adapter.close?.()).catch(() => undefined);
  }

  private async restoreEncryptedSession(): Promise<AuthAdapterResult> {
    if (!this.sessionStore) return "SESSION_LOST";
    try {
      return await this.sessionStore.withStorageState(async (storageState) => {
        if (this.adapter.restoreSession) return this.adapter.restoreSession(storageState);
        return this.adapter.checkSession();
      });
    } catch {
      return "AUTH_UNKNOWN";
    }
  }

  private async applyAdapterResult(result: AuthAdapterResult): Promise<void> {
    if (result === "OTP_REQUIRED") {
      const expiresAt = this.now() + this.otpTtlMs;
      const timer = setTimeout(() => {
        if (this.pendingOtp?.expiresAt === expiresAt) this.expireOtp();
      }, this.otpTtlMs);
      timer.unref();
      this.pendingOtp = { expiresAt, timer };
      this.transition("OTP_REQUIRED");
      return;
    }

    this.clearPendingOtp();
    this.transition(result);
    if (result === "AUTHENTICATED") await this.persistSessionIfAvailable();
  }

  private async persistSessionIfAvailable(): Promise<void> {
    if (!this.sessionStore || !this.vault.credentialsSaved || !this.adapter.exportSession) return;
    try {
      await this.sessionStore.save(await this.adapter.exportSession());
    } catch {
      this.logger.warn({ authProvider: this.adapter.provider }, "Authenticated session could not be persisted.");
    }
  }

  private expireOtpIfNeeded(): void {
    if (this.pendingOtp && this.pendingOtp.expiresAt <= this.now()) this.expireOtp();
  }

  private expireOtp(): void {
    this.clearPendingOtp();
    this.transition("AUTH_FAILED");
  }

  private clearPendingOtp(): void {
    if (this.pendingOtp) clearTimeout(this.pendingOtp.timer);
    this.pendingOtp = null;
  }

  private transition(status: AuthStatus): void {
    this.status = status;
    this.updatedAt = new Date(this.now()).toISOString();
    const state = this.snapshot();
    this.events.publish({
      version: 1,
      type: "auth.state",
      timestamp: this.updatedAt,
      payload: state,
    });
    this.logger.info(
      { authStatus: status, authProvider: this.adapter.provider, credentialsSaved: this.credentialsSaved },
      "Authentication state changed.",
    );
  }

  private snapshot(): AuthState {
    return AuthStateSchema.parse({
      status: this.status,
      authProvider: this.adapter.provider,
      credentialsSaved: this.credentialsSaved,
      liveTrading: false,
      updatedAt: this.updatedAt,
    });
  }
}
