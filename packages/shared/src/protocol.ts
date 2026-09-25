import { z } from "zod";

export const MASTER_KEY_MIN_LENGTH = 12;

export const AuthProviderSchema = z.enum(["FAKE", "KCEX"]);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const AuthStatusSchema = z.enum([
  "APP_LOCKED",
  "VAULT_UNLOCKED",
  "CREDENTIALS_REQUIRED",
  "SESSION_CHECK",
  "LOGGING_IN",
  "OTP_REQUIRED",
  "SUBMITTING_OTP",
  "AUTHENTICATED",
  "AUTH_FAILED",
  "AUTH_UNKNOWN",
  "MANUAL_CHALLENGE",
  "SESSION_LOST",
]);
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const AuthStateSchema = z
  .object({
    status: AuthStatusSchema,
    authProvider: AuthProviderSchema,
    credentialsSaved: z.boolean(),
    liveTrading: z.literal(false),
    updatedAt: z.string().min(1),
  })
  .strict();
export type AuthState = z.infer<typeof AuthStateSchema>;

export const DataSourceSchema = z.enum(["MOCK", "KCEX"]);
export type DataSource = z.infer<typeof DataSourceSchema>;

export const ReadHealthSchema = z.enum(["READY", "PARTIAL", "UNKNOWN"]);
export type ReadHealth = z.infer<typeof ReadHealthSchema>;

export const FreshnessSchema = z.enum(["FRESH", "STALE", "UNKNOWN"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const FuturesReadStatusSchema = z.enum([
  "READY",
  "PARTIAL",
  "UNKNOWN",
  "SYMBOL_MISMATCH",
  "SESSION_LOST",
  "MANUAL_CHALLENGE",
]);
export type FuturesReadStatus = z.infer<typeof FuturesReadStatusSchema>;

export const BrowserStatusSchema = z.enum(["NOT_STARTED", "AUTHENTICATED", "READING", "DEGRADED", "STOPPED"]);
export type BrowserStatus = z.infer<typeof BrowserStatusSchema>;

export const MarginModeSchema = z.enum(["ISOLATED", "CROSS", "UNKNOWN"]);
export const PositionSideSchema = z.enum(["LONG", "SHORT", "NONE", "UNKNOWN"]);
export const OrderSideSchema = z.enum(["LONG", "SHORT", "UNKNOWN"]);
export const OrderTypeSchema = z.enum(["LIMIT", "MARKET", "TRIGGER", "TP", "SL", "UNKNOWN"]);

const nullableFiniteNonnegative = z.number().finite().nonnegative().nullable();
const timestamp = z.string().min(1);

export const MarketSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    lastPrice: nullableFiniteNonnegative,
    markPrice: nullableFiniteNonnegative,
    source: DataSourceSchema,
    health: ReadHealthSchema,
    freshness: FreshnessSchema,
    updatedAt: timestamp,
  })
  .strict();
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const AccountSnapshotSchema = z
  .object({
    asset: z.literal("USDT"),
    availableUsdt: nullableFiniteNonnegative,
    source: DataSourceSchema,
    health: ReadHealthSchema,
    updatedAt: timestamp,
  })
  .strict();
export type AccountSnapshot = z.infer<typeof AccountSnapshotSchema>;

export const ContractSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    marginMode: MarginModeSchema,
    leverage: nullableFiniteNonnegative,
    source: DataSourceSchema,
    health: ReadHealthSchema,
    updatedAt: timestamp,
  })
  .strict();
export type ContractSnapshot = z.infer<typeof ContractSnapshotSchema>;

export const PositionSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    side: PositionSideSchema,
    entryPrice: nullableFiniteNonnegative,
    size: nullableFiniteNonnegative,
    unrealizedPnl: z.number().finite().nullable(),
    source: DataSourceSchema,
    health: ReadHealthSchema,
    freshness: FreshnessSchema,
    updatedAt: timestamp,
    markPrice: nullableFiniteNonnegative.optional(),
    liquidationPrice: nullableFiniteNonnegative.optional(),
  })
  .strict();
export type PositionSnapshot = z.infer<typeof PositionSnapshotSchema>;

export const OpenOrderSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    side: OrderSideSchema,
    type: OrderTypeSchema,
    price: nullableFiniteNonnegative,
    quantity: nullableFiniteNonnegative,
    filledQuantity: nullableFiniteNonnegative,
    reduceOnly: z.boolean().nullable(),
    status: z.string().trim().min(1).nullable(),
    source: DataSourceSchema,
  })
  .strict();
export type OpenOrderSnapshot = z.infer<typeof OpenOrderSnapshotSchema>;

export const OpenOrdersSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    orders: z.array(OpenOrderSnapshotSchema).max(100),
    ordersHealth: ReadHealthSchema,
    source: DataSourceSchema,
    updatedAt: timestamp,
  })
  .strict();
export type OpenOrdersSnapshot = z.infer<typeof OpenOrdersSnapshotSchema>;

export const KcexFuturesSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    market: MarketSnapshotSchema,
    account: AccountSnapshotSchema,
    contract: ContractSnapshotSchema,
    position: PositionSnapshotSchema,
    openOrders: OpenOrdersSnapshotSchema,
    source: DataSourceSchema,
    health: ReadHealthSchema,
    status: FuturesReadStatusSchema,
    freshness: FreshnessSchema,
    updatedAt: timestamp,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const sources = [
      snapshot.market.source,
      snapshot.account.source,
      snapshot.contract.source,
      snapshot.position.source,
      snapshot.openOrders.source,
      ...snapshot.openOrders.orders.map((order) => order.source),
    ];
    if (sources.some((source) => source !== snapshot.source)) {
      context.addIssue({ code: "custom", message: "Futures snapshot contains mixed data sources." });
    }
  });
export type KcexFuturesSnapshot = z.infer<typeof KcexFuturesSnapshotSchema>;

export const SchedulerPlanSchema = z
  .object({
    dailyMin: z.literal(1),
    dailyMax: z.literal(10),
    todayTarget: z.number().int().min(1).max(10),
    completed: z.number().int().nonnegative(),
    nextTradeAt: z.null(),
    marginUsdt: z.literal(50),
    leverage: z.literal(10),
    source: z.literal("MOCK"),
  })
  .strict();
export type SchedulerPlan = z.infer<typeof SchedulerPlanSchema>;

export const RuntimeLogSchema = z
  .object({
    id: z.string().min(1),
    level: z.enum(["info", "warn", "error"]),
    message: z.string().min(1).max(240),
    timestamp,
  })
  .strict();
export type RuntimeLog = z.infer<typeof RuntimeLogSchema>;

export const DashboardSnapshotSchema = z
  .object({
    status: z
      .object({
        kcex: z.enum(["LOGIN_REQUIRED", "FAKE_AUTHENTICATED", "KCEX_AUTHENTICATED"]),
        browser: BrowserStatusSchema,
        mode: z.literal("PAPER"),
        trading: z.literal("PAUSED"),
        killSwitch: z.literal("NORMAL"),
        readOnlyEnabled: z.boolean(),
        readHealth: ReadHealthSchema,
      })
      .strict(),
    liveTrading: z.literal(false),
    futures: KcexFuturesSnapshotSchema,
    market: MarketSnapshotSchema,
    account: AccountSnapshotSchema,
    contract: ContractSnapshotSchema,
    position: PositionSnapshotSchema,
    openOrders: OpenOrdersSnapshotSchema,
    scheduler: SchedulerPlanSchema,
    history: z.array(z.never()),
    logs: z.array(RuntimeLogSchema).max(100),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const sources = [
      snapshot.futures.source,
      snapshot.market.source,
      snapshot.account.source,
      snapshot.contract.source,
      snapshot.position.source,
      snapshot.openOrders.source,
    ];
    if (sources.some((source) => source !== snapshot.futures.source)) {
      context.addIssue({ code: "custom", message: "Dashboard snapshot contains mixed data sources." });
    }
  });
export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;

const EventMetaSchema = {
  version: z.literal(1),
  timestamp,
};

const AccountBalanceEventPayloadSchema = z
  .object({
    asset: z.literal("USDT"),
    available: nullableFiniteNonnegative,
    source: DataSourceSchema,
    health: ReadHealthSchema.optional(),
    updatedAt: timestamp.optional(),
  })
  .strict();

export const DashboardEventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventMetaSchema, type: z.literal("auth.state"), payload: AuthStateSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("futures.snapshot"), payload: KcexFuturesSnapshotSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("market.snapshot"), payload: MarketSnapshotSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("account.balance"), payload: AccountBalanceEventPayloadSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("position.changed"), payload: PositionSnapshotSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("futures.contract"), payload: ContractSnapshotSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("orders.snapshot"), payload: OpenOrdersSnapshotSchema }).strict(),
  z.object({
    ...EventMetaSchema,
    type: z.literal("futures.read-health"),
    payload: z.object({
      symbol: z.literal("GPS_USDT"),
      status: FuturesReadStatusSchema,
      health: ReadHealthSchema,
      browserStatus: BrowserStatusSchema,
      source: DataSourceSchema,
      consecutiveReadFailures: z.number().int().nonnegative(),
      updatedAt: timestamp,
    }).strict(),
  }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("scheduler.plan"), payload: SchedulerPlanSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("system.log"), payload: RuntimeLogSchema }).strict(),
  z.object({
    ...EventMetaSchema,
    type: z.literal("system.heartbeat"),
    payload: z.object({ status: z.literal("OK"), liveTrading: z.literal(false), uptimeSeconds: z.number().int().nonnegative() }).strict(),
  }).strict(),
]);
export type DashboardEvent = z.infer<typeof DashboardEventSchema>;

export function parseDashboardEvent(value: unknown): DashboardEvent {
  return DashboardEventSchema.parse(value);
}
