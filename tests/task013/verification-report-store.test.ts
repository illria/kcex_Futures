import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KcexVerificationReportStore } from "../../apps/server/src/kcex-live/verification-report-store.js";
import { passingVerificationReport } from "./helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "task013-verification-"));
  directories.push(directory);
  return { store: new KcexVerificationReportStore(join(directory, "verification.json")), file: join(directory, "verification.json") };
}

describe("TASK-013 local KCEX verification report", () => {
  it("writes only a strict, secret-free report and requires the exact manual verification phrase", async () => {
    const { store, file } = await createStore();
    const report = passingVerificationReport();
    await expect(store.saveManual({ report })).rejects.toThrow();
    await store.saveManual({ report, confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" });
    const text = await readFile(file, "utf8");
    const stored = JSON.parse(text) as Record<string, unknown>;
    expect(stored).toMatchObject({ status: "PASS", canaryStatus: "NOT_RUN" });
    for (const forbiddenField of ["account", "email", "password", "otp", "cookies", "token", "storageState", "html", "pageText"]) {
      expect(stored).not.toHaveProperty(forbiddenField);
    }
    await expect(store.saveManual({ report: { ...report, password: "fixture-secret" }, confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" })).rejects.toThrow();
    expect(await readFile(file, "utf8")).not.toContain("fixture-secret");
  });

  it("keeps real execution unverified until read checks and the contract profile pass", async () => {
    const { store } = await createStore();
    const report = passingVerificationReport();
    const incomplete = {
      ...report,
      status: "IN_PROGRESS",
      verifiedAt: null,
      contractProfile: { ...report.contractProfile, status: "UNVERIFIED", verifiedAt: null },
      checks: { ...report.checks, quantitySemantics: "NOT_RUN" },
    };
    const saved = await store.saveManual({ report: incomplete });
    expect(saved.status).toBe("IN_PROGRESS");
    expect((await store.load()).contractProfile.status).toBe("UNVERIFIED");
  });

  it("allows only the Canary flow to set its pass or fail status", async () => {
    const { store } = await createStore();
    await store.saveManual({ report: passingVerificationReport(), confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" });
    expect(await store.markCanaryPass()).toBe(true);
    const report = await store.load();
    expect(report.canaryStatus).toBe("PASS");
    expect(report.checks).toMatchObject({ canaryEntry: "PASS", canaryPosition: "PASS", canaryProtection: "PASS" });
    await expect(store.saveManual({ report, confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION" })).rejects.toThrow();
    expect(await store.markCanaryFail()).toBe(false);
  });
});
