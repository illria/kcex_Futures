import type { AssistedLivePreview, ExecutionAdapterResult } from "../../../../packages/shared/src/execution.js";

export interface ExecutionAdapter {
  readonly provider: "DISABLED" | "FIXTURE";
  submit(preview: AssistedLivePreview): Promise<ExecutionAdapterResult>;
}
