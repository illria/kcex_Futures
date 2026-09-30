import { randomUUID } from "node:crypto";
import {
  ProtectionAdapterResultSchema,
  type ProtectionAdapterResult,
  type ProtectionPlan,
} from "../../../../packages/shared/src/protection.js";

export interface ProtectionAdapter {
  readonly provider: "FIXTURE";
  activate(plan: ProtectionPlan): Promise<unknown>;
}

/** Local-only simulation. It never contacts a browser or an exchange. */
export class FixtureProtectionAdapter implements ProtectionAdapter {
  readonly provider = "FIXTURE" as const;

  async activate(_plan: ProtectionPlan): Promise<ProtectionAdapterResult> {
    return ProtectionAdapterResultSchema.parse({ status: "ACTIVATED", fixtureProtectionId: randomUUID() });
  }
}
