# TASK-007 — RiskEngine + Kill Switch

Status: REVIEW READY

## Objective

Add a fail-closed risk gate to new Paper entries. This task does not submit
orders and does not implement TASK-008.

## Risk architecture

`RiskTradeIntent` and the finite shared risk schemas live in
`packages/shared/src/risk.ts`. The pure `RiskEngine` evaluates only intent,
context, and validated limits. `RiskService` owns filesystem and SQLite reads,
failure audit recovery, and `risk.state` / `risk.blocked` events. The Paper
service requires an injected guard and calls it before computing or persisting
an OPEN fill.

The server initializes storage, then RiskService, then constructs and recovers
PaperTradingService. No live executor or scheduler is part of this architecture.

## Risk limits

Default ceilings:

| Setting | Default ceiling |
| --- | ---: |
| `RISK_MAX_MARGIN_USDT` | 50 USDT |
| `RISK_MAX_LEVERAGE` | 10x |
| `RISK_MAX_DAILY_TRADES` | 10 |
| `RISK_MAX_DAILY_LOSS_USDT` | 50 USDT |
| `RISK_MAX_CONSECUTIVE_FAILURES` | 3 |

Each environment value may lower its ceiling but cannot raise it. Risk checks
allow only `GPS_USDT`. `LIVE` intents always block with
`LIVE_TRADING_DISABLED`; `LIVE_TRADING` remains forced to `false`.

Ordinary entry rule violations produce `BLOCKED`. Unreliable or hard-stop
conditions produce `HALTED`: unknown position, engaged or unknown Kill Switch,
degraded storage, or a reached consecutive-failure limit. Decisions use a
finite ordered reason-code set; an allowed decision has no reasons.

## Kill switch

`KILL_SWITCH_FILE` defaults to `./data/KILL_SWITCH`. The service uses `lstat`
only. Any existing path, including a directory or symlink, is `ENGAGED`; only
`ENOENT` is `CLEAR`; other filesystem errors are `UNKNOWN` and fail closed.
The service never reads, interprets, creates, or removes the file. There is no
network write endpoint or Dashboard control for it.

The switch blocks new entries only. Existing Paper positions may still be
marked, closed, and recovered. Paper plans may be created while the switch is
engaged; the check occurs at open time.

## Daily counters

Daily entry count and loss use an injectable clock and UTC day bounds
`00:00:00.000Z` inclusive through the next midnight exclusive. Entry count uses
`opened_at`, so a PLANNED trade is excluded. Queries are bounded prepared SQL
aggregates on the existing `trades` table.

Daily realized loss sums only the absolute value of negative `realized_pnl` for
`CLOSED` trades by `closed_at`. Winning trades do not offset losses. Open
unrealized loss and prior UTC days do not count.

## Failure counter

Only an explicit server-internal `recordExecutionFailure()` call records a
failure. Invalid input, blocked risk checks, and Paper transition errors do not
increment it. Failure and success records use `audit_events` with category
`RISK` and event types `RISK_EXECUTION_FAILURE` / `RISK_EXECUTION_SUCCESS`.
Startup restores the consecutive count from a bounded newest-first query,
stopping at the latest success. Audit persistence failure makes risk state
unreliable and blocks new entry. No migration or new table is added.

## Unknown-state policy

Kill Switch `UNKNOWN`, degraded storage, unknown or conflicting Paper position,
failed aggregates, and unreadable/corrupt failure history fail closed. Unknown
metrics are represented as `null`, never fabricated as zero, `CLEAR`, or
`FLAT`.

## Paper integration

Open order is: validate input and active planned state, load the PAPER
GPS_USDT record, call RiskService, then calculate the fill and atomically
persist `PLANNED → OPEN` only if allowed. A block writes exactly one
`RISK_BLOCKED` warning audit and leaves status, version, entry price, and
quantity unchanged. It does not append `PAPER_TRADE_OPENED`.

The existing bounded `listOpenPaperTrades({ symbol: "GPS_USDT", limit: 2 })`
query determines FLAT / OPEN / UNKNOWN. Paper's own single-position lifecycle
invariant remains in force. Close, mark, and recovery bypass entry checks.

## Audit behavior and events

Each blocked precheck writes one `RISK_BLOCKED` audit record with only mode,
symbol, side, margin, leverage, and finite reason codes. The WebSocket protocol
adds authoritative `risk.state` and `risk.blocked` events. New WebSocket
connections receive the current `risk.state`; events contain no account or
credential fields.

## Dashboard and API

The Dashboard has a separate read-only Risk Controls panel with status, Kill
Switch state, configured limits, current daily entries, gross realized loss,
consecutive failures, and block reasons. Unknown values render as unavailable.
It always displays `LIVE_TRADING=false` and exposes no arm, enable, disable, or
Kill Switch mutation controls.

The only Risk HTTP route is `GET /api/v1/risk/state`, which refreshes state and
returns `RiskStateSchema`. POST and DELETE risk routes remain absent and return
404. DashboardSnapshot stores `risk` separately from the Paper state.

## Safety boundaries

- `LIVE_TRADING=false` remains enforced; `LIVE` intents always block.
- No real KCEX request, credential use, browser operation, or position source.
- No order submission, cancel, Long/Short UI, leverage or margin mutation.
- No auto trading, scheduler, random direction, TP/SL, or liquidation model.
- No Playwright, KCEX adapter, or page interaction in Risk modules.
- No database migration; schema remains version 1.
- Kill Switch remains operator-controlled through the local filesystem.

## CI requirements

All validation runs only in GitHub Actions with `AUTH_PROVIDER=FAKE`,
`KCEX_READONLY_ENABLED=false`, `LIVE_TRADING=false`, and
`PAPER_FEE_RATE=0`. CI runs `npm ci`, typecheck, build, unit tests, auth browser
fixtures, and futures browser fixtures. This task does not run local validation
or access a real KCEX account.

## Acceptance criteria

- Pure RiskEngine boundary, multi-reason, fail-closed, and LIVE-block tests pass.
- Kill Switch file, directory, symlink, missing, and filesystem error cases pass.
- UTC bounded daily count/loss queries and failure recovery tests pass.
- Paper block leaves the planned record unchanged; switch clear allows the same
  plan to open after refresh; mark/close/recovery remain usable when halted.
- Risk API and WebSocket expose validated read-only state; Dashboard renders it.
- CI is green. TASK-006 is marked COMPLETE; TASK-007 is REVIEW READY only after
  PR CI passes. TASK-008 remains PLANNED and this PR is not merged here.
