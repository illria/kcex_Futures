import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../../apps/server/src/auth/auth-service.js";
import type { AuthAdapter, AuthAdapterResult, AuthCredentials } from "../../apps/server/src/auth/auth-adapter.js";
import { AuthRecoveryController } from "../../apps/server/src/auth/auth-recovery-controller.js";
import { subscribeAuthRuntime } from "../../apps/server/src/auth/auth-runtime-subscriber.js";
import { AutoLiveOrchestrator } from "../../apps/server/src/kcex-live/auto-live-orchestrator.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { EncryptedCredentialVault } from "../../apps/server/src/vault/encrypted-vault.js";
import type { FuturesReadStatus } from "../../packages/shared/src/protocol.js";
import { LIVE_AUTOMATION_CONFIRMATION_PHRASE } from "../../packages/shared/src/live-launch.js";
import { readyLivePreflight } from "./helpers.js";

const MASTER_KEY = "task013-otp-integration-master-key";
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

class RecoveryFixtureAdapter implements AuthAdapter {
  readonly provider = "KCEX" as const;
  private loginCount = 0;

  constructor(private readonly recoveryResult: Extract<AuthAdapterResult, "OTP_REQUIRED" | "MANUAL_CHALLENGE">) {}

  async login(_credentials: AuthCredentials): Promise<AuthAdapterResult> {
    this.loginCount += 1;
    return this.loginCount === 1 ? "AUTHENTICATED" : this.recoveryResult;
  }

  async submitOtp(_candidate: Buffer): Promise<AuthAdapterResult> {
    return "AUTHENTICATED";
  }

  async checkSession(): Promise<AuthAdapterResult> {
    return "SESSION_LOST";
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for auth recovery integration state.");
}

interface IntegrationHarness {
  auth: AuthService;
  autoLive: AutoLiveOrchestrator;
  controller: AuthRecoveryController;
  events: EventBus;
  setReady(value: boolean): void;
  unsubscribe(): void;
  close(): Promise<void>;
}

async function createHarness(
  recoveryResult: Extract<AuthAdapterResult, "OTP_REQUIRED" | "MANUAL_CHALLENGE">,
  arm: boolean,
): Promise<IntegrationHarness> {
  const directory = await mkdtemp(join(tmpdir(), "task013-auth-recovery-integration-"));
  const vault = new EncryptedCredentialVault(join(directory, "credentials.vault.json"));
  const events = new EventBus();
  const adapter = new RecoveryFixtureAdapter(recoveryResult);
  const auth = new AuthService(vault, events, logger, adapter);
  await auth.unlock(MASTER_KEY);
  await auth.saveCredentials("fixture@example.test", "fixture-password", false);
  expect((await auth.login()).status).toBe("AUTHENTICATED");

  let ready = true;
  const autoLive = new AutoLiveOrchestrator({
    events,
    getPreflight: () => readyLivePreflight({ authStatus: auth.getState().status, readFresh: ready }),
  });
  autoLive.configureProtection({
    takeProfit: { basis: "PRICE_PCT", value: 1 },
    stopLoss: { basis: "ROI_PCT", value: 10 },
  });
  if (arm) autoLive.arm(LIVE_AUTOMATION_CONFIRMATION_PHRASE);

  const futuresRead = {
    start: () => undefined,
    stop: (_status?: FuturesReadStatus) => undefined,
  };
  let controller: AuthRecoveryController | undefined;
  const unsubscribe = subscribeAuthRuntime({
    events,
    futuresRead,
    getAutoLive: () => autoLive,
    getAuthRecovery: () => controller,
  });
  controller = new AuthRecoveryController({
    auth,
    vault,
    events,
    logger,
    getAutoLiveStatus: () => autoLive.getState().status,
    getMutationInFlight: () => false,
    getHardHalted: () => ["HALTED", "MANUAL_ACTION"].includes(autoLive.getState().status),
    pauseAutoLive: () => { autoLive.pauseForAuth(); },
    resumeAutoLive: () => { autoLive.resumeAfterAuth(); },
    haltAutoLive: () => { autoLive.halt(); },
    getReadiness: () => ({ freshRead: ready, resilienceHealthy: ready }),
  });
  if (!controller) throw new Error("Auth recovery controller was not created.");

  return {
    auth,
    autoLive,
    controller,
    events,
    setReady(value: boolean) { ready = value; },
    unsubscribe,
    async close() {
      unsubscribe();
      controller?.close();
      auth.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

describe("TASK-013 auth recovery integration", () => {
  it("keeps an armed runtime paused through recovery OTP and resumes after readiness", async () => {
    const h = await createHarness("OTP_REQUIRED", true);
    cleanups.push(h.close);

    await h.auth.handleRuntimeSignal("SESSION_LOST");
    await waitFor(() => h.controller.getState().status === "WAITING_OTP");
    expect(h.autoLive.getState().status).toBe("PAUSED_AUTH");

    h.setReady(false);
    expect((await h.auth.submitOtp(Buffer.from("123456", "utf8"))).status).toBe("AUTHENTICATED");
    await waitFor(() => h.auth.getState().status === "AUTHENTICATED");
    expect(h.autoLive.getState().status).toBe("PAUSED_AUTH");
    expect(h.controller.getState().status).toBe("WAITING_OTP");

    h.setReady(true);
    expect((await h.controller.notifyReadiness()).status).toBe("RECOVERED");
    expect(h.autoLive.getState().status).toBe("ARMED");
  });

  it("hard stops an armed runtime when recovery login reaches a manual challenge", async () => {
    const h = await createHarness("MANUAL_CHALLENGE", true);
    cleanups.push(h.close);

    await h.auth.handleRuntimeSignal("SESSION_LOST");
    await waitFor(() => h.controller.getState().status === "MANUAL_ACTION");
    expect(["HALTED", "MANUAL_ACTION"]).toContain(h.autoLive.getState().status);
    expect(h.controller.getState().resumeIntent).toBe(true);
    expect(h.autoLive.getState().status).not.toBe("PAUSED_AUTH");
  });

  it("keeps a disarmed runtime disarmed across recovery OTP success", async () => {
    const h = await createHarness("OTP_REQUIRED", false);
    cleanups.push(h.close);

    await h.auth.handleRuntimeSignal("SESSION_LOST");
    await waitFor(() => h.controller.getState().status === "WAITING_OTP");
    expect(h.autoLive.getState().status).toBe("DISARMED");
    expect((await h.auth.submitOtp(Buffer.from("123456", "utf8"))).status).toBe("AUTHENTICATED");
    expect((await h.controller.notifyReadiness()).status).toBe("RECOVERED");
    expect(h.autoLive.getState().status).toBe("DISARMED");
  });

  it("fails closed for an OTP signal that is not owned by recovery", async () => {
    const h = await createHarness("OTP_REQUIRED", true);
    cleanups.push(h.close);

    await h.auth.handleRuntimeSignal("OTP_REQUIRED");
    expect(h.autoLive.getState().status).toBe("MANUAL_ACTION");
    expect(h.controller.getState().status).toBe("IDLE");
  });
});
