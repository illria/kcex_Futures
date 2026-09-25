# TASK-005 — Local SQLite Trading Persistence

Status: IN PROGRESS

## Objective

Provide a local, versioned SQLite persistence layer for records supplied by
future application services. TASK-005 stores and reads records; it does not
create trades, simulate trades, or execute orders.

## Scope

- Node.js built-in `node:sqlite` (`DatabaseSync`), with no SQLite ORM or native
  package dependency.
- Default database: `data/trading.sqlite3`; `TRADING_DB_FILE` may override it.
- Best-effort `0700` database directory and `0600` database file permissions.
- Startup PRAGMAs, schema migrations, repositories, transactions, and idempotent
  database close.
- Durable trade records, append-only trade lifecycle events, daily plan records,
  and runtime audit events.
- Read-only Dashboard trade history and storage health APIs.
- GitHub Actions Node 22 is the only test/build/typecheck environment.

## SQLite schema

Schema version 1 is applied through ordered, one-time migrations recorded in
`schema_migrations(version, name, applied_at)`. Each migration and its history
row commit in one transaction. A failed migration rolls back. Gaps, duplicate
or mismatched migration history are rejected. A database version newer than
the application raises `DATABASE_SCHEMA_TOO_NEW`; no downgrade or destructive
migration is attempted.

Migration 001 creates:

- `trades`: UUID business id, symbol, mode, side, finite lifecycle status,
  nullable numeric lifecycle fields, UTC timestamps, and optimistic `version`.
- `trade_events`: UUID id, optional foreign key to `trades`, event type/time,
  and validated safe JSON payload. Repository writes are append-only.
- `daily_plans`: one validated `GPS_USDT` plan per date, target 1–10, completed
  count bounded by target, margin, leverage, and UTC timestamps.
- `audit_events`: category, event type, severity, message, safe JSON payload,
  and UTC timestamp.

The migration adds indexes for trade creation time/status, events by trade/time,
daily plan date, and audit creation time. Database CHECK constraints backstop
enum and numeric validation. SQLite uses foreign keys, WAL where supported,
`synchronous=NORMAL`, and a 5000 ms busy timeout. `:memory:` tests may report
SQLite's memory journal mode instead of WAL.

No migration may drop a table/column or delete trade records. Database files
and SQLite sidecars are ignored by Git. The database is local durable state;
there is no cloud backup or artifact upload.

## Repository API

- `TradeRepository`: create, get, bounded list (default 50, maximum 100), finite
  field update with expected version, append/list trade events, and
  `recordTradeTransition()` for atomic update plus event append.
- `DailyPlanRepository`: validate/upsert, get by date, and bounded list.
- `AuditRepository`: append validated audit events and bounded list.
- `StorageService`: initialize/close, schema health, repository access, and
  recent trade history DTOs.

All database values use prepared statements. There is no raw SQL API for
business services and no trade deletion API. Trade identifiers use
`crypto.randomUUID()`. Duplicate ids raise an explicit error. Optimistic updates
increment the record version and return a conflict when the expected version
is stale. A transition rolls back both the trade update and event append if
either operation fails.

Write input is Zod-validated before SQL. Every row is parsed again when read;
invalid database rows raise `StorageDataIntegrityError` and are not exposed to
the Dashboard.

## Sensitive data exclusions

Audit/trade event payloads recursively reject sensitive key names, including
password/pass, OTP/code, cookie, token, authorization, auth, session,
storageState, masterKey, secret, credential, account, email, and headers,
case-insensitively. Payload values must be bounded JSON data with finite numbers.

SQLite must never store KCEX credentials, OTP, cookies, tokens, account/session
data, browser profiles/storage state, auth secrets, or futures/market snapshots.
Those secrets remain owned by the encrypted credential vault and encrypted
session store. No live-arm or `LIVE_TRADING` enablement value is persisted.

## Dashboard and HTTP APIs

- `GET /api/v1/history/trades?limit=50` returns at most 100 validated history
  DTOs in deterministic newest-first order (`created_at DESC, id DESC`).
- `GET /api/v1/storage/health` returns only `READY|DEGRADED` and schema version;
  it never returns a file path, SQL, credentials, or account data.
- `GET /api/v1/dashboard/snapshot` includes the latest 50 stored history rows,
  `status.storage`, and an empty history plus a safe degraded log if a runtime
  storage read fails.
- Dashboard history shows Time, Mode, Side, Status, Entry, Exit, PnL, and Fees.
  Empty storage displays `No trade history.` Fake snapshots keep `history: []`.

History reads use a bound `LIMIT` and never perform an unbounded table scan.
Invalid limits, including 0, values above 100, non-numeric input, and repeated
query parameters, return HTTP 400. No HTTP write endpoint for trades is added.

The server initializes the database and migrations before listening. Any startup
failure is fail-closed and logs only a safe initialization error code/message,
never a full database path, SQL parameters, or table contents. On shutdown,
services stop before the database closes.

## Out of scope

- TASK-006 Paper Trading Lifecycle and any automatic or simulated trade.
- Trade generation from market data, scheduler execution, direction selection,
  TP/SL, PnL simulation, or trade execution state machines.
- Real KCEX requests, credentials, session data, order placement/cancellation,
  position changes, leverage/margin changes, or any Playwright interaction.
- Persisted live-arm state, cloud backup, upload, or market snapshot time series.

`LIVE_TRADING=false` remains enforced. `KCEX_READONLY_ENABLED=false` remains the
default.

## CI requirements and acceptance criteria

GitHub Actions must run `npm ci`, backend/frontend typecheck, frontend build,
unit tests, auth browser fixtures, and futures browser fixtures on Node 22.
SQLite tests use `:memory:` or isolated temporary directories, never
`data/trading.sqlite3`; they clean up `.sqlite3`, `-wal`, and `-shm` files.

Acceptance requires migration/version/rollback/too-new coverage; trade create,
get, list, update, optimistic conflict, duplicate-id and invalid-value tests;
transaction success/rollback tests; nested sensitive-key rejection; temporary
file close/reopen persistence; empty and seeded Dashboard history ordering;
read-only history pagination/validation and storage health API tests; and CI
confirmation that `LIVE_TRADING=false` with no KCEX credentials, session, or
order execution.

Only after code is pushed and all GitHub Actions checks pass may this task be
marked `REVIEW READY`. Do not mark it `COMPLETE` before final review/merge.
