import type { VerifiedKcexContractProfile } from "../../../../packages/shared/src/live-launch.js";

export interface DerivedKcexQuantity {
  inputValue: string;
  quantity: number;
  notionalUsdt: number;
}

/** Derive quantity only from a manually verified contract profile. */
export function deriveKcexQuantity(input: {
  profile: VerifiedKcexContractProfile;
  markPrice: number;
  marginUsdt: number;
  leverage: 10;
}): DerivedKcexQuantity {
  const { profile, markPrice, marginUsdt, leverage } = input;
  if (profile.status !== "VERIFIED") throw new Error("CONTRACT_PROFILE_UNVERIFIED");
  if (profile.symbol !== "GPS_USDT" || !Number.isFinite(markPrice) || markPrice <= 0) throw new Error("MARKET_EVIDENCE_INVALID");
  if (!Number.isFinite(marginUsdt) || marginUsdt <= 0 || marginUsdt > 50 || leverage !== 10) {
    throw new Error("LIVE_PARAMETERS_MISMATCH");
  }

  const targetNotional = marginUsdt * leverage;
  const unitNotional = profile.quantityUnit === "USDT"
    ? 1
    : profile.quantityUnit === "GPS"
      ? markPrice
      : markPrice * (profile.contractSize ?? Number.NaN);
  if (!Number.isFinite(unitNotional) || unitNotional <= 0) throw new Error("CONTRACT_PROFILE_INVALID");

  const precisionTolerance = (value: number) => Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
  const representableStep = Number(profile.quantityStep.toFixed(profile.quantityPrecision));
  if (Math.abs(representableStep - profile.quantityStep) > precisionTolerance(profile.quantityStep)) {
    throw new Error("QUANTITY_PRECISION_EXCEEDED");
  }

  const rawQuantity = targetNotional / unitNotional;
  const stepCount = Math.floor((rawQuantity + Number.EPSILON * Math.max(1, rawQuantity)) / profile.quantityStep);
  if (!Number.isSafeInteger(stepCount)) throw new Error("QUANTITY_PRECISION_EXCEEDED");
  const stepQuantity = stepCount * profile.quantityStep;
  const quantity = Number(stepQuantity.toFixed(profile.quantityPrecision));
  if (Math.abs(quantity - stepQuantity) > precisionTolerance(stepQuantity)) {
    throw new Error("QUANTITY_PRECISION_EXCEEDED");
  }
  if (!Number.isFinite(quantity) || quantity < profile.minQuantity || quantity <= 0) {
    throw new Error("MINIMUM_QUANTITY_NOT_MET");
  }
  if (profile.maxQuantity !== null && quantity > profile.maxQuantity) {
    throw new Error("MAXIMUM_QUANTITY_EXCEEDED");
  }
  const notionalUsdt = quantity * unitNotional;
  if ((profile.minNotionalUsdt !== null && notionalUsdt < profile.minNotionalUsdt)
    || (profile.maxNotionalUsdt !== null && notionalUsdt > profile.maxNotionalUsdt)) {
    throw new Error("NOTIONAL_OUTSIDE_VERIFIED_LIMITS");
  }
  const deviationBps = Math.ceil(Math.abs(notionalUsdt - targetNotional) / targetNotional * 10_000);
  if (deviationBps > profile.maximumNotionalDeviationBps) throw new Error("QUANTITY_STEP_DEVIATION_EXCEEDED");
  const inputValue = quantity.toFixed(profile.quantityPrecision);
  if (Number(inputValue) !== quantity) throw new Error("QUANTITY_PRECISION_EXCEEDED");
  return { inputValue, quantity, notionalUsdt };
}
