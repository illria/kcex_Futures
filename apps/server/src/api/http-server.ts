import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { readDashboardPort } from "../../../../packages/shared/src/dashboard-config.js";
import {
  createDashboardSnapshot,
  createExecutionStatePlaceholder,
  createFakeDashboardSnapshot,
  createFakeFuturesSnapshot,
  createRiskStatePlaceholder,
  createUnavailableFuturesSnapshot,
} from "../../../../packages/shared/src/fake-snapshot.js";
import { SchedulerStateSchema, createFixtureSchedulerState } from "../../../../packages/shared/src/scheduler.js";
import {
  MASTER_KEY_MIN_LENGTH,
  DashboardSnapshotSchema,
  ResilienceStateSchema,
  type ResilienceState,
  parseDashboardEvent,
  type AuthState,
  type DashboardEvent,
} from "../../../../packages/shared/src/protocol.js";
import {
  StorageHealthSchema,
  TradeHistoryResponseSchema,
} from "../../../../packages/shared/src/storage.js";
import { createIdlePaperTradingState, PaperTradingStateSchema } from "../../../../packages/shared/src/paper-trading.js";
import { RiskStateSchema } from "../../../../packages/shared/src/risk.js";
import {
  AssistedExecutionStateSchema,
  ExecutionArmInputSchema,
  ExecutionConfirmInputSchema,
  ExecutionDisarmInputSchema,
  ExecutionPreviewInputSchema,
  ExecutionPreviewResponseSchema,
  ExecutionReconcileInputSchema,
} from "../../../../packages/shared/src/execution.js";
import { AuthService } from "../auth/auth-service.js";
import { EventBus } from "../realtime/event-bus.js";
import { EncryptedCredentialVault, VaultLockedError, VaultUnlockError } from "../vault/encrypted-vault.js";
import type { FuturesReadService } from "../futures/futures-read-service.js";
import type { StorageService } from "../storage/storage-service.js";
import type { PaperTradingService } from "../trading/paper-trading-service.js";
import type { RiskService } from "../risk/risk-service.js";
import type { AssistedLiveService } from "../execution/assisted-live-service.js";
import { AssistedExecutionError } from "../execution/execution-errors.js";
import {
  ProtectionConfirmationInputSchema,
  ProtectionIntentSchema,
  ProtectionRuntimeStateSchema,
} from "../../../../packages/shared/src/protection.js";
import type { ProtectionService } from "../protection/protection-service.js";
import { ProtectionServiceError } from "../protection/protection-service.js";
import type { DailySchedulerService } from "../scheduler/daily-scheduler-service.js";
import type { RuntimeResilienceService } from "../resilience/runtime-resilience-service.js";
import { AutoLiveOrchestrator, LiveAutomationBlockedError } from "../kcex-live/auto-live-orchestrator.js";
import {
  createLiveCanaryPlaceholder,
  createLiveAutomationPlaceholder,
  LiveAutomationArmInputSchema,
  LiveAutomationProtectionInputSchema,
  LiveCanaryConfirmInputSchema,
  LiveCanaryPreviewInputSchema,
  KcexVerificationSaveInputSchema,
  type KcexVerificationReport,
} from "../../../../packages/shared/src/live-launch.js";
import type { KcexCanaryService } from "../kcex-live/kcex-canary-service.js";
import type { KcexVerificationReportStore } from "../kcex-live/verification-report-store.js";

const UnlockInputSchema = z.object({
  masterKey: z.string().min(MASTER_KEY_MIN_LENGTH).max(4096),
}).strict();
const CredentialsInputSchema = z
  .object({ account: z.string().trim().min(1).max(320), password: z.string().min(1).max(4096), save: z.boolean() })
  .strict();
const OtpInputSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const EmptyInputSchema = z.object({}).strict();
const MAX_BODY_BYTES = 16 * 1024;

export interface DashboardServerOptions {
  auth: AuthService;
  vault: EncryptedCredentialVault;
  events: EventBus;
  staticRoot?: string;
  startedAt?: number;
  futuresRead?: FuturesReadService;
  storage?: StorageService;
  paperTrading?: PaperTradingService;
  risk?: RiskService;
  execution?: AssistedLiveService;
  protection?: ProtectionService;
  scheduler?: DailySchedulerService;
  resilience?: RuntimeResilienceService;
  liveAutomation?: AutoLiveOrchestrator;
  liveCanary?: KcexCanaryService;
  verificationReportStore?: KcexVerificationReportStore;
  onVerificationReportChanged?: (report: KcexVerificationReport) => void;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(body));
}

function parseRequestBody<Schema extends z.ZodType>(schema: Schema, value: unknown): z.infer<Schema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) throw new HttpError(400, "Invalid request.");
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Expected application/json.");

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
      chunks.push(buffer);
    }

    const body = Buffer.concat(chunks);
    let serialized = "";
    let value: unknown;
    try {
      serialized = body.toString("utf8");
      value = JSON.parse(serialized);
    } catch {
      throw new HttpError(400, "Invalid request.");
    } finally {
      serialized = "";
      body.fill(0);
    }
    if (!isRecord(value)) {
      clearStringFields(value);
      throw new HttpError(400, "Invalid request.");
    }
    return value;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function clearStringFields(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const entry: unknown = value[index];
      if (typeof entry === "string") value[index] = "";
      else clearStringFields(entry);
    }
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string") value[key] = "";
      else clearStringFields(entry);
    }
  }
}

function requireLoopbackHost(request: IncomingMessage): string {
  const rawHost = request.headers.host;
  if (!rawHost) throw new HttpError(403, "Local dashboard host is required.");
  try {
    const hostUrl = new URL(`http://${rawHost}`);
    if (hostUrl.username || hostUrl.password || hostUrl.pathname !== "/" || hostUrl.search || hostUrl.hash) {
      throw new HttpError(403, "Only loopback dashboard hosts are allowed.");
    }
    const hostname = hostUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
      throw new HttpError(403, "Only loopback dashboard hosts are allowed.");
    }
    return hostUrl.host.toLowerCase();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Only loopback dashboard hosts are allowed.");
  }
}

function requireSameOrigin(request: IncomingMessage, originRequired = false): void {
  const rawOrigin = request.headers.origin;
  if (!rawOrigin) {
    if (originRequired) throw new HttpError(403, "Request origin is required.");
    return;
  }
  const host = request.headers.host;
  if (!host) throw new HttpError(403, "Request origin is not allowed.");
  try {
    const origin = new URL(rawOrigin);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:") || origin.host.toLowerCase() !== host.toLowerCase()) {
      throw new HttpError(403, "Request origin is not allowed.");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Request origin is not allowed.");
  }
}

function getStateOrThrow(auth: AuthService): AuthState {
  const state = auth.getState();
  if (state.status === "APP_LOCKED") throw new HttpError(423, "Unlock the local vault first.");
  return state;
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  auth: AuthService,
  vault: EncryptedCredentialVault,
  futuresRead: FuturesReadService | undefined,
  storage: StorageService | undefined,
  paperTrading: PaperTradingService | undefined,
  risk: RiskService | undefined,
  execution: AssistedLiveService | undefined,
  protection: ProtectionService | undefined,
  scheduler: DailySchedulerService | undefined,
  resilience: RuntimeResilienceService | undefined,
  liveAutomation: AutoLiveOrchestrator | undefined,
  liveCanary: KcexCanaryService | undefined,
  verificationReportStore: KcexVerificationReportStore | undefined,
  onVerificationReportChanged: ((report: KcexVerificationReport) => void) | undefined,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const method = request.method ?? "GET";

  if (!url.pathname.startsWith("/api/")) return false;
  const requiresLiveOrigin = method === "POST" && [
    "/api/v1/auth/google/start",
    "/api/v1/live-canary/preview",
    "/api/v1/live-canary/confirm",
    "/api/v1/kcex-verification/report",
    "/api/v1/live-automation/configure",
    "/api/v1/live-automation/arm",
    "/api/v1/live-automation/stop",
    "/api/v1/live/arm",
    "/api/v1/live/disarm",
    "/api/v1/live/preview",
    "/api/v1/live/confirm",
    "/api/v1/live/reconcile",
    "/api/v1/protection/preview",
    "/api/v1/protection/confirm",
  ].includes(url.pathname);
  requireSameOrigin(request, requiresLiveOrigin);

  if (method === "GET" && url.pathname === "/api/v1/kcex-verification/report") {
    sendJson(response, 200, await verificationReportStore?.load() ?? null);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/kcex-verification/report") {
    const raw = await readJson(request);
    try {
      if (!verificationReportStore) throw new HttpError(503, "KCEX verification is unavailable.");
      const state = auth.getState();
      if (state.authProvider !== "KCEX" || state.status !== "AUTHENTICATED" || !futuresRead?.enabled) {
        throw new HttpError(409, "KCEX read-only authentication is required.");
      }
      if (liveAutomation?.getState().liveTrading) {
        throw new HttpError(409, "Read-only verification is unavailable while live trading is enabled.");
      }
      const input = parseRequestBody(KcexVerificationSaveInputSchema, raw);
      const report = await verificationReportStore.saveManual(input);
      onVerificationReportChanged?.(report);
      sendJson(response, 200, report);
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/auth/state") {
    sendJson(response, 200, auth.getState());
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/risk/state") {
    const riskState = risk
      ? await risk.refresh()
      : createRiskStatePlaceholder(new Date().toISOString());
    sendJson(response, 200, RiskStateSchema.parse(riskState));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/live/state") {
    sendJson(response, 200, AssistedExecutionStateSchema.parse(execution?.getState() ?? createExecutionStatePlaceholder()));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/live-automation/state") {
    sendJson(response, 200, liveAutomation ? await liveAutomation.refresh() : createLiveAutomationPlaceholder());
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live-automation/configure") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(LiveAutomationProtectionInputSchema, raw);
      if (!liveAutomation) throw new HttpError(503, "Live automation is unavailable.");
      sendJson(response, 200, liveAutomation.configureProtection(input));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live-automation/arm") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(LiveAutomationArmInputSchema, raw);
      if (!liveAutomation) throw new HttpError(503, "Live automation is unavailable.");
      try {
        await liveAutomation.refresh();
        sendJson(response, 200, liveAutomation.arm(input.confirmation));
      } catch (error) {
        if (error instanceof LiveAutomationBlockedError) {
          sendJson(response, 409, { error: "LIVE_AUTOMATION_BLOCKED", state: error.state });
        } else if (error instanceof Error && error.message === "LIVE_AUTOMATION_CONFIRMATION_MISMATCH") {
          throw new HttpError(400, "Confirmation text did not match.");
        } else {
          throw error;
        }
      }
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live-automation/stop") {
    const raw = await readJson(request);
    try {
      parseRequestBody(EmptyInputSchema, raw);
      if (!liveAutomation) throw new HttpError(503, "Live automation is unavailable.");
      sendJson(response, 200, liveAutomation.stop());
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/live-canary/state") {
    sendJson(response, 200, liveCanary?.getState() ?? createLiveCanaryPlaceholder());
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live-canary/preview") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(LiveCanaryPreviewInputSchema, raw);
      if (!liveCanary) throw new HttpError(503, "Live canary is unavailable.");
      sendJson(response, 200, await liveCanary.createPreview(input));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live-canary/confirm") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(LiveCanaryConfirmInputSchema, raw);
      if (!liveCanary) throw new HttpError(503, "Live canary is unavailable.");
      sendJson(response, 200, await liveCanary.confirm(input));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/scheduler/state") {
    const state = scheduler?.getState() ?? createFixtureSchedulerState();
    sendJson(response, 200, SchedulerStateSchema.parse(state));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/resilience/state") {
    const authState = auth.getState();
    const readState = futuresRead?.getReadState();
    const health = storage?.getHealth();
    const fallback: ResilienceState = ResilienceStateSchema.parse({
      status: authState.authProvider === "FAKE" || !futuresRead?.enabled ? "IDLE" : "DEGRADED",
      reasons: [],
      authStatus: authState.status,
      browserStatus: futuresRead?.getBrowserStatus() ?? "NOT_STARTED",
      browserHealth: auth.inspectBrowserHealth(),
      readStatus: readState?.status ?? null,
      readHealth: readState?.health ?? "UNKNOWN",
      consecutiveReadFailures: readState?.consecutiveReadFailures ?? 0,
      lastReadAttemptAt: futuresRead?.getLastReadAttemptAt() ?? null,
      lastHealthyAt: null,
      lastRecoveryAt: null,
      selectorDrift: futuresRead?.getSelectorDriftObservation() ?? {
        suspected: false, consecutiveEvidenceFailures: 0, missingFields: [],
      },
      storageStatus: health?.status ?? "DEGRADED",
      readStaleAfterMs: futuresRead?.staleAfterMs ?? 15_000,
      automaticLogin: false,
      automaticTrading: false,
      updatedAt: new Date().toISOString(),
    });
    sendJson(response, 200, resilience?.getState() ?? fallback);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live/arm") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(ExecutionArmInputSchema, raw);
      if (!execution) throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
      sendJson(response, 200, execution.armRuntime(input.acknowledgement));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live/disarm") {
    const raw = await readJson(request);
    try {
      parseRequestBody(ExecutionDisarmInputSchema, raw);
      if (!execution) throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
      sendJson(response, 200, execution.disarm());
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live/preview") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(ExecutionPreviewInputSchema, raw);
      if (!execution) throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
      const result = execution.createPreview(input);
      sendJson(response, 200, ExecutionPreviewResponseSchema.parse({
        preview: result.preview,
        confirmationToken: result.confirmationToken,
        state: result.state,
      }));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live/confirm") {
    const raw = await readJson(request);
    let input: { previewId: string; confirmationToken: string } | null = null;
    try {
      input = parseRequestBody(ExecutionConfirmInputSchema, raw);
      if (!execution) throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
      sendJson(response, 200, await execution.confirm(input));
    } finally {
      clearStringFields(raw);
      if (input) {
        input.previewId = "";
        input.confirmationToken = "";
      }
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/live/reconcile") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(ExecutionReconcileInputSchema, raw);
      if (!execution) throw new AssistedExecutionError("EXECUTION_PROVIDER_DISABLED", 503);
      sendJson(response, 200, await execution.reconcile(input.attemptId));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/protection/state") {
    sendJson(response, 200, ProtectionRuntimeStateSchema.parse(protection?.getState() ?? {
      status: "NONE",
      provider: "FIXTURE",
      activePreview: null,
      activePlan: null,
      lastPlan: null,
      reasons: [],
      updatedAt: new Date().toISOString(),
    }));
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/protection/preview") {
    const raw = await readJson(request);
    try {
      const input = parseRequestBody(ProtectionIntentSchema, raw);
      if (!protection) throw new ProtectionServiceError("PROTECTION_PROVIDER_DISABLED", 503);
      sendJson(response, 200, protection.createPreview(input));
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/protection/confirm") {
    const raw = await readJson(request);
    let input: z.infer<typeof ProtectionConfirmationInputSchema> | null = null;
    try {
      input = parseRequestBody(ProtectionConfirmationInputSchema, raw);
      if (!protection) throw new ProtectionServiceError("PROTECTION_PROVIDER_DISABLED", 503);
      sendJson(response, 200, await protection.confirm(input));
    } finally {
      clearStringFields(raw);
      if (input) {
        input.previewId = "";
        input.confirmationToken = "";
      }
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/vault/unlock") {
    const raw = await readJson(request);
    let input: z.infer<typeof UnlockInputSchema> | null = null;
    try {
      input = parseRequestBody(UnlockInputSchema, raw);
      const state = await auth.unlock(input.masterKey);
      sendJson(response, 200, state);
    } finally {
      clearStringFields(raw);
      if (input) input.masterKey = "";
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/vault/credentials") {
    const raw = await readJson(request);
    let input: z.infer<typeof CredentialsInputSchema> | null = null;
    try {
      if (!vault.isUnlocked) throw new HttpError(423, "Unlock the local vault first.");
      input = parseRequestBody(CredentialsInputSchema, raw);
      const result = await auth.saveCredentials(input.account, input.password, input.save);
      sendJson(response, 200, { ok: true, credentialsSaved: result.credentialsSaved });
    } finally {
      clearStringFields(raw);
      if (input) {
        input.account = "";
        input.password = "";
      }
    }
    return true;
  }

  if (method === "DELETE" && url.pathname === "/api/v1/vault/credentials") {
    if (!vault.isUnlocked) throw new HttpError(423, "Unlock the local vault first.");
    const result = await auth.deleteCredentials();
    sendJson(response, 200, {
      ok: true,
      credentialsSaved: result.credentialsSaved,
      auth: auth.getState(),
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/dashboard/snapshot") {
    const state = auth.getState();
    const liveLatest = futuresRead?.getLatestSnapshot();
    const readState = futuresRead?.getReadState();
    const latest = liveLatest
      ?? (state.authProvider === "KCEX" ? createUnavailableFuturesSnapshot() : createFakeFuturesSnapshot());
    let history: z.infer<typeof TradeHistoryResponseSchema>["trades"] = [];
    let storageStatus: "READY" | "DEGRADED" = "DEGRADED";
    let storageFailed = false;
    try {
      if (storage?.isReady) {
        storageStatus = storage.getHealth().status;
        if (storageStatus === "READY") history = storage.getRecentTradeHistory(50);
        else storageFailed = true;
      } else {
        storageFailed = true;
      }
    } catch {
      storageFailed = true;
    }
    const baseSnapshot = createDashboardSnapshot(
      state.status === "AUTHENTICATED",
      latest,
      new Date().toISOString(),
      futuresRead?.enabled ?? false,
      futuresRead?.getBrowserStatus() ?? (state.authProvider === "KCEX" ? "NOT_STARTED" : undefined),
      storageStatus,
      scheduler?.getState() ?? createFixtureSchedulerState(),
    );
    const riskState = risk
      ? await risk.refresh()
      : createRiskStatePlaceholder(new Date().toISOString());
    const liveState = liveAutomation?.getState();
    const automationActive = liveState !== undefined
      && ["ARMED", "WAITING", "DUE", "PRECHECK", "SUBMITTING", "CONFIRMING", "PROTECTING", "POSITION_OPEN"].includes(liveState.status);
    const snapshot = DashboardSnapshotSchema.parse({
      ...baseSnapshot,
      status: {
        ...baseSnapshot.status,
        killSwitch: riskState.killSwitch,
        mode: liveState?.liveTrading ? "LIVE" : "PAPER",
        trading: automationActive ? "ARMED" : "PAUSED",
      },
      liveTrading: liveState?.liveTrading ?? false,
      risk: riskState,
      execution: execution?.getState() ?? createExecutionStatePlaceholder(),
      paper: paperTrading?.getState() ?? createIdlePaperTradingState(new Date().toISOString()),
      history,
    });
    if (storageFailed) {
      snapshot.status.storage = "DEGRADED";
      snapshot.logs = [{
        id: "storage-degraded",
        level: "warn" as const,
        message: "Trade history storage is temporarily unavailable.",
        timestamp: snapshot.logs[0]?.timestamp ?? new Date().toISOString(),
      }, ...snapshot.logs].slice(0, 100);
    }
    if (state.authProvider === "KCEX") {
      snapshot.status.kcex = state.status === "AUTHENTICATED" ? "KCEX_AUTHENTICATED" : "LOGIN_REQUIRED";
      snapshot.status.readHealth = readState?.health ?? "UNKNOWN";
      if (readState) snapshot.status.browser = readState.browserStatus;
      if (!liveLatest) {
        snapshot.logs = [{
          id: "kcex-read-waiting",
          level: "info" as const,
          message: "Waiting for the first authenticated KCEX read-only snapshot; fixture placeholder only.",
          timestamp: snapshot.logs[0]?.timestamp ?? new Date().toISOString(),
        }, ...snapshot.logs].slice(0, 100);
      }
    }
    sendJson(response, 200, snapshot);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/paper/state") {
    sendJson(response, 200, PaperTradingStateSchema.parse(
      paperTrading?.getState() ?? createIdlePaperTradingState(new Date().toISOString()),
    ));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/history/trades") {
    const limitValues = url.searchParams.getAll("limit");
    if (limitValues.length > 1) throw new HttpError(400, "Invalid limit.");
    const parsedLimit = z.coerce.number().int().min(1).max(100).safeParse(limitValues[0] ?? "50");
    if (!parsedLimit.success) throw new HttpError(400, "Invalid limit.");
    if (!storage?.isReady) throw new HttpError(503, "Trade history storage is unavailable.");
    try {
      sendJson(response, 200, TradeHistoryResponseSchema.parse({ trades: storage.getRecentTradeHistory(parsedLimit.data) }));
    } catch {
      throw new HttpError(503, "Trade history storage is unavailable.");
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/storage/health") {
    try {
      const health = storage?.getHealth() ?? { status: "DEGRADED" as const, schemaVersion: null };
      sendJson(response, 200, StorageHealthSchema.parse(health));
    } catch {
      sendJson(response, 200, StorageHealthSchema.parse({ status: "DEGRADED", schemaVersion: null }));
    }
    return true;
  }

  if (method === "GET" && url.pathname === "/api/v1/futures/snapshot") {
    const state = getStateOrThrow(auth);
    if (state.authProvider === "KCEX") {
      if (state.status !== "AUTHENTICATED") throw new HttpError(409, "Authenticated KCEX session required.");
      const latest = futuresRead?.getLatestSnapshot();
      if (!latest) throw new HttpError(503, "KCEX read-only snapshot is not available yet.");
      sendJson(response, 200, latest);
      return true;
    }
    sendJson(response, 200, futuresRead?.getLatestSnapshot() ?? createFakeFuturesSnapshot());
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/session/check") {
    const raw = await readJson(request);
    try {
      parseRequestBody(EmptyInputSchema, raw);
      getStateOrThrow(auth);
      sendJson(response, 200, await auth.checkSession());
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/login") {
    const raw = await readJson(request);
    try {
      parseRequestBody(EmptyInputSchema, raw);
      getStateOrThrow(auth);
      sendJson(response, 200, await auth.login());
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/google/start") {
    const raw = await readJson(request);
    try {
      parseRequestBody(EmptyInputSchema, raw);
      getStateOrThrow(auth);
      sendJson(response, 200, await auth.startGoogleOAuth());
    } finally {
      clearStringFields(raw);
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/v1/auth/otp") {
    const raw = await readJson(request);
    let codeBuffer: Buffer | null = null;
    let input: z.infer<typeof OtpInputSchema> | null = null;
    try {
      getStateOrThrow(auth);
      input = parseRequestBody(OtpInputSchema, raw);
      codeBuffer = Buffer.from(input.code, "utf8");
      input.code = "";
      sendJson(response, 200, await auth.submitOtp(codeBuffer));
    } finally {
      clearStringFields(raw);
      if (input) input.code = "";
      codeBuffer?.fill(0);
    }
    return true;
  }

  sendJson(response, 404, { error: "Not found." });
  return true;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot: string | undefined,
  loopbackHost: string,
): Promise<boolean> {
  if (!staticRoot || request.method !== "GET") return false;
  const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
  const root = resolve(staticRoot);
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let filePath = resolve(root, requested);
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    response.writeHead(403).end();
    return true;
  }

  try {
    if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, "index.html");
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": dashboardContentSecurityPolicy(loopbackHost),
    });
    response.end(content);
    return true;
  } catch {
    if (!extname(pathname)) {
      const indexPath = resolve(root, "index.html");
      const html = await readFile(indexPath).catch(() => null);
      if (html) {
        response.writeHead(200, {
          "content-type": MIME_TYPES[".html"],
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": dashboardContentSecurityPolicy(loopbackHost),
        });
        response.end(html);
        return true;
      }
    }
    response.writeHead(404).end();
    return true;
  }
}

function dashboardContentSecurityPolicy(loopbackHost: string): string {
  return "default-src 'self'; connect-src 'self' ws://" + loopbackHost + "; frame-ancestors 'none'";
}

function initialEvents(
  authState: AuthState,
  startedAt: number,
  futuresRead?: FuturesReadService,
  paperTrading?: PaperTradingService,
  risk?: RiskService,
  execution?: AssistedLiveService,
  protection?: ProtectionService,
  scheduler?: DailySchedulerService,
  resilience?: RuntimeResilienceService,
  liveAutomation?: AutoLiveOrchestrator,
  liveCanary?: KcexCanaryService,
): DashboardEvent[] {
  const now = new Date().toISOString();
  const latest = futuresRead?.getLatestSnapshot();
  const readState = futuresRead?.getReadState();
  const isKcex = authState.authProvider === "KCEX";
  const snapshot = latest
    ? createDashboardSnapshot(authState.status === "AUTHENTICATED", latest, now, true, readState?.browserStatus)
    : createFakeDashboardSnapshot(authState.status === "AUTHENTICATED", now);
  const canSendFinancial = !isKcex || (authState.status === "AUTHENTICATED" && latest != null);
  const proposed: unknown[] = [
    { version: 1, type: "auth.state", timestamp: now, payload: authState },
    { version: 1, type: "risk.state", timestamp: now, payload: RiskStateSchema.parse(risk?.getState() ?? createRiskStatePlaceholder(now)) },
    { version: 1, type: "execution.state", timestamp: now, payload: AssistedExecutionStateSchema.parse(execution?.getState() ?? createExecutionStatePlaceholder(now)) },
    { version: 1, type: "live.automation.state", timestamp: now, payload: liveAutomation?.getState() ?? createLiveAutomationPlaceholder(now) },
    { version: 1, type: "live.canary.state", timestamp: now, payload: liveCanary?.getState() ?? createLiveCanaryPlaceholder(now) },
  ];
  if (canSendFinancial) {
    if (isKcex && latest) {
      proposed.push({ version: 1, type: "futures.snapshot", timestamp: now, payload: latest });
    }
    proposed.push(
      { version: 1, type: "market.snapshot", timestamp: now, payload: snapshot.market },
      {
        version: 1,
        type: "account.balance",
        timestamp: now,
        payload: {
          asset: "USDT",
          available: snapshot.account.availableUsdt,
          source: snapshot.account.source,
          health: snapshot.account.health,
          updatedAt: snapshot.account.updatedAt,
        },
      },
    );
    if (isKcex && latest) {
      proposed.push(
        { version: 1, type: "futures.contract", timestamp: now, payload: snapshot.contract },
        { version: 1, type: "orders.snapshot", timestamp: now, payload: snapshot.openOrders },
      );
    }
    proposed.push({ version: 1, type: "position.changed", timestamp: now, payload: snapshot.position });
  }
  if (isKcex && futuresRead) {
    proposed.push(
      {
        version: 1,
        type: "futures.read-health",
        timestamp: now,
        payload: {
          symbol: "GPS_USDT",
          status: readState?.status ?? latest?.status ?? "UNKNOWN",
          health: readState?.health ?? latest?.health ?? "UNKNOWN",
          browserStatus: readState?.browserStatus ?? "NOT_STARTED",
          source: latest?.source ?? "KCEX",
          consecutiveReadFailures: readState?.consecutiveReadFailures ?? 0,
          updatedAt: readState?.updatedAt ?? latest?.updatedAt ?? now,
        },
      },
    );
  }
  proposed.push(
    {
      version: 1,
      type: "protection.state",
      timestamp: now,
      payload: ProtectionRuntimeStateSchema.parse(protection?.getState() ?? {
        status: "NONE",
        provider: "FIXTURE",
        activePreview: null,
        activePlan: null,
        lastPlan: null,
        reasons: [],
        updatedAt: now,
      }),
    },
    { version: 1, type: "paper.state", timestamp: now, payload: paperTrading?.getState() ?? createIdlePaperTradingState(now) },
    { version: 1, type: "scheduler.plan", timestamp: now, payload: SchedulerStateSchema.parse(
      scheduler?.getState() ?? createFixtureSchedulerState(now),
    ) },
    { version: 1, type: "system.log", timestamp: now, payload: snapshot.logs[0] },
    ...(resilience ? [{ version: 1, type: "resilience.state", timestamp: now, payload: resilience.getState() }] : []),
    {
      version: 1,
      type: "system.heartbeat",
      timestamp: now,
      payload: {
        status: "OK",
        liveTrading: liveAutomation?.getState().liveTrading ?? false,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        resilienceStatus: resilience?.getState().status ?? "IDLE",
      },
    },
  );
  return proposed.map(parseDashboardEvent);
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const startedAt = options.startedAt ?? Date.now();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false });
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const loopbackHost = requireLoopbackHost(request);
        const handled = await handleApiRequest(
          request,
          response,
          options.auth,
          options.vault,
          options.futuresRead,
          options.storage,
          options.paperTrading,
          options.risk,
          options.execution,
          options.protection,
          options.scheduler,
          options.resilience,
          options.liveAutomation,
          options.liveCanary,
          options.verificationReportStore,
          options.onVerificationReportChanged,
        );
        if (!handled) await serveStatic(request, response, options.staticRoot, loopbackHost);
        if (!handled && !response.writableEnded) sendJson(response, 404, { error: "Not found." });
      } catch (error) {
        if (response.headersSent || response.writableEnded) return;
        if (error instanceof HttpError) {
          sendJson(response, error.status, { error: error.publicMessage });
        } else if (error instanceof AssistedExecutionError) {
          sendJson(response, error.status, { error: error.code });
        } else if (error instanceof ProtectionServiceError) {
          sendJson(response, error.status, { error: error.code });
        } else if (error instanceof LiveAutomationBlockedError) {
          sendJson(response, 409, { error: "LIVE_AUTOMATION_BLOCKED", state: error.state });
        } else if (error instanceof VaultUnlockError) {
          sendJson(response, 401, { error: "Unable to unlock the credential vault." });
        } else if (error instanceof VaultLockedError) {
          sendJson(response, 423, { error: "Unlock the local vault first." });
        } else {
          sendJson(response, 500, { error: "The local request could not be completed." });
        }
      }
    })();
  });

  server.on("upgrade", (request, socket, head) => {
    try {
      requireLoopbackHost(request);
      requireSameOrigin(request);
      const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
      if (pathname !== "/api/v1/events") throw new HttpError(404, "Not found.");
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request);
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });

  webSockets.on("connection", (webSocket: WebSocket) => {
    const unsubscribe = options.events.subscribe((event) => {
      if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(event));
    });
    for (const event of initialEvents(
      options.auth.getState(), startedAt, options.futuresRead, options.paperTrading, options.risk,
      options.execution, options.protection, options.scheduler, options.resilience,
      options.liveAutomation,
      options.liveCanary,
    )) {
      webSocket.send(JSON.stringify(event));
    }
    webSocket.on("message", () => webSocket.close(1008, "Read-only event stream."));
    webSocket.on("close", unsubscribe);
    webSocket.on("error", unsubscribe);
  });

  server.on("close", () => {
    for (const webSocket of webSockets.clients) webSocket.close(1001, "Local dashboard is shutting down.");
    webSockets.close();
  });
  return server;
}

export function getDashboardBindAddress(): "127.0.0.1" {
  return "127.0.0.1";
}

export function getDashboardPort(environment: NodeJS.ProcessEnv = process.env): number {
  return readDashboardPort(environment.DASHBOARD_PORT);
}

export function resolveStaticRoot(root = resolve(process.cwd(), "dist/web")): string {
  return root;
}
