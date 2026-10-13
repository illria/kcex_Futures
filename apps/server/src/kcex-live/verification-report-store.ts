import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  EMPTY_KCEX_VERIFICATION_REPORT,
  KcexVerificationReportSchema,
  KcexVerificationSaveInputSchema,
  type KcexVerificationReport,
  type KcexVerificationSaveInput,
} from "../../../../packages/shared/src/live-launch.js";

/** Local metadata only. Credentials, browser state, page text and HTML have no schema fields. */
export class KcexVerificationReportStore {
  private readonly filePath: string;

  constructor(filePath = resolve(process.cwd(), "data/kcex-verification-report.json")) {
    this.filePath = resolve(filePath);
  }

  async load(): Promise<KcexVerificationReport> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      try {
        return KcexVerificationReportSchema.parse(JSON.parse(raw));
      } finally {
        // The report contains selectors and numeric contract metadata only.
      }
    } catch {
      return EMPTY_KCEX_VERIFICATION_REPORT;
    }
  }

  async save(reportInput: KcexVerificationReport): Promise<void> {
    const report = KcexVerificationReportSchema.parse(reportInput);
    const serialized = JSON.stringify(report, null, 2) + "\n";
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await import("node:fs/promises").then(({ rm }) => rm(temporaryPath, { force: true })).catch(() => undefined);
      throw error;
    }
  }

  async saveManual(inputValue: unknown): Promise<KcexVerificationReport> {
    const input: KcexVerificationSaveInput = KcexVerificationSaveInputSchema.parse(inputValue);
    const current = await this.load();
    if (current.canaryStatus !== "NOT_RUN") throw new Error("CANARY_REPORT_LOCKED");
    await this.save(input.report);
    return input.report;
  }

  async markCanaryPass(): Promise<boolean> {
    const current = await this.load();
    if (current.status !== "PASS" || current.checks.unknownHandling !== "PASS") return false;
    const checks = {
      ...current.checks,
      canaryEntry: "PASS" as const,
      canaryPosition: "PASS" as const,
      canaryProtection: "PASS" as const,
    };
    await this.save(KcexVerificationReportSchema.parse({
      ...current,
      canaryStatus: "PASS",
      verifiedAt: new Date().toISOString(),
      checks,
    }));
    return true;
  }

  async markCanaryFail(): Promise<boolean> {
    const current = await this.load();
    if (current.status !== "PASS" || current.canaryStatus !== "NOT_RUN") return false;
    await this.save(KcexVerificationReportSchema.parse({ ...current, canaryStatus: "FAIL" }));
    return true;
  }
}
