import {
  EMPTY_KCEX_VERIFICATION_REPORT,
  KcexSelectorKeySchema,
  KcexVerificationCheckKeySchema,
  KcexVerificationReportSchema,
  type KcexLiveSelectorManifest,
  type KcexVerificationReport,
  type VerifiedKcexContractProfile,
} from "../../packages/shared/src/live-launch.js";
import type { LiveAutomationPreflight } from "../../apps/server/src/kcex-live/auto-live-orchestrator.js";

export function verifiedSelectors(): KcexLiveSelectorManifest {
  return Object.fromEntries(KcexSelectorKeySchema.options.map((key) => [key, {
    selector: `#${key}`,
    status: "VERIFIED",
  }])) as KcexLiveSelectorManifest;
}

export function verifiedProfile(overrides: Partial<VerifiedKcexContractProfile> = {}): VerifiedKcexContractProfile {
  return {
    status: "VERIFIED",
    symbol: "GPS_USDT",
    quantityUnit: "GPS",
    contractSize: null,
    quantityStep: 0.1,
    minQuantity: 0.1,
    maxQuantity: 100_000,
    minNotionalUsdt: null,
    maxNotionalUsdt: null,
    quantityPrecision: 1,
    pricePrecision: 2,
    tickSize: 0.01,
    marginModeSemantics: "MENU_OPTION",
    leverageSemantics: "DIRECT_INPUT",
    marketOrderSemantics: "TAB_CONTROL",
    takeProfitStopLossSemantics: "TARGET_PRICE_INPUT",
    maximumNotionalDeviationBps: 100,
    verifiedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

export function passingVerificationReport(): KcexVerificationReport {
  const checks = Object.fromEntries(KcexVerificationCheckKeySchema.options
    .filter((key) => !key.startsWith("canary"))
    .map((key) => [key, "PASS"]));
  return KcexVerificationReportSchema.parse({
    ...EMPTY_KCEX_VERIFICATION_REPORT,
    status: "PASS",
    canaryStatus: "NOT_RUN",
    verifiedAt: "2026-10-01T00:00:00.000Z",
    selectors: verifiedSelectors(),
    contractProfile: verifiedProfile(),
    checks,
  });
}

export function readyLivePreflight(overrides: Partial<LiveAutomationPreflight> = {}): LiveAutomationPreflight {
  return {
    liveTrading: true,
    automationAuthorized: true,
    provider: "KCEX",
    authStatus: "AUTHENTICATED",
    resilienceStatus: "HEALTHY",
    readFresh: true,
    contractProfile: verifiedProfile(),
    selectors: verifiedSelectors(),
    killSwitch: "CLEAR",
    positionStatus: "FLAT",
    openOrdersClear: true,
    unresolvedExecution: false,
    unresolvedProtection: false,
    storageReady: true,
    riskAllowsEntry: true,
    realExecutionVerified: true,
    protectionVerified: true,
    dueSlotId: null,
    lastAttemptId: null,
    ...overrides,
  };
}
