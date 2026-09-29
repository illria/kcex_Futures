import { ExecutionPositionStateSchema, type ExecutionPositionState } from "../../../../packages/shared/src/execution.js";
import type { StorageService } from "../storage/storage-service.js";

export interface ExecutionPositionSource {
  getPositionState(): Promise<ExecutionPositionState> | ExecutionPositionState;
}

/** Explicit mock position source; it never reads Paper or exchange state. */
export class FixtureExecutionPositionSource implements ExecutionPositionSource {
  private state: ExecutionPositionState;

  constructor(initialState: ExecutionPositionState = "UNKNOWN") {
    this.state = ExecutionPositionStateSchema.parse(initialState);
  }

  getPositionState(): ExecutionPositionState {
    return this.state;
  }

  setPositionState(state: ExecutionPositionState): void {
    this.state = ExecutionPositionStateSchema.parse(state);
  }
}

/** Resolves the restart-safe fixture position state from durable attempts. */
export function resolveInitialFixturePositionState(
  storage: Pick<StorageService, "executionAttempts">,
): ExecutionPositionState {
  const attempts = storage.executionAttempts;
  if (attempts.getBlockingAttempt()) return "UNKNOWN";

  const latest = attempts.getLatestAttempt();
  if (!latest || latest.status === "FAILED") return "FLAT";
  return "UNKNOWN";
}
