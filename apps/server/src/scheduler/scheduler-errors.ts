export class SchedulerRuntimeError extends Error {
  constructor(readonly code: "SCHEDULER_CLOCK_INVALID" | "SCHEDULER_STATE_INVALID") {
    super(code);
    this.name = "SchedulerRuntimeError";
  }
}
