import { z } from "zod";
import type { ExecutionProvider } from "./execution.js";

export const LiveAutomationModeSchema = z.enum(["DISARMED", "ARMED", "WAITING", "DUE", "PRECHECK", "SUBMITTING", "CONFIRMING", "PROTECTING", "POSITION_OPEN", "BLOCKED", "MANUAL_ACTION", "HALTED"]);
export type LiveAutomationMode = z.infer<typeof LiveAutomationModeSchema>;

export const LIVE_AUTOMATION_CONFIRMATION_PHRASE = "START KCEX LIVE AUTO" as const;

export const ProtectionBasisValueSchema = z.object({
  basis: z.enum(["PRICE_PCT", "ROI_PCT"]),
  value: z.number().finite().positive(),
}).strict().superRefine((setting, context) => {
  const minimum = setting.basis === "PRICE_PCT" ? 0.01 : 0.1;
  const maximum = setting.basis === "PRICE_PCT" ? 99 : 500;
  if (setting.value < minimum || setting.value > maximum) {
    context.addIssue({ code: "custom", path: ["value"], message: "Protection percentage is outside its supported range." });
  }
});
export type LiveProtectionSetting = z.infer<typeof ProtectionBasisValueSchema>;

export const LiveAutomationArmInputSchema = z.object({
  confirmation: z.literal(LIVE_AUTOMATION_CONFIRMATION_PHRASE),
}).strict();

export const LiveAutomationProtectionInputSchema = z.object({
  takeProfit: ProtectionBasisValueSchema,
  stopLoss: ProtectionBasisValueSchema,
}).strict();

export const KcexVerificationStatusSchema = z.enum(["NOT_RUN", "IN_PROGRESS", "PASS", "FAIL"]);
export type KcexVerificationStatus = z.infer<typeof KcexVerificationStatusSchema>;

export const KcexCanaryStatusSchema = z.enum(["NOT_RUN", "PASS", "FAIL"]);

export const KcexVerificationCheckKeySchema = z.enum([
  "platformAuthorization", "trustedHost", "passwordLogin", "emailOtp", "googleOAuth", "read", "contractProfile", "positionEvidence",
  "emptyPositionEvidence", "openOrdersEvidence", "emptyOrdersEvidence", "marketOrder", "longSide",
  "shortSide", "marginInput", "isolated", "leverage10", "quantitySemantics", "positionConfirmation",
  "takeProfit", "stopLoss", "protectionEvidence", "unknownHandling", "restartDisarm",
  "canaryEntry", "canaryPosition", "canaryProtection",
]);
export type KcexVerificationCheckKey = z.infer<typeof KcexVerificationCheckKeySchema>;

export const KcexSelectorKeySchema = z.enum([
  "loginMarker", "accountMarker", "symbol", "lastPrice", "markPrice", "availableUsdt",
  "marginMode", "leverage", "positionOpen", "positionFlat", "openOrders", "emptyOrders",
  "marketOrderTab", "longControl", "shortControl", "marginInput", "quantityInput",
  "isolatedControl", "leverageControl", "leverageDialogInput", "leverageDialogSubmit",
  "orderSummary", "orderSubmit", "orderRejected",
  "takeProfitControl", "stopLossControl", "protectionSubmit", "protectionEvidence", "orderNotSubmitted", "googleOAuthStart",
]);
export type KcexSelectorKey = z.infer<typeof KcexSelectorKeySchema>;

export const KcexSelectorVerificationSchema = z.object({
  selector: z.string().max(512).regex(/^(?:#[A-Za-z][A-Za-z0-9_-]{0,127}|\.[A-Za-z_][A-Za-z0-9_-]{0,127}|\[data-[A-Za-z0-9_-]+=["'][A-Za-z0-9_-]{1,96}["']\])$/).nullable(),
  status: z.enum(["VERIFIED", "UNVERIFIED"]),
}).strict().superRefine((value, context) => {
  if (value.status === "VERIFIED" && !value.selector) {
    context.addIssue({ code: "custom", path: ["selector"], message: "A verified selector must be present." });
  }
});
export type KcexSelectorVerification = z.infer<typeof KcexSelectorVerificationSchema>;

export const KcexLiveSelectorManifestSchema = z.object({
  loginMarker: KcexSelectorVerificationSchema,
  accountMarker: KcexSelectorVerificationSchema,
  symbol: KcexSelectorVerificationSchema,
  lastPrice: KcexSelectorVerificationSchema,
  markPrice: KcexSelectorVerificationSchema,
  availableUsdt: KcexSelectorVerificationSchema,
  marginMode: KcexSelectorVerificationSchema,
  leverage: KcexSelectorVerificationSchema,
  positionOpen: KcexSelectorVerificationSchema,
  positionFlat: KcexSelectorVerificationSchema,
  openOrders: KcexSelectorVerificationSchema,
  emptyOrders: KcexSelectorVerificationSchema,
  marketOrderTab: KcexSelectorVerificationSchema,
  longControl: KcexSelectorVerificationSchema,
  shortControl: KcexSelectorVerificationSchema,
  marginInput: KcexSelectorVerificationSchema,
  quantityInput: KcexSelectorVerificationSchema,
  isolatedControl: KcexSelectorVerificationSchema,
  leverageControl: KcexSelectorVerificationSchema,
  leverageDialogInput: KcexSelectorVerificationSchema,
  leverageDialogSubmit: KcexSelectorVerificationSchema,
  orderSummary: KcexSelectorVerificationSchema,
  orderSubmit: KcexSelectorVerificationSchema,
  orderRejected: KcexSelectorVerificationSchema,
  takeProfitControl: KcexSelectorVerificationSchema,
  stopLossControl: KcexSelectorVerificationSchema,
  protectionSubmit: KcexSelectorVerificationSchema,
  protectionEvidence: KcexSelectorVerificationSchema,
  orderNotSubmitted: KcexSelectorVerificationSchema,
  googleOAuthStart: KcexSelectorVerificationSchema,
}).strict();
export type KcexLiveSelectorManifest = z.infer<typeof KcexLiveSelectorManifestSchema>;

export const ContractQuantityUnitSchema = z.enum(["USDT", "GPS", "CONTRACT"]);
export type ContractQuantityUnit = z.infer<typeof ContractQuantityUnitSchema>;

export const KcexMarginModeSemanticsSchema = z.enum(["DIRECT_INPUT", "TOGGLE_CONTROL", "MENU_OPTION"]);
export const KcexLeverageSemanticsSchema = z.enum(["DIRECT_INPUT", "DIALOG_INPUT", "MENU_OPTION"]);
export const KcexMarketOrderSemanticsSchema = z.enum(["TAB_CONTROL", "ORDER_TYPE_SELECTOR"]);

export const VerifiedKcexContractProfileSchema = z.object({
  status: z.enum(["UNVERIFIED", "VERIFIED"]),
  symbol: z.literal("GPS_USDT"),
  quantityUnit: ContractQuantityUnitSchema,
  contractSize: z.number().finite().positive().nullable(),
  quantityStep: z.number().finite().positive(),
  minQuantity: z.number().finite().positive(),
  maxQuantity: z.number().finite().positive().nullable(),
  minNotionalUsdt: z.number().finite().positive().nullable(),
  maxNotionalUsdt: z.number().finite().positive().nullable(),
  quantityPrecision: z.number().int().min(0).max(16),
  pricePrecision: z.number().int().min(0).max(16),
  tickSize: z.number().finite().positive(),
  marginModeSemantics: KcexMarginModeSemanticsSchema,
  leverageSemantics: KcexLeverageSemanticsSchema,
  marketOrderSemantics: KcexMarketOrderSemanticsSchema,
  takeProfitStopLossSemantics: z.enum(["UNVERIFIED", "TARGET_PRICE_INPUT", "ROI_INPUT_PERCENT"]),
  maximumNotionalDeviationBps: z.number().int().min(0).max(100),
  verifiedAt: z.string().datetime().nullable(),
}).strict().superRefine((profile, context) => {
  if (profile.quantityUnit === "CONTRACT" && profile.contractSize === null) {
    context.addIssue({ code: "custom", path: ["contractSize"], message: "Contract size is required for contract-denominated input." });
  }
  if (profile.maxQuantity !== null && profile.maxQuantity < profile.minQuantity) {
    context.addIssue({ code: "custom", path: ["maxQuantity"], message: "Maximum quantity must not be below minimum quantity." });
  }
  if (profile.minNotionalUsdt !== null && profile.maxNotionalUsdt !== null
    && profile.maxNotionalUsdt < profile.minNotionalUsdt) {
    context.addIssue({ code: "custom", path: ["maxNotionalUsdt"], message: "Maximum notional must not be below minimum notional." });
  }
  if (profile.status === "VERIFIED" && !profile.verifiedAt) {
    context.addIssue({ code: "custom", path: ["verifiedAt"], message: "A verified profile requires a verification timestamp." });
  }
});
export type VerifiedKcexContractProfile = z.infer<typeof VerifiedKcexContractProfileSchema>;

export const KcexVerificationReportSchema = z.object({
  schemaVersion: z.literal(1),
  status: KcexVerificationStatusSchema,
  canaryStatus: KcexCanaryStatusSchema,
  verifiedAt: z.string().datetime().nullable(),
  selectors: KcexLiveSelectorManifestSchema,
  contractProfile: VerifiedKcexContractProfileSchema,
  checks: z.record(KcexVerificationCheckKeySchema, KcexVerificationStatusSchema),
}).strict().superRefine((report, context) => {
  if (report.status === "PASS") {
    if (!report.verifiedAt) {
      context.addIssue({ code: "custom", path: ["verifiedAt"], message: "A passing report requires a timestamp." });
    }
    if (report.contractProfile.status !== "VERIFIED") {
      context.addIssue({ code: "custom", path: ["contractProfile", "status"], message: "A passing report requires a verified contract profile." });
    }
    const requiredChecks = KcexVerificationCheckKeySchema.options.filter((key) => !key.startsWith("canary"));
    for (const key of requiredChecks) {
      if (report.checks[key] !== "PASS") {
        context.addIssue({ code: "custom", path: ["checks", key], message: "A passing report requires every verification checkpoint to pass." });
      }
    }
    for (const [key, status] of Object.entries(report.checks)) {
      if (status !== "PASS") context.addIssue({ code: "custom", path: ["checks", key], message: "A passing report cannot contain a nonpassing check." });
    }
    for (const [key, selector] of Object.entries(report.selectors)) {
      if (selector.status !== "VERIFIED" || !selector.selector) {
        context.addIssue({ code: "custom", path: ["selectors", key], message: "A passing report requires every selector to be verified." });
      }
    }
  }
  if (report.canaryStatus === "PASS") {
    if (report.status !== "PASS") context.addIssue({ code: "custom", path: ["status"], message: "Canary verification requires read verification to pass first." });
    for (const key of ["canaryEntry", "canaryPosition", "canaryProtection", "unknownHandling"]) {
      if (report.checks[key] !== "PASS") context.addIssue({ code: "custom", path: ["checks", key], message: "Canary pass requires each live execution check to pass." });
    }
  }
});
export type KcexVerificationReport = z.infer<typeof KcexVerificationReportSchema>;

export const KcexVerificationSaveInputSchema = z.object({
  report: KcexVerificationReportSchema,
  confirmation: z.string().max(64).optional(),
}).strict().superRefine((input, context) => {
  if (input.report.canaryStatus !== "NOT_RUN") {
    context.addIssue({ code: "custom", path: ["report", "canaryStatus"], message: "Only the verified Canary flow may change Canary status." });
  }
  if (input.report.status === "PASS" && input.confirmation !== "CONFIRM KCEX READ-ONLY VERIFICATION") {
    context.addIssue({ code: "custom", path: ["confirmation"], message: "A passing report requires the explicit read-only verification phrase." });
  }
  if (input.report.status !== "PASS" && input.confirmation !== undefined) {
    context.addIssue({ code: "custom", path: ["confirmation"], message: "Verification confirmation is only accepted for a passing report." });
  }
});
export type KcexVerificationSaveInput = z.infer<typeof KcexVerificationSaveInputSchema>;

export const LiveAutomationStateSchema = z.object({
  status: LiveAutomationModeSchema,
  liveTrading: z.boolean(),
  automationAuthorized: z.boolean(),
  provider: z.enum(["DISABLED", "FIXTURE", "KCEX"]),
  authStatus: z.string().max(32),
  resilienceStatus: z.string().max(32),
  readFresh: z.boolean(),
  contractProfileStatus: z.enum(["UNVERIFIED", "VERIFIED"]),
  killSwitch: z.enum(["CLEAR", "ENGAGED", "UNKNOWN"]),
  positionStatus: z.enum(["FLAT", "OPEN", "UNKNOWN"]),
  openOrdersClear: z.boolean(),
  unresolvedExecution: z.boolean(),
  unresolvedProtection: z.boolean(),
  protectionConfigured: z.boolean(),
  takeProfit: ProtectionBasisValueSchema.nullable(),
  stopLoss: ProtectionBasisValueSchema.nullable(),
  canArm: z.boolean(),
  stopRequested: z.boolean(),
  dueSlotId: z.string().uuid().nullable(),
  lastAttemptId: z.string().uuid().nullable(),
  blockReasons: z.array(z.string().max(64)).max(32),
  updatedAt: z.string().datetime(),
}).strict();
export type LiveAutomationState = z.infer<typeof LiveAutomationStateSchema>;

export const LIVE_CANARY_CONFIRMATION_PHRASE = "CONFIRM KCEX LIVE CANARY" as const;

export const LiveCanaryPreviewInputSchema = z.object({
  side: z.enum(["LONG", "SHORT"]),
  marginUsdt: z.number().finite().positive().max(50),
  takeProfit: ProtectionBasisValueSchema,
  stopLoss: ProtectionBasisValueSchema,
}).strict();
export type LiveCanaryPreviewInput = z.infer<typeof LiveCanaryPreviewInputSchema>;

export const LiveCanaryConfirmInputSchema = z.object({
  previewId: z.string().uuid(),
  confirmation: z.literal(LIVE_CANARY_CONFIRMATION_PHRASE),
}).strict();

export const LiveCanaryStateSchema = z.object({
  status: z.enum(["NOT_STARTED", "PREVIEWED", "SUBMITTING", "CONFIRMING", "PROTECTING", "PASSED", "FAILED", "UNKNOWN", "MANUAL_ACTION"]),
  attemptId: z.string().uuid().nullable(),
  side: z.enum(["LONG", "SHORT"]).nullable(),
  marginUsdt: z.number().finite().positive().max(50).nullable(),
  markPrice: z.number().finite().positive().nullable(),
  quantity: z.number().finite().positive().nullable(),
  notionalUsdt: z.number().finite().positive().nullable(),
  previewId: z.string().uuid().nullable(),
  previewExpiresAt: z.string().datetime().nullable(),
  blockReasons: z.array(z.string().max(64)).max(32),
  updatedAt: z.string().datetime(),
}).strict();
export type LiveCanaryState = z.infer<typeof LiveCanaryStateSchema>;

export function createLiveCanaryPlaceholder(now = new Date().toISOString()): LiveCanaryState {
  return LiveCanaryStateSchema.parse({
    status: "NOT_STARTED",
    attemptId: null,
    side: null,
    marginUsdt: null,
    markPrice: null,
    quantity: null,
    notionalUsdt: null,
    previewId: null,
    previewExpiresAt: null,
    blockReasons: ["MANUAL_VERIFICATION_REQUIRED"],
    updatedAt: now,
  });
}

export function createLiveAutomationPlaceholder(now = new Date().toISOString()): LiveAutomationState {
  return LiveAutomationStateSchema.parse({
    status: "DISARMED",
    liveTrading: false,
    automationAuthorized: false,
    provider: "DISABLED",
    authStatus: "APP_LOCKED",
    resilienceStatus: "IDLE",
    readFresh: false,
    contractProfileStatus: "UNVERIFIED",
    killSwitch: "UNKNOWN",
    positionStatus: "UNKNOWN",
    openOrdersClear: false,
    unresolvedExecution: true,
    unresolvedProtection: true,
    protectionConfigured: false,
    takeProfit: null,
    stopLoss: null,
    canArm: false,
    stopRequested: false,
    dueSlotId: null,
    lastAttemptId: null,
    blockReasons: ["LIVE_PROVIDER_DISABLED", "VERIFICATION_REQUIRED"],
    updatedAt: now,
  });
}

export const LiveAutomationBlockReasonSchema = z.enum([
  "AUTH_REQUIRED", "VERIFICATION_REQUIRED", "RESILIENCE_NOT_HEALTHY", "READ_NOT_FRESH",
  "KILL_SWITCH_ACTIVE", "POSITION_NOT_FLAT", "UNRESOLVED_EXECUTION", "UNRESOLVED_PROTECTION",
  "TP_SL_NOT_CONFIGURED", "LIVE_PROVIDER_DISABLED", "PLATFORM_AUTHORIZATION_REQUIRED",
  "CONTRACT_PROFILE_UNVERIFIED", "MUTATION_SELECTORS_UNVERIFIED", "STORAGE_NOT_READY",
  "RISK_LIMIT_REACHED", "EXECUTION_NOT_VERIFIED", "PROTECTION_NOT_VERIFIED", "OPEN_ORDERS_PRESENT",
]);
export type LiveAutomationBlockReason = z.infer<typeof LiveAutomationBlockReasonSchema>;

export function areKcexMutationSelectorsVerified(manifest: KcexLiveSelectorManifest): boolean {
  return [
    "marketOrderTab", "longControl", "shortControl", "marginInput", "quantityInput",
    "isolatedControl", "leverageControl", "leverageDialogInput", "leverageDialogSubmit",
    "orderSummary", "orderSubmit", "orderRejected",
    "takeProfitControl", "stopLossControl", "protectionSubmit", "protectionEvidence", "orderNotSubmitted",
  ].every((key) => manifest[key as keyof KcexLiveSelectorManifest].status === "VERIFIED"
    && manifest[key as keyof KcexLiveSelectorManifest].selector !== null);
}

export function getLiveAutomationBlockReasons(input: {
  liveTrading: boolean;
  automationAuthorized: boolean;
  provider: ExecutionProvider;
  authStatus: string;
  resilienceStatus: string;
  readFresh: boolean;
  contractProfile: VerifiedKcexContractProfile;
  selectors: KcexLiveSelectorManifest;
  killSwitch: "CLEAR" | "ENGAGED" | "UNKNOWN";
  positionStatus: "FLAT" | "OPEN" | "UNKNOWN";
  openOrdersClear: boolean;
  unresolvedExecution: boolean;
  unresolvedProtection: boolean;
  takeProfit: LiveProtectionSetting | null;
  stopLoss: LiveProtectionSetting | null;
  storageReady: boolean;
  riskAllowsEntry: boolean;
  realExecutionVerified: boolean;
  protectionVerified: boolean;
}): LiveAutomationBlockReason[] {
  const reasons: LiveAutomationBlockReason[] = [];
  if (input.authStatus !== "AUTHENTICATED") reasons.push("AUTH_REQUIRED");
  if (!input.automationAuthorized) reasons.push("PLATFORM_AUTHORIZATION_REQUIRED");
  if (!input.liveTrading || input.provider !== "KCEX") reasons.push("LIVE_PROVIDER_DISABLED");
  if (input.resilienceStatus !== "HEALTHY") reasons.push("RESILIENCE_NOT_HEALTHY");
  if (!input.readFresh) reasons.push("READ_NOT_FRESH");
  if (input.killSwitch !== "CLEAR") reasons.push("KILL_SWITCH_ACTIVE");
  if (input.positionStatus !== "FLAT") reasons.push("POSITION_NOT_FLAT");
  if (!input.openOrdersClear) reasons.push("OPEN_ORDERS_PRESENT");
  if (input.unresolvedExecution) reasons.push("UNRESOLVED_EXECUTION");
  if (input.unresolvedProtection) reasons.push("UNRESOLVED_PROTECTION");
  if (!input.takeProfit || !input.stopLoss) reasons.push("TP_SL_NOT_CONFIGURED");
  if (!input.storageReady) reasons.push("STORAGE_NOT_READY");
  if (!input.riskAllowsEntry) reasons.push("RISK_LIMIT_REACHED");
  if (input.contractProfile.status !== "VERIFIED") reasons.push("CONTRACT_PROFILE_UNVERIFIED");
  if (!areKcexMutationSelectorsVerified(input.selectors)) reasons.push("MUTATION_SELECTORS_UNVERIFIED");
  if (!input.realExecutionVerified) reasons.push("EXECUTION_NOT_VERIFIED");
  if (!input.protectionVerified) reasons.push("PROTECTION_NOT_VERIFIED");
  if (input.contractProfile.status !== "VERIFIED" || input.selectors.orderSubmit.status !== "VERIFIED") {
    reasons.push("VERIFICATION_REQUIRED");
  }
  return [...new Set(reasons)];
}

const emptySelectors = Object.fromEntries(
  KcexSelectorKeySchema.options.map((key) => [key, { selector: null, status: "UNVERIFIED" }]),
) as KcexLiveSelectorManifest;

export const EMPTY_KCEX_VERIFICATION_REPORT: KcexVerificationReport = KcexVerificationReportSchema.parse({
  schemaVersion: 1,
  status: "NOT_RUN",
  canaryStatus: "NOT_RUN",
  verifiedAt: null,
  selectors: emptySelectors,
  contractProfile: {
    status: "UNVERIFIED",
    symbol: "GPS_USDT",
    quantityUnit: "USDT",
    contractSize: null,
    quantityStep: 1,
    minQuantity: 1,
    maxQuantity: null,
    minNotionalUsdt: null,
    maxNotionalUsdt: null,
    quantityPrecision: 0,
    pricePrecision: 0,
    tickSize: 1,
    marginModeSemantics: "DIRECT_INPUT",
    leverageSemantics: "DIRECT_INPUT",
    marketOrderSemantics: "TAB_CONTROL",
    takeProfitStopLossSemantics: "UNVERIFIED",
    maximumNotionalDeviationBps: 0,
    verifiedAt: null,
  },
  checks: {},
});
