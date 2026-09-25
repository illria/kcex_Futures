# Roadmap

## Global development rule

All automated validation runs in GitHub Actions.

The coding agent must not run install, build, typecheck, tests, Playwright, SQLite,
or KCEX automation on the user's machine unless the user explicitly changes this
policy.

Authenticated live-browser verification is tracked separately as deferred manual
verification.

## Completed foundation — TASK-001 through TASK-004

- local Dashboard and encrypted credential/session vault
- Fake Auth and OTP fixtures
- KCEX authentication adapter and fixture browser tests
- GPS_USDT read-only page state extractor
- `LIVE_TRADING=false` and fixture-only CI safety defaults

Real KCEX DOM, authenticated session, and account verification remain deferred.

## Phase 1 — TASK-005: Local SQLite Trading Persistence (complete)

- built-in Node.js `node:sqlite` storage
- versioned migrations and bounded repositories
- trade records, lifecycle event storage, daily plans, and audit events
- read-only history and storage health APIs
- no market snapshot time series or KCEX order execution

Exit criteria completed in GitHub Actions; TASK-005 was merged to main.

## Phase 2 — TASK-006: Paper Trading Lifecycle (review ready)

- deterministic lifecycle driven only by an explicit future upper-layer input
- paper-only positions and simulated outcomes
- lifecycle transitions persisted through TASK-005 repositories
- deterministic fixtures and restart/recovery coverage in CI
- no scheduler, auto trades, KCEX order mutation, or paper write HTTP API

Implementation and acceptance checks are complete in GitHub Actions for PR review;
TASK-006 remains unmerged and awaits final review.

No KCEX order submission or real position mutation.

## Phase 3 — TASK-007: RiskEngine + Kill Switch (planned)

- symbol whitelist and bounded margin/leverage rules
- open-position, daily-count, failure, and loss limits
- kill-switch behavior and pure rule tests
- unknown state fails closed

## Phase 4 — TASK-008: Assisted Single Live Order Flow (planned)

Only after explicit user approval and review of earlier tasks. This phase requires
a separate safety review and later manual verification. It is not part of TASK-005.

## Phase 5 — TASK-009: Position Confirmation + UNKNOWN State (planned)

- verify outcomes from explicit page evidence
- preserve UNKNOWN on uncertain outcomes
- block unsafe retries

## Phase 6 — TASK-010: TP/SL Management (planned)

- handle protection only after a position is confirmed
- distinguish price percentage from ROI percentage

## Phase 7 — TASK-011: Daily Scheduler (planned)

- create bounded daily plans with deterministic test clocks
- enforce spacing, position checks, and daily limits
- persist plan data with TASK-005 repositories

## Phase 8 — TASK-012: Long-Running Resilience (planned)

- auth-loss and stale-page detection
- selector drift diagnostics and controlled recovery
- heartbeat and structured audit logging

Every phase must pass its documented CI acceptance criteria before later work
begins.
