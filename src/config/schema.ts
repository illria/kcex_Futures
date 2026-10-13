import { z } from "zod";
import { isTrustedKcexBaseUrl } from "../kcex/trusted-host.js";
import { DEFAULT_RISK_LIMITS, RiskLimitsSchema, type RiskLimits } from "../../packages/shared/src/risk.js";
import { ExecutionProviderSchema, type ExecutionProvider } from "../../packages/shared/src/execution.js";

const baseUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "KCEX_BASE_URL must be an HTTP(S) URL without embedded credentials.");

const environmentSchema = z.object({
  // KCEX credential autofill is additionally gated by src/kcex/trusted-host.ts.
  KCEX_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    baseUrlSchema.optional(),
  ),
  KCEX_SYMBOL: z.literal("GPS_USDT").optional(),
  AUTH_PROVIDER: z.enum(["FAKE", "KCEX"]).default("FAKE"),
  BROWSER_HEADLESS: z.enum(["true", "false"]).default("false"),
  BROWSER_PROFILE_DIR: z.string().trim().min(1).default("./data/browser-profile"),
  LIVE_TRADING: z.enum(["true", "false"]).default("false"),
  LIVE_EXECUTION_PROVIDER: ExecutionProviderSchema.default("DISABLED"),
  KCEX_AUTOMATION_AUTHORIZED: z.enum(["true", "false"]).default("false"),
  KCEX_READONLY_ENABLED: z.enum(["true", "false"]).default("false"),
  KCEX_READ_POLL_MS: z.coerce.number().int().min(2_000).max(60_000).default(5_000),
  PAPER_FEE_RATE: z.coerce.number().finite().min(0).max(0.01).default(0),
  RISK_MAX_MARGIN_USDT: z.coerce.number().finite().positive().max(50).default(DEFAULT_RISK_LIMITS.maxMarginUsdt),
  RISK_MAX_LEVERAGE: z.coerce.number().finite().positive().max(10).default(DEFAULT_RISK_LIMITS.maxLeverage),
  RISK_MAX_DAILY_TRADES: z.coerce.number().int().min(1).max(10).default(DEFAULT_RISK_LIMITS.maxDailyTrades),
  RISK_MAX_DAILY_LOSS_USDT: z.coerce.number().finite().positive().max(50).default(DEFAULT_RISK_LIMITS.maxDailyLossUsdt),
  RISK_MAX_CONSECUTIVE_FAILURES: z.coerce.number().int().min(1).max(3).default(DEFAULT_RISK_LIMITS.maxConsecutiveFailures),
  KILL_SWITCH_FILE: z.string().trim().min(1).default("./data/KILL_SWITCH"),
});

export interface AppConfig {
  KCEX_BASE_URL: string;
  KCEX_SYMBOL: "GPS_USDT";
  AUTH_PROVIDER: "FAKE" | "KCEX";
  BROWSER_HEADLESS: boolean;
  BROWSER_PROFILE_DIR: string;
  LIVE_TRADING: boolean;
  LIVE_EXECUTION_PROVIDER: ExecutionProvider;
  KCEX_AUTOMATION_AUTHORIZED: boolean;
  KCEX_READONLY_ENABLED: boolean;
  KCEX_READ_POLL_MS: number;
  PAPER_FEE_RATE: number;
  RISK_LIMITS: RiskLimits;
  KILL_SWITCH_FILE: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  _warn: (message: string) => void = (message) => process.stderr.write(message + "\n"),
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const baseUrl = parsed.KCEX_BASE_URL ?? "https://www.kcex.com";

  // Fail before constructing the real adapter or opening a browser. FAKE is
  // intentionally unaffected so CI and fixture auth remain deterministic.
  if (parsed.AUTH_PROVIDER === "KCEX" && !isTrustedKcexBaseUrl(baseUrl)) {
    throw new Error("KCEX_BASE_URL must be exactly https://www.kcex.com when AUTH_PROVIDER=KCEX.");
  }

  const liveTrading = parsed.LIVE_TRADING === "true";
  const automationAuthorized = parsed.KCEX_AUTOMATION_AUTHORIZED === "true";
  if (liveTrading && (
    !automationAuthorized
    || parsed.LIVE_EXECUTION_PROVIDER !== "KCEX"
    || parsed.AUTH_PROVIDER !== "KCEX"
    || !isTrustedKcexBaseUrl(baseUrl)
  )) {
    throw new Error("LIVE_TRADING=true requires KCEX_AUTOMATION_AUTHORIZED=true, KCEX providers, and the trusted KCEX origin.");
  }

  return {
    KCEX_BASE_URL: baseUrl,
    KCEX_SYMBOL: "GPS_USDT",
    AUTH_PROVIDER: parsed.AUTH_PROVIDER,
    BROWSER_HEADLESS: parsed.BROWSER_HEADLESS === "true",
    BROWSER_PROFILE_DIR: parsed.BROWSER_PROFILE_DIR,
    LIVE_TRADING: liveTrading,
    LIVE_EXECUTION_PROVIDER: parsed.LIVE_EXECUTION_PROVIDER,
    KCEX_AUTOMATION_AUTHORIZED: automationAuthorized,
    KCEX_READONLY_ENABLED: parsed.KCEX_READONLY_ENABLED === "true",
    KCEX_READ_POLL_MS: parsed.KCEX_READ_POLL_MS,
    PAPER_FEE_RATE: parsed.PAPER_FEE_RATE,
    RISK_LIMITS: RiskLimitsSchema.parse({
      maxMarginUsdt: parsed.RISK_MAX_MARGIN_USDT,
      maxLeverage: parsed.RISK_MAX_LEVERAGE,
      maxDailyTrades: parsed.RISK_MAX_DAILY_TRADES,
      maxDailyLossUsdt: parsed.RISK_MAX_DAILY_LOSS_USDT,
      maxConsecutiveFailures: parsed.RISK_MAX_CONSECUTIVE_FAILURES,
    }),
    KILL_SWITCH_FILE: parsed.KILL_SWITCH_FILE,
  };
}
