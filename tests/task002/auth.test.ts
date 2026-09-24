import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_OTP_CODE } from "../../packages/shared/src/fake-auth.js";
import { createAuthFixture, TEST_ACCOUNT, TEST_MASTER_KEY, TEST_PASSWORD } from "./helpers.js";

describe("Task 002 fake auth and OTP lifecycle", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("moves through credential, login, OTP, and authenticated states using FakeAuthAdapter", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    const seen: string[] = [];
    fixture.events.subscribe((event) => {
      if (event.type === "auth.state") seen.push(event.payload.status);
    });

    expect((await fixture.auth.unlock(TEST_MASTER_KEY)).status).toBe("CREDENTIALS_REQUIRED");
    await fixture.auth.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, false);
    expect((await fixture.auth.login()).status).toBe("OTP_REQUIRED");
    const candidate = Buffer.from(FAKE_OTP_CODE, "utf8");
    expect((await fixture.auth.submitOtp(candidate)).status).toBe("AUTHENTICATED");

    expect([...candidate]).toEqual(new Array(6).fill(0));
    expect(seen).toEqual([
      "CREDENTIALS_REQUIRED",
      "VAULT_UNLOCKED",
      "LOGGING_IN",
      "OTP_REQUIRED",
      "AUTHENTICATED",
    ]);
    await expect(readFile(fixture.filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an OTP after its in-memory expiry and zeroes the submitted buffer", async () => {
    let now = 1_000_000;
    const fixture = await createAuthFixture({ otpTtlMs: 30_000, now: () => now });
    cleanup = fixture.cleanup;
    await fixture.auth.unlock(TEST_MASTER_KEY);
    await fixture.auth.saveCredentials(TEST_ACCOUNT, TEST_PASSWORD, false);
    expect((await fixture.auth.login()).status).toBe("OTP_REQUIRED");
    now += 30_001;
    const candidate = Buffer.from(FAKE_OTP_CODE, "utf8");

    expect((await fixture.auth.submitOtp(candidate)).status).toBe("AUTH_FAILED");
    expect([...candidate]).toEqual(new Array(6).fill(0));
    expect(fixture.auth.getState().status).toBe("AUTH_FAILED");
    await expect(readFile(fixture.filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses only the fake failure fixture and never authenticates it", async () => {
    const fixture = await createAuthFixture();
    cleanup = fixture.cleanup;
    await fixture.auth.unlock(TEST_MASTER_KEY);
    await fixture.auth.saveCredentials("fail@example.test", TEST_PASSWORD, false);

    expect((await fixture.auth.login()).status).toBe("AUTH_FAILED");
    expect(fixture.auth.getState().authProvider).toBe("FAKE");
    expect(fixture.auth.getState().liveTrading).toBe(false);
  });
});
