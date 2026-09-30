export type ResilienceErrorCode = "RESILIENCE_CLOCK_INVALID";

export class ResilienceRuntimeError extends Error {
  constructor(readonly code: ResilienceErrorCode) {
    super(code);
    this.name = "ResilienceRuntimeError";
  }
}
