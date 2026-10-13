import type { Logger } from "pino";
import {
  AuthRecoveryStateSchema,
  type AuthRecoveryState,
  type AuthRecoveryStatus,
  type AuthState,
} from "../../../../packages/shared/src/protocol.js";
import { EventBus } from "../realtime/event-bus.js";
import type { EncryptedCredentialVault } from "../vault/encrypted-vault.js";
import type { AuthService } from "./auth-service.js";

const MUTATION_STATES = new Set(["SUBMITTING", "CONFIRMING", "PROTECTING"]);
const RESUMABLE_STATES = new Set(["ARMED", "WAITING", "DUE"]);

export interface AuthRecoveryReadiness {
  freshRead: boolean;
  resilienceHealthy: boolean;
}

export interface AuthRecoveryControllerOptions {
  auth: AuthService;
  vault: EncryptedCredentialVault;
  events: EventBus;
  logger: Logger;
  now?: () => Date;
  getAutoLiveStatus?: () => string;
  getMutationInFlight?: () => boolean;
  getHardHalted?: () => boolean;
  pauseAutoLive?: () => void;
  resumeAutoLive?: () => void;
  haltAutoLive?: () => void;
  markMutationUnknown?: (automationStatus: string) => Promise<void> | void;
  getReadiness?: (recoveryStartedAt: Date) => AuthRecoveryReadiness;
  onRecovered?: () => Promise<void> | void;
}

/**
 * Runtime-only, single-flight authentication recovery. It never stores a
 * credential and never performs a second login within one SESSION_LOST
 * episode. OTP and Google OAuth remain user-driven.
 */
export class AuthRecoveryController {
  private readonly now: () => Date;
  private readonly unsubscribe: () => void;
  private state: AuthRecoveryState;
  private episodeActive = false;
  private inFlight: Promise<AuthRecoveryState> | null = null;
  private recoveryStartedAtMs: number | null = null;

  constructor(private readonly options: AuthRecoveryControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.state = AuthRecoveryStateSchema.parse({
      status: "IDLE",
      attemptCount: 0,
      maxAttempts: 1,
      resumeIntent: false,
      reason: null,
      updatedAt: this.now().toISOString(),
    });
    this.unsubscribe = options.events.subscribe((event) => {
      if (event.type === "auth.state") void this.handleAuthState(event.payload);
      else if (event.type === "futures.snapshot" || event.type === "resilience.state") void this.finalizeIfReady();
    });
  }

  getState(): AuthRecoveryState {
    return AuthRecoveryStateSchema.parse(this.state);
  }

  /**
   * Returns whether this controller still owns an active authentication-loss
   * episode. The runtime auth subscriber uses this to distinguish the OTP
   * emitted by bounded recovery from an unrelated standalone OTP signal.
   */
  isRecoveryActive(): boolean {
    return this.inFlight !== null
      || ["RECOVERING", "WAITING_OTP", "GOOGLE_OAUTH_REQUIRED"].includes(this.state.status);
  }

  close(): void {
    this.unsubscribe();
    this.inFlight = null;
    this.episodeActive = false;
    this.recoveryStartedAtMs = null;
  }

  async handleSessionLost(): Promise<AuthRecoveryState> {
    if (this.episodeActive || this.inFlight) return this.getState();
    this.episodeActive = true;
    this.recoveryStartedAtMs = this.now().getTime();
    const autoLiveStatus = this.options.getAutoLiveStatus?.() ?? "DISARMED";
    const resumeIntent = RESUMABLE_STATES.has(autoLiveStatus);
    this.updateState({
      status: "RECOVERING",
      attemptCount: 0,
      resumeIntent,
      reason: null,
    });

    const mutationInFlight = this.options.getMutationInFlight?.() ?? MUTATION_STATES.has(autoLiveStatus);
    if (mutationInFlight || this.options.getHardHalted?.()) {
      try { await this.options.markMutationUnknown?.(autoLiveStatus); } catch { /* Preserve the fail-closed manual state. */ }
      this.options.haltAutoLive?.();
      return this.manualAction("MUTATION_IN_FLIGHT");
    }
    if (autoLiveStatus !== "DISARMED" && !RESUMABLE_STATES.has(autoLiveStatus)) {
      this.options.haltAutoLive?.();
      return this.manualAction("AUTO_LIVE_UNSAFE_STATE");
    }

    const authState = this.options.auth.getState();
    const authMethod = this.options.auth.getRecoveryAuthMethod?.() ?? this.options.auth.getAuthMethod();
    if (authMethod === "GOOGLE") {
      if (resumeIntent) this.options.pauseAutoLive?.();
      return this.updateState({ status: "GOOGLE_OAUTH_REQUIRED", reason: "GOOGLE_OAUTH_REQUIRED" });
    }
    if (!this.options.vault.isUnlocked) return this.manualAction("VAULT_LOCKED");
    if (!authState.credentialsSaved) return this.manualAction("CREDENTIALS_REQUIRED");

    if (authMethod !== "PASSWORD") return this.manualAction("AUTH_METHOD_UNKNOWN", true);

    if (resumeIntent) this.options.pauseAutoLive?.();
    this.updateState({ status: "RECOVERING", attemptCount: 1, reason: "SESSION_LOST" });
    const operation = this.options.auth.login()
      .then((result) => this.handleLoginResult(result))
      .catch(() => this.manualAction("AUTH_FAILED"));
    this.inFlight = operation.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async notifyAuthState(authState: AuthState): Promise<AuthRecoveryState> {
    return this.handleAuthState(authState);
  }

  async notifyReadiness(): Promise<AuthRecoveryState> {
    return this.finalizeIfReady();
  }

  private async handleAuthState(authState: AuthState): Promise<AuthRecoveryState> {
    if (authState.status === "SESSION_LOST") return this.handleSessionLost();
    if (!this.episodeActive) return this.getState();
    if (authState.status === "OTP_REQUIRED") {
      return this.updateState({ status: "WAITING_OTP", reason: "OTP_REQUIRED" });
    }
    if (authState.status === "GOOGLE_OAUTH_PENDING") {
      return this.updateState({ status: "GOOGLE_OAUTH_REQUIRED", reason: "GOOGLE_OAUTH_REQUIRED" });
    }
    if (authState.status === "MANUAL_CHALLENGE") {
      this.options.haltAutoLive?.();
      return this.manualAction("MANUAL_CHALLENGE", true);
    }
    if (authState.status === "AUTH_FAILED") return this.manualAction("AUTH_FAILED");
    if (authState.status === "AUTH_UNKNOWN") {
      return this.manualAction("AUTH_UNKNOWN", true);
    }
    if (authState.status === "AUTHENTICATED") return this.finalizeIfReady();
    return this.getState();
  }

  private async handleLoginResult(authState: AuthState): Promise<AuthRecoveryState> {
    if (authState.status === "OTP_REQUIRED") return this.updateState({ status: "WAITING_OTP", reason: "OTP_REQUIRED" });
    if (authState.status === "AUTHENTICATED") return this.finalizeIfReady();
    if (authState.status === "MANUAL_CHALLENGE") {
      this.options.haltAutoLive?.();
      return this.manualAction("MANUAL_CHALLENGE", true);
    }
    return this.manualAction(authState.status, authState.status === "AUTH_UNKNOWN");
  }

  private async finalizeIfReady(): Promise<AuthRecoveryState> {
    if (!this.episodeActive || this.options.auth.getState().status !== "AUTHENTICATED") return this.getState();
    const readiness = this.options.getReadiness?.(
      new Date(this.recoveryStartedAtMs ?? this.now().getTime()),
    ) ?? { freshRead: false, resilienceHealthy: false };
    if (!readiness.freshRead || !readiness.resilienceHealthy) return this.getState();

    const resumeIntent = this.state.resumeIntent;
    try {
      if (resumeIntent) this.options.resumeAutoLive?.();
      await this.options.onRecovered?.();
      this.episodeActive = false;
      this.recoveryStartedAtMs = null;
      return this.updateState({ status: "RECOVERED", reason: null });
    } catch {
      this.options.haltAutoLive?.();
      return this.manualAction("RECOVERY_RESUME_FAILED");
    }
  }

  private manualAction(reason: string, hardHalt = false): AuthRecoveryState {
    const autoLiveStatus = this.options.getAutoLiveStatus?.() ?? "DISARMED";
    if (hardHalt && autoLiveStatus !== "DISARMED") this.options.haltAutoLive?.();
    else if (!hardHalt && RESUMABLE_STATES.has(autoLiveStatus)) this.options.pauseAutoLive?.();
    this.episodeActive = true;
    return this.updateState({ status: "MANUAL_ACTION", reason });
  }

  private updateState(input: {
    status: AuthRecoveryStatus;
    attemptCount?: number;
    resumeIntent?: boolean;
    reason: string | null;
  }): AuthRecoveryState {
    this.state = AuthRecoveryStateSchema.parse({
      ...this.state,
      status: input.status,
      attemptCount: input.attemptCount ?? this.state.attemptCount,
      resumeIntent: input.resumeIntent ?? this.state.resumeIntent,
      reason: input.reason,
      updatedAt: this.now().toISOString(),
    });
    this.options.events.publish({
      version: 1,
      type: "auth.recovery.state",
      timestamp: this.state.updatedAt,
      payload: this.state,
    });
    this.options.logger.info({
      recoveryStatus: this.state.status,
      attemptCount: this.state.attemptCount,
      resumeIntent: this.state.resumeIntent,
      reason: this.state.reason,
    }, "Authentication recovery state changed.");
    return this.getState();
  }
}
