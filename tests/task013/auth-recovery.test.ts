import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRecoveryController } from "../../apps/server/src/auth/auth-recovery-controller.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { AuthStateSchema, type AuthMethod, type AuthState } from "../../packages/shared/src/protocol.js";
import type { AuthService } from "../../apps/server/src/auth/auth-service.js";
import type { EncryptedCredentialVault } from "../../apps/server/src/vault/encrypted-vault.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

function state(status: AuthState["status"], authMethod: AuthMethod = "PASSWORD", credentialsSaved = true): AuthState {
  return AuthStateSchema.parse({
    status,
    authProvider: "KCEX",
    authMethod,
    credentialsSaved,
    liveTrading: false,
    updatedAt: NOW.toISOString(),
  });
}

interface HarnessOptions {
  authMethod?: AuthMethod;
  credentialsSaved?: boolean;
  vaultUnlocked?: boolean;
  autoLiveStatus?: string;
  mutationInFlight?: boolean;
  hardHalted?: boolean;
  loginResult?: AuthState["status"];
  ready?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const events = new EventBus();
  let current = state("SESSION_LOST", options.authMethod ?? "PASSWORD", options.credentialsSaved ?? true);
  let ready = options.ready ?? true;
  const login = vi.fn(async () => {
    current = state(options.loginResult ?? "AUTHENTICATED", options.authMethod ?? "PASSWORD", options.credentialsSaved ?? true);
    return current;
  });
  const auth = {
    getState: () => current,
    getAuthMethod: () => options.authMethod ?? "PASSWORD",
    login,
  } as unknown as AuthService;
  const vault = { isUnlocked: options.vaultUnlocked ?? true } as unknown as EncryptedCredentialVault;
  let autoLiveStatus = options.autoLiveStatus ?? "ARMED";
  let pauseCalls = 0;
  let resumeCalls = 0;
  let haltCalls = 0;
  let mutationUnknownCalls = 0;
  const controller = new AuthRecoveryController({
    auth,
    vault,
    events,
    logger,
    now: () => new Date(NOW),
    getAutoLiveStatus: () => autoLiveStatus,
    getMutationInFlight: () => options.mutationInFlight ?? false,
    getHardHalted: () => options.hardHalted ?? false,
    pauseAutoLive: () => { pauseCalls += 1; autoLiveStatus = "PAUSED_AUTH"; },
    resumeAutoLive: () => { resumeCalls += 1; autoLiveStatus = "ARMED"; },
    haltAutoLive: () => { haltCalls += 1; autoLiveStatus = "HALTED"; },
    markMutationUnknown: () => { mutationUnknownCalls += 1; },
    getReadiness: () => ({ freshRead: ready, resilienceHealthy: ready }),
  });
  return {
    controller,
    auth,
    login,
    events,
    setAuth(next: AuthState) { current = next; },
    setReady(next: boolean) { ready = next; },
    calls: {
      get pause() { return pauseCalls; },
      get resume() { return resumeCalls; },
      get halt() { return haltCalls; },
      get mutationUnknown() { return mutationUnknownCalls; },
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

describe("TASK-013 bounded authentication recovery", () => {
  it("performs one password login and resumes an armed runtime after fresh recovery", async () => {
    const h = harness();
    cleanups.push(() => h.controller.close());
    const recovered = await h.controller.handleSessionLost();
    expect(recovered.status).toBe("RECOVERED");
    expect(h.login).toHaveBeenCalledTimes(1);
    expect(h.calls.pause).toBe(1);
    expect(h.calls.resume).toBe(1);
  });

  it("is single-flight when the same loss episode is reported twice", async () => {
    let release!: (next: AuthState) => void;
    const h = harness();
    h.login.mockImplementation(() => new Promise<AuthState>((resolve) => { release = resolve; }));
    cleanups.push(() => h.controller.close());
    const first = h.controller.handleSessionLost();
    const second = await h.controller.handleSessionLost();
    expect(second.status).toBe("RECOVERING");
    expect(h.login).toHaveBeenCalledTimes(1);
    h.setAuth(state("AUTHENTICATED", "PASSWORD"));
    release(state("AUTHENTICATED", "PASSWORD"));
    expect((await first).status).toBe("RECOVERED");
  });

  it("allows one new attempt only after the previous loss episode is recovered", async () => {
    const h = harness();
    cleanups.push(() => h.controller.close());
    await h.controller.handleSessionLost();
    h.setAuth(state("SESSION_LOST", "PASSWORD"));
    await h.controller.handleSessionLost();
    expect(h.login).toHaveBeenCalledTimes(2);
  });

  it("pauses for OTP and resumes only after the user completes it", async () => {
    const h = harness({ loginResult: "OTP_REQUIRED" });
    cleanups.push(() => h.controller.close());
    expect((await h.controller.handleSessionLost()).status).toBe("WAITING_OTP");
    expect(h.login).toHaveBeenCalledTimes(1);
    h.setAuth(state("AUTHENTICATED", "PASSWORD"));
    expect((await h.controller.notifyAuthState(state("AUTHENTICATED", "PASSWORD"))).status).toBe("RECOVERED");
  });

  it("does not retry after the user supplied OTP ends in AUTH_FAILED", async () => {
    const h = harness({ loginResult: "OTP_REQUIRED" });
    cleanups.push(() => h.controller.close());
    await h.controller.handleSessionLost();
    h.setAuth(state("AUTH_FAILED", "PASSWORD"));
    expect((await h.controller.notifyAuthState(state("AUTH_FAILED", "PASSWORD"))).status).toBe("MANUAL_ACTION");
    expect(h.login).toHaveBeenCalledTimes(1);
  });

  it("routes Google session loss to manual OAuth without reading Vault credentials", async () => {
    const h = harness({ authMethod: "GOOGLE", credentialsSaved: false });
    cleanups.push(() => h.controller.close());
    expect((await h.controller.handleSessionLost()).status).toBe("GOOGLE_OAUTH_REQUIRED");
    expect(h.login).not.toHaveBeenCalled();
    expect(h.calls.pause).toBe(1);
  });

  it("finishes the Google path only after a manual authenticated event", async () => {
    const h = harness({ authMethod: "GOOGLE", credentialsSaved: false });
    cleanups.push(() => h.controller.close());
    await h.controller.handleSessionLost();
    h.setAuth(state("AUTHENTICATED", "GOOGLE", false));
    expect((await h.controller.notifyAuthState(state("AUTHENTICATED", "GOOGLE", false))).status).toBe("RECOVERED");
    expect(h.login).not.toHaveBeenCalled();
  });

  it("stops without login when the Vault is locked", async () => {
    const h = harness({ vaultUnlocked: false });
    cleanups.push(() => h.controller.close());
    const result = await h.controller.handleSessionLost();
    expect(result).toMatchObject({ status: "MANUAL_ACTION", reason: "VAULT_LOCKED", attemptCount: 0 });
    expect(h.login).not.toHaveBeenCalled();
    expect(h.calls.pause).toBe(1);
  });

  it("stops without login when credentials are not saved", async () => {
    const h = harness({ credentialsSaved: false });
    cleanups.push(() => h.controller.close());
    const result = await h.controller.handleSessionLost();
    expect(result).toMatchObject({ status: "MANUAL_ACTION", reason: "CREDENTIALS_REQUIRED", attemptCount: 0 });
    expect(h.login).not.toHaveBeenCalled();
    expect(h.calls.pause).toBe(1);
  });

  it("halts on a challenge returned by the single password attempt", async () => {
    const h = harness({ loginResult: "MANUAL_CHALLENGE" });
    cleanups.push(() => h.controller.close());
    expect((await h.controller.handleSessionLost()).status).toBe("MANUAL_ACTION");
    expect(h.controller.getState().reason).toBe("MANUAL_CHALLENGE");
    expect(h.calls.halt).toBeGreaterThan(0);
  });

  it("halts on AUTH_UNKNOWN and never turns evidence failure into a retry loop", async () => {
    const h = harness({ loginResult: "AUTH_UNKNOWN" });
    cleanups.push(() => h.controller.close());
    expect((await h.controller.handleSessionLost()).status).toBe("MANUAL_ACTION");
    expect(h.login).toHaveBeenCalledTimes(1);
    expect(h.calls.halt).toBeGreaterThan(0);
  });

  it("does not auto recover while a mutation is in flight", async () => {
    const h = harness({ autoLiveStatus: "SUBMITTING", mutationInFlight: true });
    cleanups.push(() => h.controller.close());
    const result = await h.controller.handleSessionLost();
    expect(result.reason).toBe("MUTATION_IN_FLIGHT");
    expect(h.login).not.toHaveBeenCalled();
    expect(h.calls.halt).toBe(1);
    expect(h.calls.mutationUnknown).toBe(1);
  });

  it("does not resume a disarmed runtime after a successful credential recovery", async () => {
    const h = harness({ autoLiveStatus: "DISARMED" });
    cleanups.push(() => h.controller.close());
    expect((await h.controller.handleSessionLost()).status).toBe("RECOVERED");
    expect(h.calls.pause).toBe(0);
    expect(h.calls.resume).toBe(0);
  });

  it("waits for a fresh reader and healthy resilience before resuming", async () => {
    const h = harness({ ready: false });
    cleanups.push(() => h.controller.close());
    expect((await h.controller.handleSessionLost()).status).toBe("RECOVERING");
    h.setReady(true);
    h.setAuth(state("AUTHENTICATED", "PASSWORD"));
    expect((await h.controller.notifyReadiness()).status).toBe("RECOVERED");
  });

  it("preserves the armed intent while refusing an unsafe automation state", async () => {
    const h = harness({ autoLiveStatus: "POSITION_OPEN" });
    cleanups.push(() => h.controller.close());
    const result = await h.controller.handleSessionLost();
    expect(result).toMatchObject({ status: "MANUAL_ACTION", reason: "AUTO_LIVE_UNSAFE_STATE", resumeIntent: false });
    expect(h.login).not.toHaveBeenCalled();
  });
});
