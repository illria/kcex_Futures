import type { PaperEntryRiskGuard } from "../../apps/server/src/trading/paper-trading-service.js";

/** Explicit permissive guard for lifecycle-only fixtures; production never imports this file. */
export const allowPaperEntryForFixture: PaperEntryRiskGuard = {
  assertCanOpen: () => undefined,
};
