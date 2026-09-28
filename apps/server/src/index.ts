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
import { logger } from "../../../src/logging/logger.js";
import { loadConfig } from "../../../src/config/schema.js";

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
  const paperTrading = new PaperTradingService({
    storage,
    events,
    feeRate: config.PAPER_FEE_RATE,
  });
  try {
    await paperTrading.recover();
  } catch {
    logger.error({ errorCode: "PAPER_STATE_RECOVERY_CONFLICT" }, "Paper trading recovery halted safely.");
  }
  const adapter = config.AUTH_PROVIDER === "KCEX"
    ? new KcexAuthAdapter({ baseUrl: config.KCEX_BASE_URL, headless: config.BROWSER_HEADLESS })
    : new FakeAuthAdapter();
  const auth = new AuthService(vault, events, logger, adapter, undefined, undefined, sessionStore);
  const futuresRead = adapter instanceof KcexAuthAdapter
    ? new FuturesReadService({
        adapter: new KcexFuturesReadAdapter(new KcexAuthenticatedPageSource(adapter, () => auth.getState().status)),
        events,
        logger,
        authStatus: () => auth.getState().status,
        enabled: config.KCEX_READONLY_ENABLED,
        pollMs: config.KCEX_READ_POLL_MS,
      })
    : undefined;
  const unsubscribeAuthEvents = futuresRead
    ? (() => {
        const readService = futuresRead;
        return events.subscribe((event) => {
          if (event.type !== "auth.state") return;
          if (event.payload.status === "AUTHENTICATED") readService.start();
          else if (event.payload.status === "AUTH_UNKNOWN") readService.stop("UNKNOWN");
          else if (event.payload.status === "MANUAL_CHALLENGE") readService.stop("MANUAL_CHALLENGE");
          else readService.stop("SESSION_LOST");
        });
      })()
    : undefined;
  const server = createDashboardServer({
    auth,
    vault,
    events,
    storage,
    startedAt,
    staticRoot: process.env.DASHBOARD_DEV === "true" ? undefined : resolveStaticRoot(),
    futuresRead,
    paperTrading,
  });

  const heartbeat = setInterval(() => {
    const timestamp = new Date().toISOString();
    events.publish({
      version: 1,
      type: "system.heartbeat",
      timestamp,
      payload: {
        status: "OK",
        liveTrading: false,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      },
    });
  }, 15_000);
  heartbeat.unref();

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    unsubscribeAuthEvents?.();
    void (async () => {
      await paperTrading.close();
      futuresRead?.stop();
      auth.close();
      storage.close();
      if (server.listening) {
        server.close(() => {
          logger.info({ liveTrading: false }, "Local dashboard server stopped.");
        });
      }
    })();
  }

  server.on("error", (error: NodeJS.ErrnoException) => {
    logger.error({ errorCode: error.code ?? "SERVER_ERROR" }, "Local dashboard server failed to start.");
    process.exitCode = 1;
    shutdown();
  });

  server.listen(port, host, () => {
    logger.info({ host, port, liveTrading: false }, "Local dashboard server is ready.");
  });

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void startServer().catch(() => {
  logger.error({ errorCode: "SERVER_STARTUP_FAILED" }, "Local dashboard server failed to start.");
  process.exitCode = 1;
});
