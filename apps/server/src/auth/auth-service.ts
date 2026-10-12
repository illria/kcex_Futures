import type { Logger } from "pino";
import {
  AuthStateSchema,
  BrowserHealthInspectionSchema,
  type AuthState,
  type AuthStatus,
  type AuthMethod,
  type BrowserHealthInspection,
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
  private authMethod: AuthMethod = "UNKNOWN";
  private sessionOriginMethod: Extract<AuthMethod, "PASSWORD" | "GOOGLE"> | null = null;
  private pendingAuthMethod: AuthMethod | null = null;
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

  getAuthMethod(): AuthMethod {
    return this.authMethod;
  }

  getRecoveryAuthMethod(): AuthMethod {
    if (this.authMethod !== "SESSION") return this.authMethod;
    return this.sessionOriginMethod ?? (this.credentialsSaved ? "PASSWORD" : "UNKNOWN");
  }

  async unlock(masterKey: string): Promise<AuthState> {
    this.clearPendingOtp();
    this.vault.lock();
    this.credentialsSaved = false;
    this.authMethod = "UNKNOWN";
    this.sessionOriginMethod = null;
    this.pendingAuthMethod = null;
    if (this.status !== "APP_LOCKED") this.transition("APP_LOCKED");

    const result = await this.vault.unlock(masterKey);
    this.credentialsSaved = result.credentialsSaved;

    if (this.sessionStore && await this.sessionStore.hasSession()) {
      this.transition("SESSION_CHECK");
      const restored = await this.restoreEncryptedSession();
      if (restored.result === "AUTHENTICATED") {
        this.sessionOriginMethod = restored.authMethod === "PASSWORD" || restored.authMethod === "GOOGLE"
          ? restored.authMethod
          : this.credentialsSaved ? "PASSWORD" : null;
        this.authMethod = "SESSION";
        this.clearPendingOtp();
        this.transition("AUTHENTICATED");
        return this.snapshot();
      }
      if (restored.result === "OTP_REQUIRED") {
        this.pendingAuthMethod = restored.authMethod ?? this.pendingAuthMethod;
        this.authMethod = "SESSION";
        this.establishPendingOtp();
        this.transition("OTP_REQUIRED");
        return this.snapshot();
      }
      if (restored.result === "MANUAL_CHALLENGE" || restored.result === "AUTH_UNKNOWN") {
        this.clearPendingOtp();
        this.transition(restored.result);
        return this.snapshot();
      }

      // A conclusively lost or failed session is the only restore outcome that
      // falls back to credentials. The encrypted session is removed first so
      // the next unlock cannot retry the same stale state.
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
    this.authMethod = "UNKNOWN";
    this.sessionOriginMethod = null;
    this.pendingAuthMethod = null;
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
    this.sessionOriginMethod = null;
    this.pendingAuthMethod = "PASSWORD";
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
    await this.applyAdapterResult(result, "PASSWORD");
    return this.snapshot();
  }

  async startGoogleOAuth(): Promise<AuthState> {
    if (!this.vault.isUnlocked || this.adapter.provider !== "KCEX" || !this.adapter.startGoogleOAuth) {
      this.transition("AUTH_UNKNOWN");
      return this.snapshot();
    }
    this.clearPendingOtp();
    this.sessionOriginMethod = null;
    this.pendingAuthMethod = "GOOGLE";
    this.transition("LOGGING_IN");
    try {
      const result = await this.adapter.startGoogleOAuth();
      if (result === "GOOGLE_OAUTH_PENDING") this.transition("GOOGLE_OAUTH_PENDING");
      else await this.applyAdapterResult(result, "GOOGLE");
    } catch {
      this.transition("AUTH_UNKNOWN");
    }
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
    this.transition("SUBMITTING_OTP");
    try {
      await this.applyAdapterResult(await this.adapter.submitOtp(candidate), this.pendingAuthMethod ?? this.authMethod);
      return this.snapshot();
    } catch {
      this.transition("AUTH_FAILED");
      return this.snapshot();
    } finally {
      candidate.fill(0);
    }
  }

  async checkSession(): Promise<AuthState> {
    this.clearPendingOtp();
    this.transition("SESSION_CHECK");
    await this.applyAdapterResult(await this.adapter.checkSession(), this.pendingAuthMethod ?? this.authMethod);
    return this.snapshot();
  }

  async handleRuntimeSignal(signal: "SESSION_LOST" | "MANUAL_CHALLENGE" | "AUTH_UNKNOWN" | "OTP_REQUIRED"): Promise<AuthState> {
    if (!(["SESSION_LOST", "MANUAL_CHALLENGE", "AUTH_UNKNOWN", "OTP_REQUIRED"] as readonly string[]).includes(signal)) {
      throw new TypeError("Unsupported runtime authentication signal.");
    }
    this.clearPendingOtp();
    if (signal === "SESSION_LOST") {
      await this.sessionStore?.clear().catch(() => {
        this.logger.warn({ authProvider: this.adapter.provider }, "Encrypted session cleanup failed after session loss.");
      });
    }
    if (signal === "OTP_REQUIRED") this.establishPendingOtp();
    this.transition(signal);
    return this.snapshot();
  }

  inspectBrowserHealth(): BrowserHealthInspection {
    const inspected = this.adapter.inspectBrowserHealth?.() ?? {
      browserConnected: false,
      pageAvailable: false,
      pageClosed: false,
      trustedPage: false,
    };
    return BrowserHealthInspectionSchema.parse(inspected);
  }

  close(): void {
    this.clearPendingOtp();
    this.vault.lock();
    this.credentialsSaved = false;
    this.authMethod = "UNKNOWN";
    this.sessionOriginMethod = null;
    this.pendingAuthMethod = null;
    this.status = "APP_LOCKED";
    void Promise.resolve(this.adapter.close?.()).catch(() => undefined);
  }

  private async restoreEncryptedSession(): Promise<{ result: AuthAdapterResult; authMethod: AuthMethod | null }> {
    if (!this.sessionStore) return { result: "SESSION_LOST", authMethod: null };
    let restoredMethod: AuthMethod | null = null;
    try {
      const result = await this.sessionStore.withSession(async (storageState, authMethod) => {
        restoredMethod = authMethod;
        if (this.adapter.restoreSession) return this.adapter.restoreSession(storageState);
        return this.adapter.checkSession();
      });
      return { result, authMethod: restoredMethod };
    } catch {
      return { result: "AUTH_UNKNOWN", authMethod: restoredMethod };
    }
  }

  private async applyAdapterResult(result: AuthAdapterResult, successfulMethod?: AuthMethod): Promise<void> {
    if (result === "GOOGLE_OAUTH_PENDING") {
      this.pendingAuthMethod = "GOOGLE";
      this.transition("GOOGLE_OAUTH_PENDING");
      return;
    }
    if (result === "OTP_REQUIRED") {
      this.establishPendingOtp();
      this.transition("OTP_REQUIRED");
      return;
    }

    this.clearPendingOtp();
    if (result === "AUTHENTICATED" && successfulMethod) {
      this.authMethod = successfulMethod;
      if (successfulMethod === "PASSWORD" || successfulMethod === "GOOGLE") this.sessionOriginMethod = successfulMethod;
    }
    if (result !== "OTP_REQUIRED") this.pendingAuthMethod = null;
    this.transition(result);
    if (result === "AUTHENTICATED") await this.persistSessionIfAvailable();
  }

  private establishPendingOtp(): void {
    this.clearPendingOtp();
    const expiresAt = this.now() + this.otpTtlMs;
    const timer = setTimeout(() => {
      if (this.pendingOtp?.expiresAt === expiresAt) this.expireOtp();
    }, this.otpTtlMs);
    timer.unref();
    this.pendingOtp = { expiresAt, timer };
  }

  private async persistSessionIfAvailable(): Promise<void> {
    if (!this.sessionStore || !this.adapter.exportSession) return;
    try {
      const sessionMethod = this.authMethod === "SESSION" ? this.sessionOriginMethod ?? "SESSION" : this.authMethod;
      await this.sessionStore.save(await this.adapter.exportSession(), sessionMethod);
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
      authMethod: this.authMethod,
      credentialsSaved: this.credentialsSaved,
      liveTrading: false,
      updatedAt: this.updatedAt,
    });
  }
}
