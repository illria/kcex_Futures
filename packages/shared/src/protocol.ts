import { z } from "zod";

export const MASTER_KEY_MIN_LENGTH = 12;

export const AuthStatusSchema = z.enum([
  "APP_LOCKED",
  "VAULT_UNLOCKED",
  "CREDENTIALS_REQUIRED",
  "LOGGING_IN",
  "OTP_REQUIRED",
  "AUTHENTICATED",
  "AUTH_FAILED",
]);

export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const AuthStateSchema = z
  .object({
    status: AuthStatusSchema,
    credentialsSaved: z.boolean(),
    liveTrading: z.literal(false),
    fakeAuth: z.literal(true),
    updatedAt: z.string().min(1),
  })
  .strict();

export type AuthState = z.infer<typeof AuthStateSchema>;

export const MarketSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    lastPrice: z.number().finite().nonnegative(),
    markPrice: z.number().finite().nonnegative(),
    source: z.literal("MOCK"),
    updatedAt: z.string().min(1),
  })
  .strict();

export const PositionSnapshotSchema = z
  .object({
    symbol: z.literal("GPS_USDT"),
    side: z.literal("NONE"),
    entry: z.literal(0),
    size: z.literal(0),
    unrealizedPnl: z.literal(0),
    source: z.literal("MOCK"),
  })
  .strict();

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

export const RuntimeLogSchema = z
  .object({
    id: z.string().min(1),
    level: z.enum(["info", "warn", "error"]),
    message: z.string().min(1).max(240),
    timestamp: z.string().min(1),
  })
  .strict();

export const DashboardSnapshotSchema = z
  .object({
    status: z
      .object({
        kcex: z.enum(["LOGIN_REQUIRED", "FAKE_AUTHENTICATED"]),
        browser: z.literal("NOT_STARTED"),
        mode: z.literal("PAPER"),
        trading: z.literal("PAUSED"),
        killSwitch: z.literal("NORMAL"),
      })
      .strict(),
    liveTrading: z.literal(false),
    market: MarketSnapshotSchema,
    account: z
      .object({
        availableUsdt: z.number().finite().nonnegative(),
        marginMode: z.literal("ISOLATED"),
        leverage: z.literal(10),
        source: z.literal("MOCK"),
      })
      .strict(),
    position: PositionSnapshotSchema,
    scheduler: SchedulerPlanSchema,
    history: z.array(z.never()),
    logs: z.array(RuntimeLogSchema).max(100),
  })
  .strict();

export type DashboardSnapshot = z.infer<typeof DashboardSnapshotSchema>;

const EventMetaSchema = {
  version: z.literal(1),
  timestamp: z.string().min(1),
};

export const DashboardEventSchema = z.discriminatedUnion("type", [
  z.object({ ...EventMetaSchema, type: z.literal("auth.state"), payload: AuthStateSchema }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("market.snapshot"), payload: MarketSnapshotSchema }).strict(),
  z.object({
    ...EventMetaSchema,
    type: z.literal("account.balance"),
    payload: z.object({ asset: z.literal("USDT"), available: z.number().finite().nonnegative(), source: z.literal("MOCK") }).strict(),
  }).strict(),
  z.object({ ...EventMetaSchema, type: z.literal("position.changed"), payload: PositionSnapshotSchema }).strict(),
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
