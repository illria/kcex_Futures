import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createDashboardServer } from "../../apps/server/src/api/http-server.js";
import { AuthService } from "../../apps/server/src/auth/auth-service.js";
import type { AuthAdapter } from "../../apps/server/src/auth/auth-adapter.js";
import { EventBus } from "../../apps/server/src/realtime/event-bus.js";
import { EncryptedCredentialVault } from "../../apps/server/src/vault/encrypted-vault.js";
import { KcexVerificationReportStore } from "../../apps/server/src/kcex-live/verification-report-store.js";
import { passingVerificationReport } from "./helpers.js";

const MASTER_KEY = "task013-verification-api-master-key";

class FakeKcexAuthAdapter implements AuthAdapter {
  readonly provider = "KCEX" as const;
  async login(): Promise<"AUTHENTICATED"> { return "AUTHENTICATED"; }
  async submitOtp(): Promise<"AUTHENTICATED"> { return "AUTHENTICATED"; }
  async checkSession(): Promise<"AUTHENTICATED"> { return "AUTHENTICATED"; }
}

describe("TASK-013 local read-only verification API", () => {
  let directory = "";
  let server: ReturnType<typeof createDashboardServer> | null = null;
  let auth: AuthService | null = null;

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    auth?.close();
    server = null;
    auth = null;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  it("requires authenticated KCEX read-only state, same-origin POST, and explicit report confirmation", async () => {
    directory = await mkdtemp(join(tmpdir(), "task013-verification-api-"));
    const events = new EventBus();
    const vault = new EncryptedCredentialVault(join(directory, "vault.json"));
    auth = new AuthService(vault, events, { info: () => undefined, warn: () => undefined } as unknown as Logger, new FakeKcexAuthAdapter());
    const store = new KcexVerificationReportStore(join(directory, "report.json"));
    let changedStatus = "NOT_RUN";
    server = createDashboardServer({
      auth,
      vault,
      events,
      futuresRead: { enabled: true } as never,
      verificationReportStore: store,
      onVerificationReportChanged: (report) => { changedStatus = report.status; },
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/json", origin: baseUrl };

    const locked = await fetch(`${baseUrl}/api/v1/kcex-verification/report`, {
      method: "POST", headers, body: JSON.stringify({ report: passingVerificationReport(), confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" }),
    });
    expect(locked.status).toBe(409);

    await auth.unlock(MASTER_KEY);
    await auth.saveCredentials("fixture-account@example.test", "fixture-password", false);
    expect((await auth.login()).status).toBe("AUTHENTICATED");

    const missingConfirmation = await fetch(`${baseUrl}/api/v1/kcex-verification/report`, {
      method: "POST", headers, body: JSON.stringify({ report: passingVerificationReport() }),
    });
    expect(missingConfirmation.status).toBe(400);

    const saved = await fetch(`${baseUrl}/api/v1/kcex-verification/report`, {
      method: "POST",
      headers,
      body: JSON.stringify({ report: passingVerificationReport(), confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" }),
    });
    expect(saved.status).toBe(200);
    const responseText = await saved.text();
    expect(responseText).toContain('"status":"PASS"');
    expect(responseText).not.toContain("fixture-password");
    expect(responseText).not.toContain("fixture-account@example.test");
    expect(changedStatus).toBe("PASS");

    const noOrigin = await fetch(`${baseUrl}/api/v1/kcex-verification/report`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ report: passingVerificationReport(), confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" }),
    });
    expect(noOrigin.status).toBe(403);
  });
});
