import type { RiskReasonCode } from "../../../../packages/shared/src/risk.js";

export class RiskBlockedError extends Error {
  constructor(readonly reasons: readonly RiskReasonCode[]) {
    super("Paper entry is blocked by risk controls.");
    this.name = "RiskBlockedError";
  }
}
