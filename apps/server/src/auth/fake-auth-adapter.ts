import { timingSafeEqual } from "node:crypto";
import { FAKE_OTP_CODE } from "../../../../packages/shared/src/fake-auth.js";
import type { AuthAdapter, AuthAdapterResult, AuthCredentials } from "./auth-adapter.js";

export type FakeLoginResult = Extract<AuthAdapterResult, "OTP_REQUIRED" | "AUTH_FAILED">;

export class FakeAuthAdapter implements AuthAdapter {
  readonly provider = "FAKE" as const;

  async login({ account }: AuthCredentials): Promise<FakeLoginResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    return account.toLowerCase().startsWith("fail@") ? "AUTH_FAILED" : "OTP_REQUIRED";
  }

  async submitOtp(candidate: Buffer): Promise<AuthAdapterResult> {
    const expected = Buffer.from(FAKE_OTP_CODE, "utf8");
    try {
      return candidate.length === expected.length && timingSafeEqual(candidate, expected)
        ? "AUTHENTICATED"
        : "AUTH_FAILED";
    } finally {
      expected.fill(0);
    }
  }

  async checkSession(): Promise<AuthAdapterResult> {
    return "SESSION_LOST";
  }
}
