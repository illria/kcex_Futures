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
