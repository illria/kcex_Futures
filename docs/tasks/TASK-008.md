# TASK-008 — Assisted Single Live Order Flow

Status: COMPLETE

Subtitle: Authorization-gated fixture execution architecture

## Objective and boundary

Build a local assisted single-submission path with a runtime-only arm,
immutable preview, explicit second confirmation, authoritative RiskEngine
precheck, single-flight execution state, and audit / Dashboard / WebSocket
visibility.

This implementation is fixture-only. `LIVE_EXECUTION_PROVIDER` supports only
`DISABLED` and `FIXTURE`, defaults to `DISABLED`, and is set to `FIXTURE` only
inside GitHub Actions. No code in this task submits a real KCEX order or mutates
an exchange account. Real KCEX mutation remains **DEFERRED** pending required
platform authorization and manual verification.

`LIVE_TRADING` remains permanently `false`. It is not an execution-enabling
configuration flag. A runtime arm is local operator intent and is not KCEX
platform authorization.

## Scope

- Dedicated modules under `apps/server/src/execution/` for arm, adapter,
  fixture adapter, disabled KCEX extension point, position source, errors, and
  assisted service.
- Shared schemas and event payloads under `packages/shared/src/execution.ts`.
- Fixed `LIVE / GPS_USDT / MARKET / ISOLATED` intent with explicit LONG or
  SHORT choice, margin at most 50 USDT, and leverage at most 10x. Inputs are
  rejected when outside ceilings; they are not clamped.
- Preview is immutable, single-active, valid for 60 seconds, and contains the
  intent, provider, timestamps, and optional reference price. Reference price
  is informational and is not a guaranteed fill price.
- Preview token is random, single-use, held only in memory, returned only by
  the preview HTTP response, and excluded from audit, logs, and WebSocket.
- Runtime arm requires the exact acknowledgement phrase, expires after five
  minutes, is consumed before precheck, and is never persisted. A process
  restart begins DISARMED with no pending preview or token.
- Confirm rechecks storage, Kill Switch, configured limits, and the explicitly
  injected fixture position source through RiskService immediately before the
  adapter. OPEN blocks and UNKNOWN halts. A denied precheck never calls the
  adapter and is not counted as an execution failure.
- One in-flight confirmation and one adapter attempt maximum. There is no
  automatic retry. Explicit validated `NOT_SUBMITTED` may become FAILED;
  ambiguous outcomes and position confirmation are extended by TASK-009.
- Fixture submissions do not create LIVE trade rows. TASK-008 itself introduced
  no database migration; TASK-009 appends schema v2 for durable attempts.
- `DisabledKcexExecutionAdapter` fails with
  `KCEX_LIVE_EXECUTION_DEFERRED`; it has no browser, selector, or mutation
  behavior. `KCEX` is not a supported provider configuration.
- Dashboard uses explicit Arm, Disarm, Preview, and Confirm actions and shows
  `REAL KCEX EXECUTION DISABLED` / `FIXTURE SUBMISSION ONLY · NO KCEX ORDER`.
- `execution.state` and `execution.submitted` use shared protocol schemas.
  TASK-009 adds shared confirming, confirmed, and unknown events; no event
  contains a confirmation token.

## State machine

```text
DISARMED
  -> ARMED
  -> PREVIEW_READY
  -> AWAITING_CONFIRMATION
  -> PRECHECK
  -> SUBMITTING
  -> SUBMITTED

Precheck denial -> BLOCKED or HALTED
Explicit NOT_SUBMITTED -> FAILED
Uncertain adapter result -> UNKNOWN (TASK-009)
Safety or storage failure -> HALTED
```

`SUBMITTED` means the fixture adapter accepted one submission action. It does
not mean an order filled, an exchange confirmed the request, or a position
opened. Position/fill confirmation, exchange reconciliation, and UNKNOWN
outcomes are handled by [TASK-009](TASK-009.md), with fixture evidence only.

## Local API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/v1/live/state` | Return validated runtime execution state |
| POST | `/api/v1/live/arm` | Require exact human acknowledgement and same-origin request |
| POST | `/api/v1/live/disarm` | Disarm and invalidate preview state |
| POST | `/api/v1/live/preview` | Validate intent and return immutable preview plus one-time token |
| POST | `/api/v1/live/confirm` | Accept only preview ID and one-time token; precheck then one adapter attempt |

All API requests remain loopback-only. Live write routes require a matching
Origin and strict bounded JSON schemas. There are no KCEX order, submit, or
cancel endpoints.

## Explicitly excluded

- Real KCEX requests, credentials, login, order submit/cancel, or mutation UI
- Leverage or margin-mode changes, quantity assumptions, TP/SL, liquidation
- CAPTCHA, anti-bot, or security-challenge bypass
- Automatic retry, position inference, fill confirmation, or reconciliation
- Scheduler, random side selection, automatic open/close, or new TASK-009 work

Before any future KCEX write adapter, require platform authorization where
applicable, authenticated manual page verification, verified contract sizing,
verified isolated/leverage controls, and a separate safety review. Those checks
are not represented as complete by this task.

## CI acceptance

GitHub Actions only: `npm ci`, typecheck, frontend build, unit tests, auth
browser fixtures, and futures browser fixtures. CI uses `AUTH_PROVIDER=FAKE`,
`LIVE_TRADING=false`, `KCEX_READONLY_ENABLED=false`, and
`LIVE_EXECUTION_PROVIDER=FIXTURE`; all browser fixtures remain loopback-only.

Tests cover arm/expiry/single-shot behavior, preview immutability/limits/expiry,
confirmation token and concurrency rejection, RiskEngine position/limit/Kill
Switch/storage decisions, single fixture success and failure/timeout, restart
DISARMED state, API same-origin/body validation, WebSocket state, Dashboard
warning/rendering, provider configuration, and a static execution-package
mutation-boundary scan.

The user machine is not used for install, build, typecheck, unit test, SQLite,
Playwright, browser startup, or KCEX automation. Real KCEX login/session and
live GPS_USDT DOM checks remain **DEFERRED MANUAL VERIFICATION**.
