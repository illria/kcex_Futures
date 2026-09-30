export class StorageInitializationError extends Error {
  constructor() {
    super("Trading storage could not be initialized.");
    this.name = "StorageInitializationError";
  }
}

export class DatabaseSchemaTooNewError extends Error {
  constructor(readonly databaseVersion: number, readonly supportedVersion: number) {
    super("DATABASE_SCHEMA_TOO_NEW");
    this.name = "DatabaseSchemaTooNewError";
  }
}

export class StorageDataIntegrityError extends Error {
  constructor(readonly entity: string) {
    super(`Stored ${entity} data failed validation.`);
    this.name = "StorageDataIntegrityError";
  }
}

export class DuplicateTradeError extends Error {
  constructor() {
    super("Trade ID already exists.");
    this.name = "DuplicateTradeError";
  }
}

export class TradeNotFoundError extends Error {
  constructor() {
    super("Trade record was not found.");
    this.name = "TradeNotFoundError";
  }
}

export class TradeVersionConflictError extends Error {
  constructor() {
    super("Trade record version conflict.");
    this.name = "TradeVersionConflictError";
  }
}

export class ExecutionAttemptConflictError extends Error {
  constructor() {
    super("Execution attempt version conflict.");
    this.name = "ExecutionAttemptConflictError";
  }
}

export class ExecutionAttemptNotFoundError extends Error {
  constructor() {
    super("Execution attempt was not found.");
    this.name = "ExecutionAttemptNotFoundError";
  }
}

export class InvalidExecutionAttemptTransitionError extends Error {
  constructor() {
    super("Execution attempt transition is not allowed.");
    this.name = "InvalidExecutionAttemptTransitionError";
  }
}

export class SchedulerSlotConflictError extends Error {
  constructor() {
    super("Scheduler slot state or confirmation evidence conflicted.");
    this.name = "SchedulerSlotConflictError";
  }
}
