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

## Phase 2 — TASK-006: Paper Trading Lifecycle (complete)

- deterministic lifecycle driven only by an explicit future upper-layer input
- paper-only positions and simulated outcomes
- lifecycle transitions persisted through TASK-005 repositories
- deterministic fixtures and restart/recovery coverage in CI
- no scheduler, auto trades, KCEX order mutation, or paper write HTTP API

TASK-006 was merged to main at `def6cf52a8b8b2011f2392303a8e9666ff593595`
after its GitHub Actions acceptance checks passed.

No KCEX order submission or real position mutation.

## Phase 3 — TASK-007: RiskEngine + Kill Switch (complete)

- symbol whitelist and bounded margin/leverage rules
- open-position, daily-count, failure, and loss limits
- kill-switch behavior and pure rule tests
- unknown state fails closed

See [docs/tasks/TASK-007.md](docs/tasks/TASK-007.md) for limits, integration,
audit, API, Dashboard, and acceptance requirements. TASK-007 was merged at
`4aa21ad4242e5269fce31179012c9f9d8598ed6b`.

## Phase 4 — TASK-008: Assisted Single Live Order Flow (complete)

This phase builds only the authorization-gated fixture execution path: runtime
arm, immutable preview, explicit single confirmation, RiskEngine precheck,
single-flight execution, audit, and local Dashboard/WebSocket state. The default
provider is DISABLED; CI uses FIXTURE. Real KCEX mutation remains disabled,
pending platform authorization, deferred manual verification, and a separate
safety review. See [docs/tasks/TASK-008.md](docs/tasks/TASK-008.md).

TASK-008 was merged to main before the current TASK-009 branch. The fixture-only
path remains the only execution implementation; live KCEX mutation stays
disabled.

## Phase 5 — TASK-009: Position Confirmation + UNKNOWN State (complete)

- durably record SUBMITTING with its audit event before adapter invocation
- classify ambiguous adapter outcomes as UNKNOWN and block new entries
- bound fixture-only position confirmation and require symbol/side/size evidence
- provide manual read-only reconciliation without retrying submission
- recover interrupted attempts fail-closed on startup

See [docs/tasks/TASK-009.md](docs/tasks/TASK-009.md) for the acceptance criteria.

TASK-009 was merged to main at `02d761dd5bd3714921b23d75972aa40884f1d0d2`; its
post-merge GitHub Actions run passed.

## Phase 6 — TASK-010: TP/SL Management (complete)

- fixture-only protection lifecycle bound to the latest confirmed, OPEN position
- distinguish `PRICE_PCT` from fixture leveraged `ROI_PCT` approximation
- persist plans before fixture activation and recover ambiguous outcomes as UNKNOWN
- keep real KCEX protective-order mutations deferred

See [docs/tasks/TASK-010.md](docs/tasks/TASK-010.md) for the acceptance criteria.

## Phase 7 — TASK-011: Daily Random Scheduler (in progress)

- create immutable UTC daily plans with deterministic injected random sources
- enforce a five-minute grid, at least thirty-minute spacing, and a fifteen-minute grace window
- persist daily headers, slots, and audit records atomically in SQLite schema v4
- track only manual fixture-confirmed entries; a due slot never submits an order
- expose read-only scheduler state through HTTP, WebSocket, and the Dashboard

## Phase 8 — TASK-012: Long-Running Resilience (planned)

- auth-loss and stale-page detection
- selector drift diagnostics and controlled recovery
- heartbeat and structured audit logging

Every phase must pass its documented CI acceptance criteria before later work
begins.
