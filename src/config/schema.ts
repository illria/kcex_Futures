import { z } from "zod";
import { isTrustedKcexBaseUrl } from "../kcex/trusted-host.js";

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
  KCEX_READONLY_ENABLED: z.enum(["true", "false"]).default("false"),
  KCEX_READ_POLL_MS: z.coerce.number().int().min(2_000).max(60_000).default(5_000),
});

export interface AppConfig {
  KCEX_BASE_URL: string;
  KCEX_SYMBOL: "GPS_USDT";
  AUTH_PROVIDER: "FAKE" | "KCEX";
  BROWSER_HEADLESS: boolean;
  BROWSER_PROFILE_DIR: string;
  LIVE_TRADING: false;
  KCEX_READONLY_ENABLED: boolean;
  KCEX_READ_POLL_MS: number;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(message + "\n"),
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const baseUrl = parsed.KCEX_BASE_URL ?? "https://www.kcex.com";

  // Fail before constructing the real adapter or opening a browser. FAKE is
  // intentionally unaffected so CI and fixture auth remain deterministic.
  if (parsed.AUTH_PROVIDER === "KCEX" && !isTrustedKcexBaseUrl(baseUrl)) {
    throw new Error("KCEX_BASE_URL must be exactly https://www.kcex.com when AUTH_PROVIDER=KCEX.");
  }

  if (parsed.LIVE_TRADING === "true") {
    warn("LIVE_TRADING=true was ignored; Task 001 always forces LIVE_TRADING=false.");
  }

  return {
    KCEX_BASE_URL: baseUrl,
    KCEX_SYMBOL: "GPS_USDT",
    AUTH_PROVIDER: parsed.AUTH_PROVIDER,
    BROWSER_HEADLESS: parsed.BROWSER_HEADLESS === "true",
    BROWSER_PROFILE_DIR: parsed.BROWSER_PROFILE_DIR,
    LIVE_TRADING: false,
    KCEX_READONLY_ENABLED: parsed.KCEX_READONLY_ENABLED === "true",
    KCEX_READ_POLL_MS: parsed.KCEX_READ_POLL_MS,
  };
}
