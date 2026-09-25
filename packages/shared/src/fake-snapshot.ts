import type {
  AccountSnapshot,
  ContractSnapshot,
  DashboardSnapshot,
  KcexFuturesSnapshot,
  MarketSnapshot,
  OpenOrdersSnapshot,
  PositionSnapshot,
} from "./protocol.js";
import type { BrowserStatus } from "./protocol.js";
import type { StorageStatus } from "./storage.js";
import { assertFuturesSourceConsistency } from "./futures-invariants.js";

export function createFakeFuturesSnapshot(now = new Date().toISOString()): KcexFuturesSnapshot {
  const market: MarketSnapshot = {
    symbol: "GPS_USDT",
    lastPrice: 0.01234,
    markPrice: 0.01231,
    source: "MOCK",
    health: "READY",
    freshness: "FRESH",
    updatedAt: now,
  };
  const account: AccountSnapshot = {
    asset: "USDT",
    availableUsdt: 1000,
    source: "MOCK",
    health: "READY",
    updatedAt: now,
  };
  const contract: ContractSnapshot = {
    symbol: "GPS_USDT",
    marginMode: "ISOLATED",
    leverage: 10,
    source: "MOCK",
    health: "READY",
    updatedAt: now,
  };
  const position: PositionSnapshot = {
    symbol: "GPS_USDT",
    side: "NONE",
    entryPrice: null,
    size: null,
    unrealizedPnl: null,
    source: "MOCK",
    health: "READY",
    freshness: "FRESH",
    updatedAt: now,
  };
  const openOrders: OpenOrdersSnapshot = {
    symbol: "GPS_USDT",
    orders: [],
    ordersHealth: "READY",
    source: "MOCK",
    updatedAt: now,
  };
  return {
    symbol: "GPS_USDT",
    market,
    account,
    contract,
    position,
    openOrders,
    source: "MOCK",
    health: "READY",
    status: "READY",
    freshness: "FRESH",
    updatedAt: now,
  };
}

/** A fixture-shaped placeholder used while a KCEX read-only session has no snapshot yet. */
export function createUnavailableFuturesSnapshot(now = new Date().toISOString()): KcexFuturesSnapshot {
  const snapshot = createFakeFuturesSnapshot(now);
  return {
    ...snapshot,
    market: {
      ...snapshot.market,
      lastPrice: null,
      markPrice: null,
      health: "UNKNOWN",
      freshness: "UNKNOWN",
    },
    account: { ...snapshot.account, availableUsdt: null, health: "UNKNOWN" },
    contract: { ...snapshot.contract, marginMode: "UNKNOWN", leverage: null, health: "UNKNOWN" },
    position: {
      ...snapshot.position,
      side: "UNKNOWN",
      entryPrice: null,
      size: null,
      unrealizedPnl: null,
      health: "UNKNOWN",
      freshness: "UNKNOWN",
    },
    openOrders: { ...snapshot.openOrders, orders: [], ordersHealth: "UNKNOWN" },
    health: "UNKNOWN",
    status: "UNKNOWN",
    freshness: "UNKNOWN",
  };
}

export function createDashboardSnapshot(
  authenticated = false,
  futures = createFakeFuturesSnapshot(),
  now = new Date().toISOString(),
  readOnlyEnabled = false,
  browser: BrowserStatus = authenticated ? "AUTHENTICATED" : "NOT_STARTED",
  storageStatus: StorageStatus = "DEGRADED",
): DashboardSnapshot {
  assertFuturesSourceConsistency(futures);
  return {
    status: {
      kcex: authenticated ? "FAKE_AUTHENTICATED" : "LOGIN_REQUIRED",
      browser,
      mode: "PAPER",
      trading: "PAUSED",
      killSwitch: "NORMAL",
      readOnlyEnabled,
      readHealth: futures.health,
      storage: storageStatus,
    },
    liveTrading: false,
    futures,
    market: futures.market,
    account: futures.account,
    contract: futures.contract,
    position: futures.position,
    openOrders: futures.openOrders,
    scheduler: {
      dailyMin: 1,
      dailyMax: 10,
      todayTarget: 3,
      completed: 0,
      nextTradeAt: null,
      marginUsdt: 50,
      leverage: 10,
      source: "MOCK",
    },
    history: [],
    logs: [
      {
        id: "dashboard-ready",
        level: "info",
        message: "Dashboard loaded with fixture data; trading is disabled.",
        timestamp: now,
      },
    ],
  };
}

export function createFakeDashboardSnapshot(
  authenticated = false,
  now = new Date().toISOString(),
): DashboardSnapshot {
  return createDashboardSnapshot(authenticated, createFakeFuturesSnapshot(now), now);
}
