import { z } from "zod";

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
  KCEX_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    baseUrlSchema.optional(),
  ),
  KCEX_SYMBOL: z.literal("GPS_USDT").optional(),
  BROWSER_HEADLESS: z.enum(["true", "false"]).default("false"),
  BROWSER_PROFILE_DIR: z.string().trim().min(1).default("./data/browser-profile"),
  LIVE_TRADING: z.enum(["true", "false"]).default("false"),
});

export interface AppConfig {
  KCEX_BASE_URL: string;
  KCEX_SYMBOL: "GPS_USDT";
  BROWSER_HEADLESS: boolean;
  BROWSER_PROFILE_DIR: string;
  LIVE_TRADING: false;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(message + "\n"),
): AppConfig {
  const parsed = environmentSchema.parse(environment);

  if (parsed.LIVE_TRADING === "true") {
    warn("LIVE_TRADING=true was ignored; Task 001 always forces LIVE_TRADING=false.");
  }

  return {
    KCEX_BASE_URL: parsed.KCEX_BASE_URL ?? "https://www.kcex.com",
    KCEX_SYMBOL: "GPS_USDT",
    BROWSER_HEADLESS: parsed.BROWSER_HEADLESS === "true",
    BROWSER_PROFILE_DIR: parsed.BROWSER_PROFILE_DIR,
    LIVE_TRADING: false,
  };
}
