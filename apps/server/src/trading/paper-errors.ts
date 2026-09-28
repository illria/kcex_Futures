export type PaperTradingErrorCode =
  | "PAPER_INVALID_TRANSITION"
  | "PAPER_STATE_CONFLICT"
  | "PAPER_MODE_NOT_SUPPORTED"
  | "PAPER_SYMBOL_NOT_SUPPORTED"
  | "PAPER_INVALID_INPUT"
  | "PAPER_SERVICE_CLOSED"
  | "PAPER_TRADE_NOT_FOUND";

export class PaperTradingError extends Error {
  constructor(readonly code: PaperTradingErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PaperTradeInvalidTransitionError extends PaperTradingError {
  constructor() {
    super("PAPER_INVALID_TRANSITION", "The paper trade lifecycle transition is not allowed.");
  }
}

export class PaperStateConflictError extends PaperTradingError {
  constructor(readonly runtimeReconciled = false) {
    super("PAPER_STATE_CONFLICT", "Paper trading state conflicts with persisted records.");
  }
}

export class PaperTradeModeError extends PaperTradingError {
  constructor() {
    super("PAPER_MODE_NOT_SUPPORTED", "Paper trading can only access PAPER records.");
  }
}

export class PaperTradeSymbolError extends PaperTradingError {
  constructor() {
    super("PAPER_SYMBOL_NOT_SUPPORTED", "Paper trading only supports GPS_USDT.");
  }
}

export class PaperTradingInputError extends PaperTradingError {
  constructor() {
    super("PAPER_INVALID_INPUT", "Paper trading input is invalid.");
  }
}

export class PaperTradingServiceClosedError extends PaperTradingError {
  constructor() {
    super("PAPER_SERVICE_CLOSED", "Paper trading service is closed.");
  }
}

export class PaperTradeNotFoundError extends PaperTradingError {
  constructor() {
    super("PAPER_TRADE_NOT_FOUND", "Paper trade was not found.");
  }
}
