import type { AuthProvider } from "../../../../packages/shared/src/protocol.js";

export interface AuthCredentials {
  readonly account: string;
  readonly password: string;
}

export type AuthAdapterResult =
  | "AUTHENTICATED"
  | "OTP_REQUIRED"
  | "AUTH_FAILED"
  | "AUTH_UNKNOWN"
  | "MANUAL_CHALLENGE"
  | "SESSION_LOST";

/**
 * The service talks to one adapter only. Page selectors and browser calls stay
 * behind the KCEX adapter, while CI can inject the deterministic fake adapter.
 */
export interface AuthAdapter {
  readonly provider: AuthProvider;
  login(credentials: AuthCredentials): Promise<AuthAdapterResult>;
  submitOtp(candidate: Buffer): Promise<AuthAdapterResult>;
  checkSession(): Promise<AuthAdapterResult>;
  restoreSession?(storageState: unknown): Promise<AuthAdapterResult>;
  exportSession?(): Promise<unknown>;
  close?(): Promise<void> | void;
}
