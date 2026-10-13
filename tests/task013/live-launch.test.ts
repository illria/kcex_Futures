import { describe, expect, it } from "vitest";
import {
  EMPTY_KCEX_VERIFICATION_REPORT,
  KcexVerificationReportSchema,
  KcexVerificationSaveInputSchema,
  LIVE_AUTOMATION_CONFIRMATION_PHRASE,
} from "../../packages/shared/src/live-launch.js";
import { getLiveAutomationBlockReasons } from "../../packages/shared/src/live-launch.js";
import { passingVerificationReport, readyLivePreflight, verifiedSelectors } from "./helpers.js";

describe("TASK-013 launch gates and verification protocol", () => {
  it("keeps an empty verification report blocked and rejects a guessed or partial profile", () => {
    const empty = KcexVerificationReportSchema.parse(EMPTY_KCEX_VERIFICATION_REPORT);
    expect(empty.status).toBe("NOT_RUN");
    expect(empty.contractProfile.status).toBe("UNVERIFIED");
    expect(Object.values(empty.selectors).every((selector) => selector.status === "UNVERIFIED")).toBe(true);

    const reasons = getLiveAutomationBlockReasons({
      ...readyLivePreflight(),
      contractProfile: empty.contractProfile,
      selectors: empty.selectors,
      realExecutionVerified: false,
      protectionVerified: false,
      takeProfit: null,
      stopLoss: null,
    });
    expect(reasons).toContain("CONTRACT_PROFILE_UNVERIFIED");
    expect(reasons).toContain("MUTATION_SELECTORS_UNVERIFIED");
    expect(reasons).toContain("EXECUTION_NOT_VERIFIED");
    expect(reasons).toContain("PROTECTION_NOT_VERIFIED");
    expect(reasons).toContain("TP_SL_NOT_CONFIGURED");
  });

  it("accepts only complete read-only verification before Canary fields exist", () => {
    const report = passingVerificationReport();
    expect(report.status).toBe("PASS");
    expect(report.canaryStatus).toBe("NOT_RUN");
    expect(report.checks.canaryEntry).toBe("NOT_RUN");
    expect(KcexVerificationReportSchema.safeParse({ ...report, account: "user@example.invalid" }).success).toBe(false);
    expect(KcexVerificationReportSchema.safeParse({
      ...report,
      checks: { ...report.checks, password: "fixture-password" },
    }).success).toBe(false);
    expect(KcexVerificationReportSchema.safeParse({
      ...report,
      selectors: { ...report.selectors, accountMarker: { selector: "account@example.invalid", status: "VERIFIED" } },
    }).success).toBe(false);
    expect(KcexVerificationReportSchema.safeParse({
      ...report,
      contractProfile: { ...report.contractProfile, quantityStep: 0.005, quantityPrecision: 2 },
    }).success).toBe(false);
  });

  it("requires explicit report confirmation and reserves Canary status for the Canary flow", () => {
    const report = passingVerificationReport();
    expect(KcexVerificationSaveInputSchema.safeParse({ report }).success).toBe(false);
    expect(KcexVerificationSaveInputSchema.safeParse({
      report,
      confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION",
    }).success).toBe(true);
    expect(KcexVerificationSaveInputSchema.safeParse({
      report: { ...report, canaryStatus: "PASS" },
      confirmation: "CONFIRM KCEX READ-ONLY VERIFICATION",
    }).success).toBe(false);
  });

  it("keeps platform authorization, empty orders, resilience, and protection as independent gates", () => {
    const ready = readyLivePreflight();
    const baseline = {
      ...ready,
      takeProfit: { basis: "PRICE_PCT" as const, value: 1 },
      stopLoss: { basis: "PRICE_PCT" as const, value: 1 },
    };
    expect(getLiveAutomationBlockReasons(baseline)).toEqual([]);
    expect(getLiveAutomationBlockReasons({ ...baseline, automationAuthorized: false })).toContain("PLATFORM_AUTHORIZATION_REQUIRED");
    expect(getLiveAutomationBlockReasons({ ...baseline, openOrdersClear: false })).toContain("OPEN_ORDERS_PRESENT");
    expect(getLiveAutomationBlockReasons({ ...baseline, resilienceStatus: "DEGRADED" })).toContain("RESILIENCE_NOT_HEALTHY");
    expect(getLiveAutomationBlockReasons({ ...baseline, killSwitch: "ENGAGED" })).toContain("KILL_SWITCH_ACTIVE");
    expect(LIVE_AUTOMATION_CONFIRMATION_PHRASE).toBe("START KCEX LIVE AUTO");
  });

  it("requires every mutation selector to be verified before exposing the KCEX writer", () => {
    const selectors = verifiedSelectors();
    expect(getLiveAutomationBlockReasons({
      ...readyLivePreflight({ selectors }),
      takeProfit: { basis: "PRICE_PCT", value: 1 },
      stopLoss: { basis: "PRICE_PCT", value: 1 },
    })).toEqual([]);
    const incomplete = { ...selectors, orderSubmit: { selector: null, status: "UNVERIFIED" as const } };
    expect(getLiveAutomationBlockReasons({
      ...readyLivePreflight({ selectors: incomplete }),
      takeProfit: { basis: "PRICE_PCT", value: 1 },
      stopLoss: { basis: "PRICE_PCT", value: 1 },
    })).toContain("MUTATION_SELECTORS_UNVERIFIED");
  });
});
