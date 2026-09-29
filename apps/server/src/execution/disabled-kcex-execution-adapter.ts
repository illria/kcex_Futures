import type { AssistedLivePreview, ExecutionAdapterResult } from "../../../../packages/shared/src/execution.js";
import type { ExecutionAdapter } from "./execution-adapter.js";
import { KcexLiveExecutionDeferredError } from "./execution-errors.js";

export class DisabledKcexExecutionAdapter implements ExecutionAdapter {
  readonly provider = "DISABLED" as const;

  async submit(_preview: AssistedLivePreview): Promise<ExecutionAdapterResult> {
    throw new KcexLiveExecutionDeferredError();
  }
}
