import { resolve } from "node:path";
import { AuthService } from "./auth/auth-service.js";
import { FakeAuthAdapter } from "./auth/fake-auth-adapter.js";
import { KcexAuthAdapter } from "./auth/kcex-auth-adapter.js";
import { createDashboardServer, getDashboardBindAddress, getDashboardPort, resolveStaticRoot } from "./api/http-server.js";
import { EventBus } from "./realtime/event-bus.js";
import { EncryptedSessionStore } from "./session/encrypted-session-store.js";
import { EncryptedCredentialVault } from "./vault/encrypted-vault.js";
import { logger } from "../../../src/logging/logger.js";
import { loadConfig } from "../../../src/config/schema.js";

const startedAt = Date.now();
const host = getDashboardBindAddress();
const port = getDashboardPort();
const config = loadConfig();
const events = new EventBus();
const vault = new EncryptedCredentialVault(
  process.env.VAULT_FILE?.trim() || resolve(process.cwd(), "data/credentials.vault.json"),
);
const sessionStore = new EncryptedSessionStore(
  vault,
  process.env.SESSION_FILE?.trim() || resolve(process.cwd(), "data/kcex-session.enc.json"),
);
const adapter = config.AUTH_PROVIDER === "KCEX"
  ? new KcexAuthAdapter({ baseUrl: config.KCEX_BASE_URL, headless: config.BROWSER_HEADLESS })
  : new FakeAuthAdapter();
const auth = new AuthService(vault, events, logger, adapter, undefined, undefined, sessionStore);
const server = createDashboardServer({
  auth,
  vault,
  events,
  startedAt,
  staticRoot: process.env.DASHBOARD_DEV === "true" ? undefined : resolveStaticRoot(),
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

server.on("error", (error: NodeJS.ErrnoException) => {
  logger.error({ errorCode: error.code ?? "SERVER_ERROR" }, "Local dashboard server failed to start.");
  process.exitCode = 1;
});

server.listen(port, host, () => {
  logger.info({ host, port, liveTrading: false }, "Local dashboard server is ready.");
});

function shutdown(): void {
  clearInterval(heartbeat);
  auth.close();
  server.close(() => {
    logger.info({ liveTrading: false }, "Local dashboard server stopped.");
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
