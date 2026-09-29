import { ExecutionPositionStateSchema, type ExecutionPositionState } from "../../../../packages/shared/src/execution.js";

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
