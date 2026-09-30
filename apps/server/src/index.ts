import { resolve } from "node:path";
import { AuthService } from "./auth/auth-service.js";
import { FakeAuthAdapter } from "./auth/fake-auth-adapter.js";
import { KcexAuthAdapter } from "./auth/kcex-auth-adapter.js";
import { createDashboardServer, getDashboardBindAddress, getDashboardPort, resolveStaticRoot } from "./api/http-server.js";
import { EventBus } from "./realtime/event-bus.js";
import { EncryptedSessionStore } from "./session/encrypted-session-store.js";
import { EncryptedCredentialVault } from "./vault/encrypted-vault.js";
import { KcexAuthenticatedPageSource } from "./futures/trusted-page-source.js";
import { KcexFuturesReadAdapter } from "./futures/kcex-futures-read-adapter.js";
import { FuturesReadService } from "./futures/futures-read-service.js";
import { StorageService } from "./storage/storage-service.js";
import { DatabaseSchemaTooNewError } from "./storage/storage-errors.js";
import { PaperTradingService } from "./trading/paper-trading-service.js";
import { KillSwitchService } from "./risk/kill-switch.js";
import { RiskService } from "./risk/risk-service.js";
import { AssistedLiveService } from "./execution/assisted-live-service.js";
import { FixtureExecutionAdapter } from "./execution/fixture-execution-adapter.js";
import { DisabledKcexExecutionAdapter } from "./execution/disabled-kcex-execution-adapter.js";
import { FixtureExecutionPositionSource, resolveInitialFixturePositionState, type ExecutionPositionSource } from "./execution/execution-position-source.js";
import { FixtureProtectionAdapter } from "./protection/protection-adapter.js";
import { ProtectionService } from "./protection/protection-service.js";
import { DailySchedulerService } from "./scheduler/daily-scheduler-service.js";
import { logger } from "../../../src/logging/logger.js";
import { loadConfig } from "../../../src/config/schema.js";
import { RuntimeResilienceService } from "./resilience/runtime-resilience-service.js";
import { AutoLiveOrchestrator, type LiveAutomationPreflight } from "./kcex-live/auto-live-orchestrator.js";
import { KcexExecutionAdapter } from "./kcex-live/kcex-execution-adapter.js";
import { KcexPositionConfirmationSource } from "./kcex-live/kcex-position-confirmation-source.js";
import { KcexProtectionAdapter } from "./kcex-live/kcex-protection-adapter.js";
import { KcexVerificationReportStore } from "./kcex-live/verification-report-store.js";
import { KcexCanaryService } from "./kcex-live/kcex-canary-service.js";
import type { KcexFuturesSnapshot } from "../../../packages/shared/src/protocol.js";
import type { LiveCanaryPreviewInput, LiveProtectionSetting } from "../../../packages/shared/src/live-launch.js";

type LivePositionStatus = "FLAT" | "OPEN" | "UNKNOWN";

function livePositionStatus(snapshot: KcexFuturesSnapshot | null): LivePositionStatus {
  if (!snapshot || snapshot.source !== "KCEX" || snapshot.position.source !== "KCEX"
    || snapshot.position.health !== "READY" || snapshot.position.freshness !== "FRESH") return "UNKNOWN";
  if (snapshot.position.side === "NONE" && snapshot.position.size === null) return "FLAT";
  if ((snapshot.position.side === "LONG" || snapshot.position.side === "SHORT")
    && snapshot.position.size !== null && snapshot.position.size > 0
    && snapshot.position.entryPrice !== null && snapshot.position.entryPrice > 0) return "OPEN";
  return "UNKNOWN";
}

async function startServer(): Promise<void> {
  const config = loadConfig();
  const host = getDashboardBindAddress();
  const port = getDashboardPort();
  const startedAt = Date.now();
  const events = new EventBus();
  const storage = new StorageService({
    databaseFile: process.env.TRADING_DB_FILE?.trim() || undefined,
    logger,
  });

  try {
    await storage.initialize();
  } catch (error) {
    const errorCode = error instanceof DatabaseSchemaTooNewError
      ? "DATABASE_SCHEMA_TOO_NEW"
      : "STORAGE_INITIALIZATION_FAILED";
    logger.error({ errorCode }, "storage initialization failed");
    process.exitCode = 1;
    return;
  }

  const vault = new EncryptedCredentialVault(
    process.env.VAULT_FILE?.trim() || resolve(process.cwd(), "data/credentials.vault.json"),
  );
  const sessionStore = new EncryptedSessionStore(
    vault,
    process.env.SESSION_FILE?.trim() || resolve(process.cwd(), "data/kcex-session.enc.json"),
  );
  const verificationStore = new KcexVerificationReportStore();
  let verificationReport = await verificationStore.load();
  const killSwitch = new KillSwitchService(resolve(process.cwd(), config.KILL_SWITCH_FILE));
  const risk = new RiskService({ storage, events, killSwitch, limits: config.RISK_LIMITS });
  await risk.initialize();
  const paperTrading = new PaperTradingService({ storage, events, risk, feeRate: config.PAPER_FEE_RATE });
  try {
    await paperTrading.recover();
  } catch {
    logger.error({ errorCode: "PAPER_STATE_RECOVERY_CONFLICT" }, "Paper trading recovery halted safely.");
  }
  await risk.refresh();

  const assistedProvider = config.LIVE_EXECUTION_PROVIDER === "FIXTURE" ? "FIXTURE" : "DISABLED";
  const executionAdapter = assistedProvider === "FIXTURE"
    ? new FixtureExecutionAdapter()
    : new DisabledKcexExecutionAdapter();
  const executionPositionSource = new FixtureExecutionPositionSource(resolveInitialFixturePositionState(storage));
  const execution = new AssistedLiveService({
    provider: assistedProvider,
    adapter: executionAdapter,
    storage,
    risk,
    events,
    positionSource: executionPositionSource,
    onConfirmed: () => executionPositionSource.setPositionState("OPEN"),
  });
  await execution.recover();
  const protection = new ProtectionService({
    provider: "FIXTURE",
    adapter: new FixtureProtectionAdapter(),
    storage,
    events,
    positionSource: executionPositionSource,
    setPositionState: (state) => executionPositionSource.setPositionState(state),
  });
  await protection.recover();

  const authAdapter = config.AUTH_PROVIDER === "KCEX"
    ? new KcexAuthAdapter({
        baseUrl: config.KCEX_BASE_URL,
        headless: config.BROWSER_HEADLESS,
        googleOAuthSelector: verificationReport.selectors.googleOAuthStart.status === "VERIFIED"
          ? verificationReport.selectors.googleOAuthStart.selector ?? undefined
          : undefined,
      })
    : new FakeAuthAdapter();
  const auth = new AuthService(vault, events, logger, authAdapter, undefined, undefined, sessionStore);
  const pageSource = authAdapter instanceof KcexAuthAdapter
    ? new KcexAuthenticatedPageSource(authAdapter, () => auth.getState().status)
    : undefined;
  const kcexReadAdapter = pageSource ? new KcexFuturesReadAdapter(pageSource) : undefined;
  let autoLive: AutoLiveOrchestrator | undefined;
  const futuresRead = kcexReadAdapter
    ? new FuturesReadService({
        adapter: kcexReadAdapter,
        events,
        logger,
        authStatus: () => auth.getState().status,
        enabled: config.KCEX_READONLY_ENABLED,
        pollMs: config.KCEX_READ_POLL_MS,
        onRuntimeSignal: async (signal) => {
          await auth.handleRuntimeSignal(signal);
          autoLive?.requireManualAction();
        },
      })
    : undefined;

  const kcexPositionSource: ExecutionPositionSource = futuresRead
    ? {
        getPositionState: () => {
          const state = livePositionStatus(futuresRead.getLatestSnapshot());
          return state === "UNKNOWN" ? "UNKNOWN" : state;
        },
      }
    : executionPositionSource;
  let resilience: RuntimeResilienceService | undefined;
  const scheduler = new DailySchedulerService({
    storage,
    events,
    positionSource: kcexReadAdapter ? kcexPositionSource : executionPositionSource,
    getKillSwitchStatus: () => killSwitch.getStatus(),
    getResilienceStatus: () => resilience?.getState().status ?? "IDLE",
  });
  const unsubscribeAuthEvents = futuresRead
    ? events.subscribe((event) => {
        if (event.type !== "auth.state") return;
        if (event.payload.status === "AUTHENTICATED") futuresRead.start();
        else {
          if (event.payload.status === "AUTH_UNKNOWN" || event.payload.status === "SESSION_LOST"
            || event.payload.status === "MANUAL_CHALLENGE" || event.payload.status === "OTP_REQUIRED") {
            autoLive?.requireManualAction();
          }
          futuresRead.stop(event.payload.status === "AUTH_UNKNOWN" ? "UNKNOWN"
            : event.payload.status === "MANUAL_CHALLENGE" ? "MANUAL_CHALLENGE"
              : event.payload.status === "SESSION_LOST" ? "SESSION_LOST" : undefined);
        }
      })
    : undefined;
  resilience = new RuntimeResilienceService({
    auth,
    futuresRead,
    storage,
    events,
    logger,
    onStateChange: async () => { await scheduler.tick(); },
  });

  let lastKillSwitch: "CLEAR" | "ENGAGED" | "UNKNOWN" = "UNKNOWN";
  let liveRiskAllowsEntry = false;
  let activeAutoAttemptId: string | null = null;
  let activeCanaryAttemptId: string | null = null;
  const refreshLivePreflight = async (side: "LONG" | "SHORT" = "LONG", marginUsdt = 50): Promise<void> => {
    lastKillSwitch = await killSwitch.getStatus();
    const latest = futuresRead?.getLatestSnapshot() ?? null;
    const positionStatus = livePositionStatus(latest);
    const riskDecision = await risk.assessPreTrade(
      { mode: "LIVE", symbol: "GPS_USDT", side, marginUsdt, leverage: 10 },
      { liveTrading: config.LIVE_TRADING, positionState: positionStatus },
    );
    liveRiskAllowsEntry = riskDecision.allowed;
  };

  const getLivePreflight = (): LiveAutomationPreflight => {
    const latest = futuresRead?.getLatestSnapshot() ?? null;
    const latestAttempt = storage.liveExecutionAttempts.getLatestAttempt();
    const dueSlot = scheduler.getState().dueSlot
      ? storage.scheduler.getCurrentDueSlot(scheduler.getState().dateKey)
      : null;
    return {
      liveTrading: config.LIVE_TRADING,
      automationAuthorized: config.KCEX_AUTOMATION_AUTHORIZED,
      provider: config.LIVE_EXECUTION_PROVIDER,
      authStatus: auth.getState().status,
      resilienceStatus: resilience?.getState().status ?? "IDLE",
      readFresh: latest !== null && latest.source === "KCEX" && latest.freshness === "FRESH",
      contractProfile: verificationReport.contractProfile,
      selectors: verificationReport.selectors,
      killSwitch: lastKillSwitch,
      positionStatus: livePositionStatus(latest),
      openOrdersClear: latest !== null && latest.source === "KCEX"
        && latest.openOrders.ordersHealth === "READY" && latest.openOrders.orders.length === 0,
      unresolvedExecution: storage.liveExecutionAttempts.getBlockingAttemptCount(activeAutoAttemptId ?? undefined) > 0,
      unresolvedProtection: storage.liveProtectionPlans.getBlockingCount() > 0,
      storageReady: storage.getHealth().status === "READY",
      riskAllowsEntry: liveRiskAllowsEntry,
      realExecutionVerified: verificationReport.status === "PASS" && verificationReport.canaryStatus === "PASS"
        && verificationReport.checks.canaryEntry === "PASS" && verificationReport.checks.canaryPosition === "PASS",
      protectionVerified: verificationReport.status === "PASS" && verificationReport.canaryStatus === "PASS"
        && verificationReport.checks.canaryProtection === "PASS",
      dueSlotId: dueSlot?.id ?? null,
      lastAttemptId: latestAttempt?.attemptId ?? null,
    };
  };

  const executeLiveAttempt = async (input: {
    attemptId: string;
    side: "LONG" | "SHORT";
    marginUsdt: number;
    expectedQuantity?: number;
    dueAt: string;
    slotId?: string;
    takeProfit: LiveProtectionSetting;
    stopLoss: LiveProtectionSetting;
    isRuntimeAuthorized: () => boolean;
    getBlockReasons: () => readonly string[];
    refreshBlockReasons?: () => Promise<readonly string[]>;
    reportProgress?: (status: "SUBMITTING" | "CONFIRMING" | "PROTECTING") => void;
  }): Promise<"POSITION_OPEN" | "UNKNOWN" | "MANUAL_ACTION" | "FAILED"> => {
    if (!(authAdapter instanceof KcexAuthAdapter) || !kcexReadAdapter || !pageSource
      || !config.LIVE_TRADING || !config.KCEX_AUTOMATION_AUTHORIZED
      || config.LIVE_EXECUTION_PROVIDER !== "KCEX") return "MANUAL_ACTION";
    try {
      await refreshLivePreflight(input.side, input.marginUsdt);
      if (input.refreshBlockReasons) {
        const refreshedReasons = await input.refreshBlockReasons();
        if (refreshedReasons.length > 0) {
          storage.liveExecutionAttempts.markFailedNotSubmitted(input.attemptId, "PRECHECK_FAILED");
          await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
          return "FAILED";
        }
      }
      const entryWriter = new KcexExecutionAdapter({
        pageSource,
        selectors: verificationReport.selectors,
        contractProfile: verificationReport.contractProfile,
        isRuntimeAuthorized: input.isRuntimeAuthorized,
        getBlockReasons: input.getBlockReasons,
      });
      const result = await entryWriter.submit({
        attemptId: input.attemptId,
        side: input.side,
        dueAt: input.dueAt,
        marginUsdt: input.marginUsdt,
        ...(input.expectedQuantity === undefined ? {} : { expectedQuantity: input.expectedQuantity }),
      });
      if (result.status === "FAILED_NOT_SUBMITTED") {
        storage.liveExecutionAttempts.markFailedNotSubmitted(input.attemptId,
          result.reason === "ORDER_REJECTED" ? "ORDER_REJECTED" : "PRECHECK_FAILED");
        await risk.recordExecutionFailure({ failureKind: "EXECUTION_FAILED" });
        return "FAILED";
      }
      if (result.status === "UNKNOWN") {
        storage.liveExecutionAttempts.markUnknown(input.attemptId);
        await risk.recordExecutionFailure({ failureKind: "UNKNOWN_RESULT" });
        return "UNKNOWN";
      }

      storage.liveExecutionAttempts.markSubmitted({
        attemptId: input.attemptId,
        quantity: result.quantity,
        notionalUsdt: result.notionalUsdt,
      });
      storage.liveExecutionAttempts.markConfirming(input.attemptId);
      input.reportProgress?.("CONFIRMING");
      const confirmationSource = new KcexPositionConfirmationSource({
        profile: verificationReport.contractProfile,
        readFreshSnapshot: async () => (await kcexReadAdapter.readSnapshot()).snapshot ?? null,
      });
      const evidence = await confirmationSource.readEvidence({ side: input.side, quantity: result.quantity });
      if (evidence.kind !== "MATCHED_OPEN") {
        storage.liveExecutionAttempts.markUnknown(input.attemptId);
        await risk.recordExecutionFailure({ failureKind: "UNKNOWN_RESULT" });
        return "UNKNOWN";
      }

      const trade = storage.trades.createTradeWithEvent({
        symbol: "GPS_USDT",
        mode: "LIVE",
        side: input.side,
        status: "OPEN",
        marginUsdt: input.marginUsdt,
        leverage: 10,
        quantity: evidence.size,
        entryPrice: evidence.entryPrice,
        fees: null,
        plannedAt: input.dueAt,
        openedAt: evidence.observedAt,
      }, {
        eventType: "LIVE_TRADE_OPENED",
        eventTime: evidence.observedAt,
        payload: { executionAttemptId: input.attemptId, observedAt: evidence.observedAt },
      });
      storage.liveExecutionAttempts.markConfirmed({
        attemptId: input.attemptId,
        entryPrice: evidence.entryPrice,
        size: evidence.size,
        observedAt: evidence.observedAt,
        tradeId: trade.id,
      });
      if (input.slotId) {
        const currentSlot = storage.scheduler.getSlot(input.slotId);
        if (!currentSlot) throw new Error("LIVE_SCHEDULER_SLOT_MISSING");
        storage.scheduler.completeSlotWithLiveAttempt({
          slotId: currentSlot.id,
          expectedVersion: currentSlot.version,
          liveExecutionAttemptId: input.attemptId,
        });
      }

      input.reportProgress?.("PROTECTING");
      const protectionWriter = new KcexProtectionAdapter({
        pageSource,
        selectors: verificationReport.selectors,
        profile: verificationReport.contractProfile,
        readPosition: async () => {
          const snapshot = (await kcexReadAdapter.readSnapshot()).snapshot;
          return {
            symbol: snapshot?.position.symbol ?? "",
            side: snapshot?.position.side ?? "UNKNOWN",
            entryPrice: snapshot?.position.entryPrice ?? null,
            size: snapshot?.position.size ?? null,
            observedAt: snapshot?.updatedAt ?? new Date().toISOString(),
            fresh: snapshot?.source === "KCEX" && snapshot.position.health === "READY" && snapshot.position.freshness === "FRESH",
          };
        },
        persistPlanned: async (protectionInput, tpTarget, slTarget) => {
          storage.liveProtectionPlans.createPlanned({
            executionAttemptId: protectionInput.executionAttemptId,
            symbol: protectionInput.symbol,
            side: protectionInput.side,
            entryPrice: protectionInput.entryPrice,
            positionSize: protectionInput.positionSize,
            leverage: 10,
            tpBasis: protectionInput.takeProfit.basis,
            tpValue: protectionInput.takeProfit.value,
            tpTarget,
            slBasis: protectionInput.stopLoss.basis,
            slValue: protectionInput.stopLoss.value,
            slTarget,
          });
        },
        verifyProtection: async (page, _protectionInput, tpTarget, slTarget) => {
          const selector = verificationReport.selectors.protectionEvidence;
          if (selector.status !== "VERIFIED" || !selector.selector) return false;
          const locator = page.locator(selector.selector);
          if (!await locator.isVisible().catch(() => false)) return false;
          const evidenceText = (await locator.innerText().catch(() => "")).replace(/,/g, "");
          const format = (value: number) => verificationReport.contractProfile.takeProfitStopLossSemantics === "ROI_INPUT_PERCENT"
            ? String(value)
            : value.toFixed(verificationReport.contractProfile.pricePrecision);
          return evidenceText.includes(format(tpTarget)) && evidenceText.includes(format(slTarget));
        },
      });
      const protectionResult = await protectionWriter.activate({
        executionAttemptId: input.attemptId,
        symbol: "GPS_USDT",
        side: input.side,
        entryPrice: evidence.entryPrice,
        positionSize: evidence.size,
        leverage: 10,
        takeProfit: input.takeProfit,
        stopLoss: input.stopLoss,
      });
      const plan = storage.liveProtectionPlans.getByAttemptId(input.attemptId);
      if (plan) {
        storage.liveProtectionPlans.transition(plan.id,
          protectionResult.status === "ACTIVE" ? "ACTIVE"
            : protectionResult.status === "UNKNOWN" ? "UNKNOWN" : "ERROR");
      }
      if (protectionResult.status === "ACTIVE") return "POSITION_OPEN";
      await risk.recordExecutionFailure({ failureKind: "UNKNOWN_RESULT" });
      return protectionResult.status === "UNKNOWN" ? "UNKNOWN" : "MANUAL_ACTION";
    } catch {
      const attempt = storage.liveExecutionAttempts.getById(input.attemptId);
      if (attempt && ["SUBMITTING", "SUBMITTED", "CONFIRMING"].includes(attempt.status)) {
        try { storage.liveExecutionAttempts.markUnknown(input.attemptId); } catch { /* Preserve the fail-closed state. */ }
      }
      return "UNKNOWN";
    }
  };

  autoLive = new AutoLiveOrchestrator({
    events,
    getPreflight: getLivePreflight,
    refreshPreflight: refreshLivePreflight,
    claimSlotOnce: async (slot) => storage.liveExecutionAttempts.claimDueSlot(slot.id)?.attemptId ?? null,
    executeDueSlot: async (slot, attemptId, protectionSettings) => {
      activeAutoAttemptId = attemptId;
      try {
        const outcome = await executeLiveAttempt({
          attemptId,
          side: slot.side,
          marginUsdt: 50,
          dueAt: slot.dueAt,
          slotId: slot.id,
          takeProfit: protectionSettings.takeProfit,
          stopLoss: protectionSettings.stopLoss,
          isRuntimeAuthorized: () => autoLive?.isRuntimeAuthorized() ?? false,
          getBlockReasons: () => autoLive?.getState().blockReasons ?? ["LIVE_PROVIDER_DISABLED"],
          reportProgress: (status) => { if (status !== "SUBMITTING") autoLive?.reportProgress(status); },
        });
        return outcome === "FAILED" ? "MANUAL_ACTION" : outcome;
      } finally {
        activeAutoAttemptId = null;
      }
    },
  });

  let lastCanaryBlockReasons: string[] = [];
  const getCanaryBlockReasons = async (input: LiveCanaryPreviewInput): Promise<string[]> => {
    await refreshLivePreflight(input.side, input.marginUsdt);
    const latest = futuresRead?.getLatestSnapshot() ?? null;
    const reasons: string[] = [];
    if (!config.LIVE_TRADING || !config.KCEX_AUTOMATION_AUTHORIZED || config.LIVE_EXECUTION_PROVIDER !== "KCEX") reasons.push("LIVE_PROVIDER_DISABLED");
    if (auth.getState().status !== "AUTHENTICATED") reasons.push("AUTH_REQUIRED");
    if (resilience?.getState().status !== "HEALTHY") reasons.push("RESILIENCE_NOT_HEALTHY");
    if (!latest || latest.source !== "KCEX" || latest.freshness !== "FRESH") reasons.push("READ_NOT_FRESH");
    if (livePositionStatus(latest) !== "FLAT") reasons.push("POSITION_NOT_FLAT");
    if (!latest || latest.source !== "KCEX" || latest.openOrders.ordersHealth !== "READY") reasons.push("OPEN_ORDERS_PRESENT");
    else if (latest.openOrders.orders.length > 0) reasons.push("OPEN_ORDERS_PRESENT");
    if (storage.liveExecutionAttempts.getBlockingAttemptCount(activeCanaryAttemptId ?? undefined) > 0) reasons.push("UNRESOLVED_EXECUTION");
    if (storage.liveProtectionPlans.getBlockingCount() > 0) reasons.push("UNRESOLVED_PROTECTION");
    if (lastKillSwitch !== "CLEAR") reasons.push("KILL_SWITCH_ACTIVE");
    if (storage.getHealth().status !== "READY") reasons.push("STORAGE_NOT_READY");
    if (!liveRiskAllowsEntry) reasons.push("RISK_LIMIT_REACHED");
    if (verificationReport.status !== "PASS") reasons.push("VERIFICATION_REQUIRED");
    if (verificationReport.contractProfile.status !== "VERIFIED") reasons.push("CONTRACT_PROFILE_UNVERIFIED");
    if (verificationReport.canaryStatus !== "NOT_RUN") reasons.push("CANARY_ALREADY_ATTEMPTED");
    if (!autoLive || autoLive.getState().status !== "DISARMED" || autoLive.isRuntimeAuthorized()) reasons.push("AUTO_LIVE_MUST_BE_DISARMED");
    if (!config.KCEX_READONLY_ENABLED || !kcexReadAdapter) reasons.push("READ_ONLY_STATE_DISABLED");
    lastCanaryBlockReasons = [...new Set(reasons)];
    return lastCanaryBlockReasons;
  };
  let canaryMutationAuthorized = false;
  const liveCanary = new KcexCanaryService({
    attempts: storage.liveExecutionAttempts,
    events,
    profile: () => verificationReport.contractProfile,
    markPrice: () => futuresRead?.getLatestSnapshot()?.market.markPrice ?? null,
    getBlockReasons: getCanaryBlockReasons,
    isVerified: () => verificationReport.status === "PASS" && verificationReport.canaryStatus === "PASS",
    recordFailure: async () => {
      await verificationStore.markCanaryFail();
      verificationReport = await verificationStore.load();
    },
    executeOnce: async (input, attemptId, expectedQuantity, reportProgress) => {
      activeCanaryAttemptId = attemptId;
      canaryMutationAuthorized = true;
      try {
        const result = await executeLiveAttempt({
          attemptId,
          side: input.side,
          marginUsdt: input.marginUsdt,
          expectedQuantity,
          dueAt: new Date().toISOString(),
          takeProfit: input.takeProfit,
          stopLoss: input.stopLoss,
          isRuntimeAuthorized: () => canaryMutationAuthorized,
          getBlockReasons: () => lastCanaryBlockReasons,
          refreshBlockReasons: () => getCanaryBlockReasons(input),
          reportProgress,
        });
        if (result === "POSITION_OPEN") {
          const passed = await verificationStore.markCanaryPass();
          verificationReport = await verificationStore.load();
          return passed ? "PASSED" : "MANUAL_ACTION";
        }
        return result === "FAILED" ? "FAILED" : result;
      } finally {
        canaryMutationAuthorized = false;
        activeCanaryAttemptId = null;
      }
    },
  });

  const unsubscribeSchedulerEvents = events.subscribe((event) => {
    if (event.type !== "scheduler.plan" || event.payload.status !== "DUE" || !event.payload.dueSlot) return;
    void (async () => {
      const slot = storage.scheduler.getCurrentDueSlot(event.payload.dateKey);
      if (!slot) return;
      await autoLive?.onSchedulerSlot({
        id: slot.id,
        dateKey: slot.dateKey,
        slotIndex: slot.slotIndex,
        side: slot.side,
        dueAt: slot.dueAt,
        status: slot.status,
      });
    })().catch(() => { autoLive?.halt(); });
  });

  const unsubscribeLivePositionEvents = events.subscribe((event) => {
    if (event.type !== "futures.snapshot" || event.payload.source !== "KCEX") return;
    void (async () => {
      const state = livePositionStatus(event.payload);
      if (state === "UNKNOWN") {
        autoLive?.handlePositionState("UNKNOWN");
        return;
      }
      const openTrades = storage.trades.listOpenLiveTrades({ symbol: "GPS_USDT", limit: 2 });
      if (openTrades.length > 1) {
        autoLive?.requireManualAction();
        return;
      }
      if (state === "OPEN") {
        const trade = openTrades[0];
        const position = event.payload.position;
        const sizeDeviationBps = trade?.quantity && position.size !== null
          ? Math.ceil(Math.abs(position.size - trade.quantity) / trade.quantity * 10_000)
          : Number.POSITIVE_INFINITY;
        const entryDeviation = trade?.entryPrice !== null && trade?.entryPrice !== undefined && position.entryPrice !== null
          ? Math.abs(position.entryPrice - trade.entryPrice)
          : Number.POSITIVE_INFINITY;
        if (!trade || trade.side !== position.side || trade.quantity === null
          || trade.entryPrice === null || sizeDeviationBps > verificationReport.contractProfile.maximumNotionalDeviationBps
          || entryDeviation > verificationReport.contractProfile.tickSize) {
          autoLive?.requireManualAction();
          return;
        }
        autoLive?.handlePositionState("OPEN");
        return;
      }
      let reconciledUnknownExit = false;
      for (const trade of openTrades) {
        const closedAt = event.payload.position.updatedAt;
        storage.trades.recordTradeTransition({
          tradeId: trade.id,
          patch: {
            expectedVersion: trade.version,
            status: "CLOSED",
            exitPrice: null,
            realizedPnl: null,
            fees: null,
            closedAt,
            closeReason: "UNKNOWN_EXIT",
          },
          event: {
            eventType: "LIVE_TRADE_CLOSED_UNKNOWN_EXIT",
            eventTime: closedAt,
            payload: { reason: "UNKNOWN_EXIT", observedAt: closedAt },
          },
        });
        reconciledUnknownExit = true;
        const openedEvent = storage.trades.listTradeEvents(trade.id).find((entry) => entry.eventType === "LIVE_TRADE_OPENED");
        const attemptId = openedEvent?.payload?.executionAttemptId;
        if (typeof attemptId === "string") {
          const plan = storage.liveProtectionPlans.getByAttemptId(attemptId);
          if (plan && ["ACTIVE", "UNKNOWN", "ERROR"].includes(plan.status)) {
            storage.liveProtectionPlans.transition(plan.id, "CLOSED_UNKNOWN");
          }
        }
      }
      if (reconciledUnknownExit) autoLive?.requireManualAction();
      else autoLive?.handlePositionState("FLAT");
    })().catch(() => { autoLive?.requireManualAction(); });
  });

  await resilience.recover();
  await scheduler.recover();
  scheduler.start();
  resilience.start();
  const server = createDashboardServer({
    auth,
    vault,
    events,
    storage,
    startedAt,
    staticRoot: process.env.DASHBOARD_DEV === "true" ? undefined : resolveStaticRoot(),
    futuresRead,
    paperTrading,
    risk,
    execution,
    protection,
    scheduler,
    resilience,
    liveAutomation: autoLive,
    liveCanary,
    verificationReportStore: verificationStore,
    onVerificationReportChanged: (report) => { verificationReport = report; },
  });

  const heartbeat = setInterval(() => {
    const timestamp = new Date().toISOString();
    events.publish({
      version: 1,
      type: "system.heartbeat",
      timestamp,
      payload: {
        status: "OK",
        liveTrading: autoLive?.getState().liveTrading ?? config.LIVE_TRADING,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        resilienceStatus: resilience?.getState().status ?? "IDLE",
      },
    });
  }, 15_000);
  heartbeat.unref();

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    scheduler.stop();
    resilience?.stop();
    execution.close();
    unsubscribeAuthEvents?.();
    unsubscribeSchedulerEvents();
    unsubscribeLivePositionEvents();
    void (async () => {
      await paperTrading.close();
      futuresRead?.stop();
      auth.close();
      storage.close();
      if (server.listening) server.close(() => logger.info({ liveTrading: false }, "Local dashboard server stopped."));
    })();
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.error({ errorCode: error.code ?? "SERVER_ERROR" }, "Local dashboard server failed to start.");
    process.exitCode = 1;
    shutdown();
  });
  server.listen(port, host, () => {
    logger.info({ host, port, liveTrading: config.LIVE_TRADING }, "Local dashboard server is ready.");
  });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void startServer().catch(() => {
  logger.error({ errorCode: "SERVER_STARTUP_FAILED" }, "Local dashboard server failed to start.");
  process.exitCode = 1;
});
