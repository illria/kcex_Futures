# TASK-006 — Paper Trading Lifecycle

Status: REVIEW READY

## Objective

Add a deterministic, local-only Paper Trading lifecycle on top of TASK-005
SQLite persistence. Only an explicit server-internal caller may plan, open,
mark, or close a paper trade. This task adds no scheduler, strategy, risk
engine, or KCEX write capability.

## Lifecycle

Runtime state transitions are:

- IDLE → PLANNED through planPaperTrade()
- PLANNED → OPEN through openPaperTrade()
- OPEN → IDLE through closePaperTrade()

The durable trade record retains CLOSED status for history. markPaperTrade()
updates an OPEN paper position in runtime memory only. A mark never opens or
closes a trade. Invalid transitions fail closed and do not change SQLite.

The service allows at most one active lifecycle and one OPEN PAPER GPS_USDT
position. All service mutations are serialized. Unknown records, conflicting
versions, or multiple open paper positions are not retried blindly.

## Pricing and quantity

The simulation is a simplified linear USDT model:

- notionalUsdt = marginUsdt × leverage
- quantity = notionalUsdt ÷ entryPrice
- entryPrice, markPrice, and exitPrice must be finite and greater than zero
- margin and leverage must be finite and greater than zero
- quantity must be finite and greater than zero
- calculated PnL must be finite; fees must be finite and nonnegative

The caller supplies simulated entry, mark, and exit prices. The service does
not read live or fixture market data to create a plan or fill.

## PnL

Gross PnL is calculated without multiplying leverage again:

- LONG: (exitPrice − entryPrice) × quantity
- SHORT: (entryPrice − exitPrice) × quantity

Unrealized PnL uses the same formula with markPrice as the exit price. Runtime
calculations retain finite JavaScript numbers; rounding is presentation-only.

## Simulated fees

PAPER_FEE_RATE is configurable, defaults to 0, and must be finite and between
0 and 0.01 inclusive. It is a simulation parameter, not a KCEX fee claim.

- Entry fee = entryPrice × quantity × feeRate
- Exit fee = exitPrice × quantity × feeRate
- Total fees = entry fee + exit fee
- Realized PnL = gross PnL − total fees

An OPEN record stores its entry fee, including numeric zero. A CLOSED record
stores both simulated fees, including numeric zero. The UI label is
“Simulated Fees” when presenting fee semantics.

## Persistence and lifecycle events

Schema version remains 1; TASK-006 does not add a migration. Planning inserts a
PAPER / GPS_USDT / PLANNED record and PAPER_TRADE_PLANNED event atomically.
Opening and closing use TradeRepository.recordTradeTransition() so each row
change and PAPER_TRADE_OPENED or PAPER_TRADE_CLOSED event commit together.
Transaction failure leaves the prior trade status and version unchanged.

Lifecycle event payloads use SafeAuditPayloadSchema and contain bounded
simulation metadata only. They never contain credentials, account data, OTP,
cookies, tokens, or session data. Mark updates do not append database events;
this prevents high-frequency mark history growth.

## Restart recovery

PaperTradingService.recover() queries at most two OPEN PAPER GPS_USDT records.

- Zero rows: runtime state is IDLE.
- One valid row: runtime state is OPEN, restoring trade id, side, entry,
  quantity, margin, leverage, and opened time. markPrice and unrealizedPnl reset
  to null.
- More than one row or invalid persisted position: runtime state is ERROR and
  future paper mutations are blocked. The read-only Dashboard stays available.

Recovery never creates a plan, repeats an event, recalculates an entry, marks a
price, closes a trade, or accesses KCEX.

## Shared schemas and WebSocket

Paper runtime, paper position, paper.state, trade.opened, and trade.closed
schemas live in packages/shared and are validated by the EventBus. The
Dashboard snapshot has a dedicated paper field; futures.position remains the
KCEX read-only position.

- Every connection receives the authoritative paper.state initial event.
- Recover, plan, open, mark, close, and error outcomes publish paper.state.
- Open and close publish trade.opened and trade.closed.
- A mark publishes paper.state only and creates no SQLite lifecycle event.

## Dashboard and API

The Dashboard has a separate Paper Trading panel labelled “PAPER SIMULATION”
and “NO KCEX ORDER”. It shows status, side, margin, leverage, entry, mark,
quantity, and unrealized PnL. IDLE displays “No open paper position.” KCEX
Read-Only Position remains a separate panel.

GET /api/v1/paper/state is read-only. Paper plan/open/mark/close commands are
server-internal and are not exposed over HTTP. Existing SQLite trade history
is the durable history source; the browser refreshes it after trade lifecycle
events rather than inventing history from WebSocket payloads.

## Safety and out of scope

- LIVE_TRADING is always false; live-arm state is not read or persisted.
- AUTH_PROVIDER=FAKE and KCEX_READONLY_ENABLED=false remain CI defaults.
- No KCEX connection, authentication, credentials, browser, Playwright, or page
  adapter is used by PaperTradingService.
- No scheduler, random direction/trade, price-triggered lifecycle, automatic
  open/close, or market polling integration.
- No order submission, position mutation, leverage/margin change, TP/SL,
  RiskEngine, or kill-switch implementation.
- No liquidation price/model, funding, slippage, spread, order book, or partial
  fill model.
- KCEX contract quantity rules and verified live exchange fees remain deferred.

## CI and acceptance

All verification runs in GitHub Actions on Node 22 with npm ci,
PAPER_FEE_RATE=0, AUTH_PROVIDER=FAKE, KCEX_READONLY_ENABLED=false, and
LIVE_TRADING=false. Do not run local install, build, typecheck, tests, SQLite,
or Playwright commands.

Acceptance includes pure PnL and fee cases; LONG and SHORT lifecycles; price,
fee, mode, symbol, and transition validation; atomic plan/open/close rollback;
one-open and concurrent-open invariants; runtime-only mark behavior; restart
recovery and conflict handling; shared event validation; read-only API and
WebSocket initial state; Dashboard separation and rendering; no paper write
HTTP endpoints; and checks confirming no KCEX or trading mutation dependency.

TASK-006 is REVIEW READY only after its branch is pushed and all GitHub Actions
checks pass. Do not merge this task or begin TASK-007 before final review.
