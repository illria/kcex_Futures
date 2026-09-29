# TASK-009 — Position Confirmation + UNKNOWN State

Status: REVIEW READY

## Objective and safety boundary

Extend the TASK-008 fixture-only submission flow with a durable execution
attempt record and bounded position-evidence confirmation. Submission acceptance
is not position confirmation. `CONFIRMED` means only that fixture evidence
matched the fixture intent; it does not represent a KCEX position.

`LIVE_TRADING=false` remains permanent. Execution providers remain
`DISABLED | FIXTURE`; no real KCEX write adapter, request, credential, or
confirmation source is introduced. TASK-010 protection orders and TASK-011
scheduling remain out of scope.

## Durable attempts

SQLite schema version 2 appends migration
`durable_execution_attempt_confirmation`; migration 1 remains unchanged. The
`execution_attempts` repository validates rows and transitions, uses optimistic
versions, and has a partial unique index that permits at most one unresolved
GPS_USDT attempt. The first `SUBMITTING` row and its
`LIVE_ATTEMPT_SUBMITTING` audit event commit in one transaction before the
adapter is called.

Allowed lifecycle:

```text
SUBMITTING -> SUBMITTED -> CONFIRMING -> CONFIRMED
      |             |             |
      +-------------+-------------+-> UNKNOWN
SUBMITTING -> FAILED (only explicit outcome=NOT_SUBMITTED)
UNKNOWN -> CONFIRMING (manual evidence reconciliation only)
```

Timeout, throw, malformed adapter response, or uncertain persistence after the
adapter was invoked becomes `UNKNOWN`. It is never retried. UNKNOWN blocks arm,
preview, confirmation, and any new adapter submit. On restart, interrupted
SUBMITTING/SUBMITTED/CONFIRMING attempts become UNKNOWN; UNKNOWN remains
unresolved. CONFIRMED is restored as fixture history but does not infer an open
position after restart.

## Confirmation

Only `FixturePositionConfirmationSource` is supported. Polling is bounded to a
maximum ten-second deadline and a 500 ms default interval. `NO_POSITION` keeps
polling and deadline exhaustion becomes UNKNOWN. Evidence must be fresh and
match GPS_USDT, intended side, positive entry price, positive size, and fixture
source. Mismatch, unavailable source, invalid evidence, or source error becomes
UNKNOWN. Position size is never derived from margin, leverage, or reference
price.

Risk success is recorded only after CONFIRMED. UNKNOWN records
`UNKNOWN_RESULT` once per durable attempt; repeated reconciliation is
idempotent. No LIVE trade row is created.

## API, events, and UI

- `POST /api/v1/live/reconcile` accepts exactly `{ "attemptId": "<uuid>" }`,
  requires same-origin, reads fixture evidence only, and never calls the
  execution adapter.
- There is no retry or force-clear endpoint.
- Shared WebSocket events: `execution.confirming`, `execution.confirmed`, and
  `execution.unknown`.
- Dashboard distinguishes SUBMITTED, CONFIRMING, fixture CONFIRMED, FAILED only
  with explicit NOT_SUBMITTED, and UNKNOWN. UNKNOWN warns that new entries are
  blocked and offers manual reconciliation.

## CI acceptance

All validation runs through GitHub Actions: `npm ci`, typecheck, frontend build,
unit tests, auth browser fixtures, and futures browser fixtures. CI retains
`AUTH_PROVIDER=FAKE`, `KCEX_READONLY_ENABLED=false`, and
`LIVE_TRADING=false`. Tests cover migration upgrade, attempt atomicity and
transitions, ambiguity and restart recovery, bounded confirmation and evidence
validation, idempotent risk accounting, entry blocking, reconcile API/event
schemas, Dashboard UNKNOWN state, and a static mutation-boundary scan.

The user's local machine is not used for install, build, typecheck, tests,
SQLite execution, Playwright, browser startup, or KCEX automation.
