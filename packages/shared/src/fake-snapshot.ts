import type { DashboardSnapshot } from "./protocol.js";

export function createFakeDashboardSnapshot(
  authenticated = false,
  now = new Date().toISOString(),
): DashboardSnapshot {
  return {
    status: {
      kcex: authenticated ? "FAKE_AUTHENTICATED" : "LOGIN_REQUIRED",
      browser: "NOT_STARTED",
      mode: "PAPER",
      trading: "PAUSED",
      killSwitch: "NORMAL",
    },
    liveTrading: false,
    market: {
      symbol: "GPS_USDT",
      lastPrice: 0.01234,
      markPrice: 0.01231,
      source: "MOCK",
      updatedAt: now,
    },
    account: {
      availableUsdt: 1000,
      marginMode: "ISOLATED",
      leverage: 10,
      source: "MOCK",
    },
    position: {
      symbol: "GPS_USDT",
      side: "NONE",
      entry: 0,
      size: 0,
      unrealizedPnl: 0,
      source: "MOCK",
    },
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
