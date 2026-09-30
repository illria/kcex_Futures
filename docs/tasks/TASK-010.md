# TASK-010 — TP/SL Protection Management

## Status and boundary

Status: COMPLETE

This task implements fixture-only protection planning, activation, persistence,
restart recovery, and explicit fixture mark-trigger simulation. The protection
provider is `FIXTURE ONLY`. Real KCEX take-profit or stop-loss orders, reduce-only
orders, cancellation, modification, and position close remain `DEFERRED`.

`LIVE_TRADING=false` remains mandatory. This task does not start TASK-011 and
does not create LIVE trade rows, real fills, or real PnL.

## Position identity and eligibility

A plan must bind to the latest durable `CONFIRMED` execution attempt, with no
unresolved execution attempt. The confirmed evidence must be a fixture
`MATCHED_OPEN` record for `GPS_USDT`, with matching side and positive entry price
and size. Leverage and size are read from durable execution evidence. The client
may submit only the attempt ID and explicit TP/SL basis/value pairs.

The runtime execution position source must be `OPEN`. `FLAT` and `UNKNOWN` fail
closed. An unresolved execution attempt or an older confirmed attempt is
rejected. A Kill Switch state does not block protection of an already confirmed
open position; protection does not call the entry RiskEngine.

## Percentage semantics

Both legs are required, and each basis must be selected explicitly. There are no
implicit TP/SL defaults.

- `PRICE_PCT` is the absolute price move from entry: 0.01 through 99.00.
- `ROI_PCT` is a fixture linear leveraged ROI approximation: 0.1 through 500.0.
  The calculator uses `priceMovePct = roiPct / leverage` before applying the
  directional price formula.

For LONG, TP increases and SL decreases price. For SHORT, TP decreases and SL
increases price. Targets must be finite and positive, and must be on the correct
side of entry. Computation uses numeric values without tick-size rounding. ROI
does not claim to match KCEX; fees, funding, mark-price rules, contract rules,
and slippage are not included.

## Preview and confirmation

`POST /api/v1/protection/preview` accepts a strict body containing the execution
attempt ID and both basis/value pairs. The backend loads the remaining position
fields and returns an immutable preview that expires after 60 seconds. A random
confirmation token exists only in backend memory and in the direct preview
response. It is never persisted, audited, logged, or broadcast over WebSocket.

`POST /api/v1/protection/confirm` accepts only `previewId` and the token. It
rechecks storage health, execution evidence, latest-attempt identity, and OPEN
position state. It commits durable `PLANNED`, lifecycle history, and audit before
invoking the adapter.

All protection write routes require loopback and same-origin checks. Unknown
fields are rejected. No public mark-input, retry, force-active, clear, or
exchange-mutation route is provided.

## Durable lifecycle and recovery

SQLite schema v3 is appended after immutable v1 and v2 migrations. It contains
`protection_plans` and append-only `protection_events`. Each execution attempt
has at most one plan. A partial unique index permits at most one
`GPS_USDT` plan in `PLANNED`, `ACTIVE`, or `UNKNOWN` state.

Allowed transitions are `PLANNED -> ACTIVE`, `PLANNED -> ERROR` only after an
explicit fixture `FAILED_NOT_ACTIVATED` result, `PLANNED -> UNKNOWN` for an
ambiguous outcome, `ACTIVE -> TRIGGERED_TP/TRIGGERED_SL/UNKNOWN`, and an explicit
user re-preview may re-arm an `ERROR` plan to `PLANNED`. `UNKNOWN` and triggered
states cannot be force-cleared or reactivated.

Only `FixtureProtectionAdapter` exists. A validated `ACTIVATED` result produces
`ACTIVE` with a `fixtureProtectionId`, never an exchange order ID. Explicit
`FAILED_NOT_ACTIVATED` becomes `ERROR`. Timeout, throw, malformed response, or
failure to durably record the result becomes `UNKNOWN`; activation is never
retried automatically. UNKNOWN blocks duplicate protection.

On restart, fixture `ACTIVE` is restored as fixture `ACTIVE`; interrupted
`PLANNED` becomes `UNKNOWN`; `UNKNOWN` stays UNKNOWN; triggered states remain
triggered and the runtime position is UNKNOWN. No restart path activates a
plan. A future real provider must verify protection using read-only exchange
evidence after restart and cannot reuse the fixture recovery assumption.

## Trigger simulation

Only an internal fixture evaluator accepts an explicit mark value. It is not
exposed as HTTP and no live mark feed is connected. LONG triggers TP at or above
TP and SL at or below SL; SHORT triggers TP at or below TP and SL at or above
SL. If the evaluator cannot identify one leg, the result is UNKNOWN.

`TRIGGERED_TP` and `TRIGGERED_SL` mean only that a fixture price condition
crossed. They do not mean an order filled or a position closed. No close call is
made and the position source becomes UNKNOWN until a separate confirmation.

## Dashboard and events

The Dashboard displays a Position Protection panel with attempt identity,
side, entry, size, leverage, both bases/values, and derived target prices. Basis
labels are `Price move %` and `Simulated leveraged ROI %`. It always warns
`FIXTURE PROTECTION ONLY · NO KCEX TP/SL ORDER EXISTS`; ACTIVE and UNKNOWN have
additional explicit status warnings. The user sees targets before confirmation.

Shared WebSocket events are `protection.state`, `protection.activated`,
`protection.triggered`, and `protection.unknown`. New connections receive the
current durable/runtime protection state.

## Validation boundary

All install, build, typecheck, unit, and browser-fixture checks run in GitHub
Actions only. The local checkout is limited to code edits and Git operations.
CI uses FAKE auth, fixture execution/protection, `KCEX_READONLY_ENABLED=false`,
and `LIVE_TRADING=false`; it contains no KCEX credentials.
