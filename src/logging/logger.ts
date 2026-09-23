import pino, { type DestinationStream, type Logger } from "pino";

const SECRET_FIELDS = [
  "password",
  "masterKey",
  "secret",
  "otp",
  "verificationCode",
  "cookie",
  "authorization",
  "token",
  "accessToken",
  "refreshToken",
  "session",
  "sessionId",
  "storageState",
  "storage_state",
  "account",
  "email",
] as const;

export const SECRET_REDACTION_PATHS = SECRET_FIELDS.flatMap((field) => [
  field,
  ...Array.from({ length: 6 }, (_, depth) => `${Array.from({ length: depth + 1 }, () => "*").join(".")}.${field}`),
]);

export function createAppLogger(destination?: DestinationStream): Logger {
  const options = {
    level: process.env.LOG_LEVEL ?? "info",
    base: { app: "kcex-futures-local-dashboard" },
    redact: { paths: SECRET_REDACTION_PATHS, censor: "[REDACTED]" },
  };

  return destination ? pino(options, destination) : pino(options);
}

export const logger = createAppLogger();
