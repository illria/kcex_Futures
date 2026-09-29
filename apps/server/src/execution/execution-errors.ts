export type AssistedExecutionErrorCode =
  | "EXECUTION_PROVIDER_DISABLED"
  | "ARM_REQUIRED"
  | "INVALID_ARM_ACKNOWLEDGEMENT"
  | "PREVIEW_INVALID"
  | "PREVIEW_EXPIRED"
  | "EXECUTION_BUSY"
  | "STORAGE_DEGRADED"
  | "KCEX_LIVE_EXECUTION_DEFERRED"
  | "UNRESOLVED_EXECUTION_ATTEMPT"
  | "EXECUTION_ATTEMPT_NOT_FOUND"
  | "CONFIRMATION_BUSY";

export class AssistedExecutionError extends Error {
  constructor(readonly code: AssistedExecutionErrorCode, readonly status = 409) {
    super(code);
    this.name = "AssistedExecutionError";
  }
}

export class KcexLiveExecutionDeferredError extends AssistedExecutionError {
  constructor() {
    super("KCEX_LIVE_EXECUTION_DEFERRED", 503);
    this.name = "KcexLiveExecutionDeferredError";
  }
}
