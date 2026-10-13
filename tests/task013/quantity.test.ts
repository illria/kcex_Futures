import { describe, expect, it } from "vitest";
import { deriveKcexQuantity } from "../../apps/server/src/kcex-live/quantity.js";
import { verifiedProfile } from "./helpers.js";

describe("TASK-013 verified contract sizing", () => {
  it("derives exact GPS quantity from the verified unit, mark price, and 50 USDT × 10 target", () => {
    expect(deriveKcexQuantity({
      profile: verifiedProfile(), markPrice: 2, marginUsdt: 50, leverage: 10,
    })).toEqual({ inputValue: "250.0", quantity: 250, notionalUsdt: 500 });
  });

  it("uses USDT and contract-unit semantics without assuming quantity equals 500 divided by price", () => {
    expect(deriveKcexQuantity({
      profile: verifiedProfile({ quantityUnit: "USDT", quantityStep: 1, minQuantity: 1, maxQuantity: 600, quantityPrecision: 0 }),
      markPrice: 2,
      marginUsdt: 50,
      leverage: 10,
    })).toEqual({ inputValue: "500", quantity: 500, notionalUsdt: 500 });
    expect(deriveKcexQuantity({
      profile: verifiedProfile({ quantityUnit: "CONTRACT", contractSize: 0.01, quantityStep: 1, minQuantity: 1, quantityPrecision: 0 }),
      markPrice: 2,
      marginUsdt: 50,
      leverage: 10,
    })).toMatchObject({ quantity: 25_000, notionalUsdt: 500 });
  });

  it("blocks unverified profiles, invalid margin, precision, min/max, and notional deviations without clamping", () => {
    expect(() => deriveKcexQuantity({
      profile: verifiedProfile({ status: "UNVERIFIED", verifiedAt: null }), markPrice: 2, marginUsdt: 50, leverage: 10,
    })).toThrow("CONTRACT_PROFILE_UNVERIFIED");
    expect(() => deriveKcexQuantity({ profile: verifiedProfile(), markPrice: 2, marginUsdt: 0, leverage: 10 })).toThrow();
    expect(() => deriveKcexQuantity({ profile: verifiedProfile(), markPrice: 2, marginUsdt: 51, leverage: 10 })).toThrow("LIVE_PARAMETERS_MISMATCH");
    expect(() => deriveKcexQuantity({
      profile: verifiedProfile({ minQuantity: 300 }), markPrice: 2, marginUsdt: 50, leverage: 10,
    })).toThrow("MINIMUM_QUANTITY_NOT_MET");
    expect(() => deriveKcexQuantity({
      profile: verifiedProfile({ maxQuantity: 200 }), markPrice: 2, marginUsdt: 50, leverage: 10,
    })).toThrow("MAXIMUM_QUANTITY_EXCEEDED");
    expect(() => deriveKcexQuantity({
      profile: verifiedProfile({ minNotionalUsdt: 501 }), markPrice: 2, marginUsdt: 50, leverage: 10,
    })).toThrow("NOTIONAL_OUTSIDE_VERIFIED_LIMITS");
    expect(() => deriveKcexQuantity({
      profile: verifiedProfile({ quantityStep: 0.3, maximumNotionalDeviationBps: 3 }),
      markPrice: 2,
      marginUsdt: 50,
      leverage: 10,
    })).toThrow("QUANTITY_STEP_DEVIATION_EXCEEDED");
    expect(() => deriveKcexQuantity({
      profile: verifiedProfile({ quantityStep: 0.005, quantityPrecision: 2 }),
      markPrice: 2,
      marginUsdt: 50,
      leverage: 10,
    })).toThrow("QUANTITY_PRECISION_EXCEEDED");
  });
});
