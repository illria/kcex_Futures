import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../../apps/server/src/auth/auth-service.js";
import { FakeAuthAdapter } from "../../apps/server/src/auth/fake-auth-adapter.js";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { FuturesReadService } from "../../apps/server/src/futures/futures-read-service.js";
import type { FuturesReadDiagnostics, FuturesSnapshotResult } from "../../apps/server/src/futures/kcex-futures-read-adapter.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { RuntimeResilienceService } from "../../apps/server/src/resilience/runtime-resilience-service.js";
import { EncryptedSessionStore } from "../../apps/server/src/session/encrypted-session-store.js";
import { StorageService } from "../../apps/server/src/storage/storage-service.js";
import { EncryptedCredentialVault } from "../../apps/server/src/vault/encrypted-vault.js";
import { createFakeFuturesSnapshot } from "../../packages/shared/src/fake-snapshot.js";
import { AuthStateSchema, parseDashboardEvent, type AuthState, type BrowserHealthInspection } from "../../packages/shared/src/protocol.js";
import { SCHEMA_VERSION } from "../../apps/server/src/storage/migrations.js";
import type { AuthService as AuthServiceType } from "../../apps/server/src/auth/auth-service.js";

const nowIso = "2026-10-01T00:00:00.000Z";
const healthyBrowser: BrowserHealthInspection = {
  browserConnected: true,
  pageAvailable: true,
  pageClosed: false,
  trustedPage: true,
};
const noMissingEvidence: FuturesReadDiagnostics = {
  authenticated: true,
  trustedPage: true,
  loginControlsVisible: false,
  challengeVisible: false,
  evidence: { symbol: true, market: true, account: true, contract: true, position: true, openOrders: true },
  missingFields: [],
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function memoryStorage(now: () => Date = () => new Date(nowIso)): Promise<StorageService> {
  const storage = new StorageService({ databaseFile: ":memory:", now });
  await storage.initialize();
  cleanups.push(() => storage.close());
  return storage;
}

function authStub(
  status: AuthState["status"] = "AUTHENTICATED",
  provider: AuthState["authProvider"] = "KCEX",
  browser: BrowserHealthInspection = healthyBrowser,
): AuthServiceType {
  const state = AuthStateSchema.parse({
    status,
    authProvider: provider,
    credentialsSaved: false,
    liveTrading: false,
    updatedAt: nowIso,
  });
  return {
    getState: () => state,
    inspectBrowserHealth: () => browser,
    handleRuntimeSignal: async () => state,
  } as unknown as AuthServiceType;
}

function kcexSnapshot(updatedAt = nowIso) {
  const fixture = createFakeFuturesSnapshot(updatedAt);
  return {
    ...fixture,
    source: "KCEX" as const,
    market: { ...fixture.market, source: "KCEX" as const },
    account: { ...fixture.account, source: "KCEX" as const },
    contract: { ...fixture.contract, source: "KCEX" as const },
    position: { ...fixture.position, source: "KCEX" as const },
    openOrders: {
      ...fixture.openOrders,
      source: "KCEX" as const,
      orders: fixture.openOrders.orders.map((order) => ({ ...order, source: "KCEX" as const })),
    },
  };
}

function readService(
  result: FuturesSnapshotResult | (() => FuturesSnapshotResult),
  options: { enabled?: boolean; pollMs?: number; now?: () => Date } = {},
): FuturesReadService {
  return new FuturesReadService({
    adapter: { readSnapshot: async () => typeof result === "function" ? result() : result },
    events: new EventBus(),
    logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
    authStatus: () => "AUTHENTICATED",
    enabled: options.enabled ?? true,
    pollMs: options.pollMs ?? 5_000,
    now: options.now,
  });
}

describe("TASK-012 long-running resilience state", () => {
  it("keeps FAKE and read-only-disabled configurations IDLE", async () => {
    const storage = await memoryStorage();
    const fake = new RuntimeResilienceService({
      auth: authStub("AUTHENTICATED", "FAKE"),
      futuresRead: readService({ status: "READY", snapshot: kcexSnapshot() }, { enabled: false }),
      storage,
      events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(nowIso),
    });
    expect((await fake.recover()).status).toBe("IDLE");

    const disabled = new RuntimeResilienceService({
      auth: authStub(),
      futuresRead: readService({ status: "READY", snapshot: kcexSnapshot() }, { enabled: false }),
      storage,
      events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(nowIso),
    });
    expect((await disabled.recover()).status).toBe("IDLE");
    expect(disabled.getState().automaticLogin).toBe(false);
    expect(disabled.getState().automaticTrading).toBe(false);
  });

  it("ages long poll intervals using max(15 seconds, poll interval times three)", async () => {
    let now = new Date(nowIso);
    const storage = await memoryStorage(() => new Date(now));
    const reader = readService(
      { status: "READY", snapshot: kcexSnapshot(now.toISOString()), diagnostics: noMissingEvidence },
      { pollMs: 60_000, now: () => new Date(now) },
    );
    expect(reader.staleAfterMs).toBe(180_000);
    await reader.pollOnce();
    expect(reader.getLatestSnapshot(new Date(now.getTime() + 179_999))?.freshness).toBe("FRESH");
    expect(reader.getLatestSnapshot(new Date(now.getTime() + 180_000))?.freshness).toBe("STALE");

    now = new Date(now.getTime() + 180_000);
    const resilience = new RuntimeResilienceService({
      auth: authStub(), futuresRead: reader, storage, events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(now),
    });
    const state = await resilience.recover();
    expect(state.status).toBe("DEGRADED");
    expect(state.reasons).toContain("READ_STALE");
  });

  it("marks repeated missing selector evidence as suspected at the third consecutive read and recovers only after valid evidence", async () => {
    let now = new Date(nowIso);
    let result: FuturesSnapshotResult = {
      status: "UNKNOWN",
      diagnostics: { ...noMissingEvidence, evidence: { ...noMissingEvidence.evidence, market: false }, missingFields: ["lastPrice"] },
    };
    const reader = readService(() => result, { now: () => new Date(now) });
    await reader.pollOnce();
    expect(reader.getSelectorDriftObservation().consecutiveEvidenceFailures).toBe(1);
    await reader.pollOnce();
    expect(reader.getSelectorDriftObservation().suspected).toBe(false);
    await reader.pollOnce();
    expect(reader.getSelectorDriftObservation()).toEqual({
      suspected: true,
      consecutiveEvidenceFailures: 3,
      missingFields: ["lastPrice"],
    });
    expect(reader.getBrowserStatus()).toBe("STOPPED");

    const storage = await memoryStorage();
    const resilience = new RuntimeResilienceService({
      auth: authStub(), futuresRead: reader, storage, events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(now),
    });
    expect((await resilience.recover()).status).toBe("MANUAL_ACTION");

    result = { status: "READY", snapshot: kcexSnapshot(), diagnostics: noMissingEvidence };
    now = new Date(now.getTime() + 1_000);
    await reader.pollOnce();
    expect(reader.getSelectorDriftObservation().suspected).toBe(false);
    expect((await resilience.recover()).status).toBe("HEALTHY");
  });

  it("turns AUTH_UNKNOWN and the read failure limit into bounded DEGRADED reasons", async () => {
    let now = new Date(nowIso);
    const storage = await memoryStorage();
    const authUnknown = new RuntimeResilienceService({
      auth: authStub("AUTH_UNKNOWN"), futuresRead: readService({ status: "UNKNOWN" }), storage, events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(nowIso),
    });
    expect((await authUnknown.recover()).reasons).toContain("AUTH_UNKNOWN");

    const reader = readService({ status: "UNKNOWN", reason: "insufficient evidence" });
    const resilience = new RuntimeResilienceService({
      auth: authStub(), futuresRead: reader, storage, events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(now),
    });
    await reader.pollOnce();
    expect((await resilience.recover()).reasons).toContain("READ_FAILURE");
    await reader.pollOnce();
    await reader.pollOnce();
    expect(reader.getReadState().consecutiveReadFailures).toBe(3);
    now = new Date(now.getTime() + 2_000);
    expect((await resilience.recover()).reasons).toContain("READ_FAILURE_LIMIT");
  });

  it.each([
    ["SESSION_LOST", "MANUAL_ACTION", "AUTH_SESSION_LOST"],
    ["OTP_REQUIRED", "MANUAL_ACTION", "OTP_REQUIRED"],
    ["MANUAL_CHALLENGE", "MANUAL_ACTION", "MANUAL_CHALLENGE"],
    ["AUTH_UNKNOWN", "DEGRADED", "AUTH_UNKNOWN"],
  ] as const)("maps authentication state %s to a bounded resilience reason", async (authStatus, expectedStatus, reason) => {
    const storage = await memoryStorage();
    const resilience = new RuntimeResilienceService({
      auth: authStub(authStatus), futuresRead: readService({ status: "UNKNOWN" }), storage,
      events: new EventBus(), logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(nowIso),
    });
    const state = await resilience.recover();
    expect(state.status).toBe(expectedStatus);
    expect(state.reasons).toContain(reason);
  });

  it("propagates only terminal read signals into the bounded authentication signal handler", async () => {
    const signals: string[] = [];
    const service = new FuturesReadService({
      adapter: { readSnapshot: async () => ({ status: "SESSION_LOST" }) },
      events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      authStatus: () => "AUTHENTICATED",
      enabled: true,
      pollMs: 5_000,
      onRuntimeSignal: (signal) => { signals.push(signal); },
      now: () => new Date(nowIso),
    });
    await service.pollOnce();
    expect(signals).toEqual(["SESSION_LOST"]);
    expect(service.getBrowserStatus()).toBe("STOPPED");
  });

  it.each(["AUTH_UNKNOWN", "AUTH_FAILED", "OTP_REQUIRED"] as const)(
    "does not relabel %s as a conclusively lost KCEX session",
    async (authStatus) => {
      let currentStatus: AuthState["status"] = "AUTHENTICATED";
      const service = new FuturesReadService({
        adapter: { readSnapshot: async () => ({ status: "READY", snapshot: kcexSnapshot() }) },
        events: new EventBus(),
        logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
        authStatus: () => currentStatus,
        enabled: true,
        pollMs: 5_000,
        now: () => new Date(nowIso),
      });
      currentStatus = authStatus;
      await service.pollOnce();
      expect(service.getReadState().status).toBe("UNKNOWN");
      expect(service.getBrowserStatus()).toBe("STOPPED");
    },
  );

  it("halts on disconnected, unavailable, or untrusted browser health without restarting it", async () => {
    for (const [browser, reason] of [
      [{ ...healthyBrowser, browserConnected: false }, "BROWSER_DISCONNECTED"],
      [{ ...healthyBrowser, pageAvailable: false }, "PAGE_UNAVAILABLE"],
      [{ ...healthyBrowser, pageClosed: true, pageAvailable: false }, "PAGE_UNAVAILABLE"],
      [{ ...healthyBrowser, trustedPage: false }, "UNTRUSTED_HOST"],
    ] as const) {
      const storage = await memoryStorage();
      const reader = readService({ status: "READY", snapshot: kcexSnapshot(), diagnostics: noMissingEvidence });
      await reader.pollOnce();
      const resilience = new RuntimeResilienceService({
        auth: authStub("AUTHENTICATED", "KCEX", browser), futuresRead: reader, storage,
        events: new EventBus(), logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
        now: () => new Date(nowIso),
      });
      const state = await resilience.recover();
      expect(state.status).toBe("HALTED");
      expect(state.reasons).toContain(reason);
      expect(reader.getBrowserStatus()).toBe("STOPPED");
      await storage.close();
    }
  });

  it("halts closed when persistent storage health degrades", async () => {
    const storage = await memoryStorage();
    const reader = readService({ status: "READY", snapshot: kcexSnapshot(), diagnostics: noMissingEvidence });
    await reader.pollOnce();
    storage.close();
    const resilience = new RuntimeResilienceService({
      auth: authStub(), futuresRead: reader, storage, events: new EventBus(),
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
      now: () => new Date(nowIso),
    });
    const state = await resilience.recover();
    expect(state.status).toBe("HALTED");
    expect(state.reasons).toContain("STORAGE_DEGRADED");
    expect(reader.getBrowserStatus()).toBe("STOPPED");
  });

  it("deduplicates persisted transition audits and exposes RESILIENCE through the v4 repository", async () => {
    const storage = await memoryStorage();
    const auditFailureNames: string[] = [];
    const resilience = new RuntimeResilienceService({
      auth: authStub("AUTH_UNKNOWN"), futuresRead: readService({ status: "UNKNOWN" }), storage,
      events: new EventBus(), logger: {
        info: () => undefined,
        warn: (fields: { errorName?: string }) => { if (fields.errorName) auditFailureNames.push(fields.errorName); },
      } as unknown as Logger,
      now: () => new Date(nowIso),
    });
    await resilience.recover();
    await resilience.recover();
    expect(auditFailureNames).toEqual([]);
    const auditEvents = storage.auditEvents.listAuditEvents({ limit: 10 }).filter((event) => event.category === "RESILIENCE");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.payload).toHaveProperty("reasons");
    expect(auditEvents[0]?.payload).not.toHaveProperty("reasonCodes");
    expect(SCHEMA_VERSION).toBe(4);
  });

  it("keeps only safe diagnostics and resilience source has no recovery or mutation calls", async () => {
    const source = await readFile(resolve(process.cwd(), "apps/server/src/resilience/runtime-resilience-service.ts"), "utf8");
    expect(source).not.toMatch(/\.(login|submitOtp|click|fill|press|type|check|uncheck|selectOption|drag|setInputFiles|placeOrder|launch|newPage|goto)\s*\(/i);
    expect(source).not.toMatch(/captcha\s*(?:bypass|solve)/i);
    expect(noMissingEvidence).not.toHaveProperty("html");
    expect(noMissingEvidence).not.toHaveProperty("url");
    expect(noMissingEvidence).not.toHaveProperty("cookies");
  });

  it("keeps CI on fake, read-only-disabled, fixture execution, and LIVE_TRADING=false defaults", async () => {
    const workflow = await readFile(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain('LIVE_TRADING: "false"');
    expect(workflow).toContain('LIVE_EXECUTION_PROVIDER: "FIXTURE"');
    expect(workflow).toContain('AUTH_PROVIDER: "FAKE"');
    expect(workflow).toContain('KCEX_READONLY_ENABLED: "false"');
    expect(SCHEMA_VERSION).toBe(4);
  });

  it("serves read-only resilience state over HTTP and the initial WebSocket stream", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "task012-http-"));
    const vault = new EncryptedCredentialVault(join(fixtureDir, "vault.json"));
    const events = new EventBus();
    const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
    const auth = new AuthService(vault, events, logger, new FakeAuthAdapter());
    const storage = await memoryStorage();
    const resilience = new RuntimeResilienceService({ auth, storage, events, logger, now: () => new Date(nowIso) });
    await resilience.recover();
    const server = createDashboardServer({ auth, vault, events, storage, resilience });
    cleanups.push(async () => {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      auth.close();
      storage.close();
      await rm(fixtureDir, { recursive: true, force: true });
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${url}/api/v1/resilience/state`);
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("IDLE");
    const forbiddenWrite = await fetch(`${url}/api/v1/resilience/recover`, { method: "POST" });
    expect(forbiddenWrite.status).toBe(404);

    const received = await new Promise<ReturnType<typeof parseDashboardEvent>[]>((resolveEvents, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/events`, { headers: { origin: url } });
      const eventsSeen: ReturnType<typeof parseDashboardEvent>[] = [];
      socket.once("error", reject);
      socket.on("message", (message) => {
        try {
          eventsSeen.push(parseDashboardEvent(JSON.parse(message.toString())));
          if (eventsSeen.at(-1)?.type === "system.heartbeat") {
            socket.close();
            resolveEvents(eventsSeen);
          }
        } catch (error) {
          socket.close();
          reject(error);
        }
      });
    });
    expect(received.some((event) => event.type === "resilience.state" && event.payload.status === "IDLE")).toBe(true);
    const heartbeat = received.find((event) => event.type === "system.heartbeat");
    expect(heartbeat?.type === "system.heartbeat" && heartbeat.payload.resilienceStatus).toBe("IDLE");
  });

  it("clears the encrypted session on SESSION_LOST without deleting credentials or enabling recovery", async () => {
    const directory = await mkdtemp(join(tmpdir(), "task012-session-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const vault = new EncryptedCredentialVault(join(directory, "vault.json"));
    const sessionStore = new EncryptedSessionStore(vault, join(directory, "session.enc.json"));
    const auth = new AuthService(
      vault,
      new EventBus(),
      { info: () => undefined, warn: () => undefined } as unknown as Logger,
      new FakeAuthAdapter(),
      undefined,
      undefined,
      sessionStore,
    );
    await auth.unlock("task012-master-key-fixture");
    await auth.saveCredentials("fixture@example.test", "fixture-password", true);
    await sessionStore.save({ cookies: [{ name: "fixture", value: "encrypted-only-session" }], origins: [] });
    expect(await sessionStore.hasSession()).toBe(true);
    const state = await auth.handleRuntimeSignal("SESSION_LOST");
    expect(state.status).toBe("SESSION_LOST");
    expect(state.credentialsSaved).toBe(true);
    expect(await sessionStore.hasSession()).toBe(false);
    await sessionStore.save({ cookies: [{ name: "fixture", value: "still-encrypted" }], origins: [] });
    expect((await auth.handleRuntimeSignal("AUTH_UNKNOWN")).status).toBe("AUTH_UNKNOWN");
    expect(await sessionStore.hasSession()).toBe(true);
    expect((await auth.handleRuntimeSignal("MANUAL_CHALLENGE")).status).toBe("MANUAL_CHALLENGE");
    expect((await auth.handleRuntimeSignal("OTP_REQUIRED")).status).toBe("OTP_REQUIRED");
    await expect(auth.handleRuntimeSignal("UNBOUNDED" as never)).rejects.toThrow("Unsupported runtime authentication signal.");
    auth.close();
  });
});
