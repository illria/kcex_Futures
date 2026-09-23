import { timingSafeEqual } from "node:crypto";
import { FAKE_OTP_CODE } from "../../../../packages/shared/src/fake-auth.js";

export type FakeLoginResult = "OTP_REQUIRED" | "AUTH_FAILED";

export class FakeAuthAdapter {
  async login(account: string): Promise<FakeLoginResult> {
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    return account.toLowerCase().startsWith("fail@") ? "AUTH_FAILED" : "OTP_REQUIRED";
  }

  async verifyOtp(candidate: Buffer): Promise<boolean> {
    const expected = Buffer.from(FAKE_OTP_CODE, "utf8");
    try {
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    } finally {
      expected.fill(0);
    }
  }
}
