# Tasks

## Completed

### TASK-001 — KCEX Playwright Bootstrap & Read-Only Browser Session

Status: COMPLETE

Spec: [docs/tasks/TASK-001.md](docs/tasks/TASK-001.md)

### TASK-002 — Local Dashboard + Encrypted Credential Vault

Status: COMPLETE

Spec: [docs/tasks/TASK-002.md](docs/tasks/TASK-002.md)

### TASK-002.1 — Pre-TASK-003 Security Hardening

Status: COMPLETE

### TASK-003 — KCEX Login + Email OTP Integration

Status: COMPLETE

Spec: [docs/tasks/TASK-003.md](docs/tasks/TASK-003.md)

Real local browser verification remains deferred until explicitly approved.

### TASK-004 — KCEX Futures Read-Only State Extractor

Status: COMPLETE

Spec: [docs/tasks/TASK-004.md](docs/tasks/TASK-004.md)

- trusted authenticated page source shared with the KCEX adapter
- explicit read-only market, account, contract, position, and open-order snapshots
- strict numeric parsing with null for missing or malformed evidence
- fixture-only WebSocket and browser validation; no write-capable path

### TASK-005 — Local SQLite Trading Persistence

Status: COMPLETE

Spec: [docs/tasks/TASK-005.md](docs/tasks/TASK-005.md)

- versioned local SQLite schema and repositories for trades, daily plans, and audit events
- read-only trade history and storage health APIs
- persisted Dashboard history with no fabricated records
- no scheduler, KCEX mutation, or live trading

### TASK-006 — Paper Trading Lifecycle

Status: COMPLETE

Spec: [docs/tasks/TASK-006.md](docs/tasks/TASK-006.md)

- deterministic explicit plan/open/mark/close Paper lifecycle
- atomic lifecycle events and restart recovery through TASK-005 storage
- read-only Paper state API, WebSocket state, and separate Dashboard panel
- merged to main; no scheduler, KCEX mutation, or live trading

### TASK-007 — RiskEngine + Kill Switch

Status: COMPLETE

Spec: [docs/tasks/TASK-007.md](docs/tasks/TASK-007.md)

TASK-007 merge commit: `4aa21ad4242e5269fce31179012c9f9d8598ed6b`.

### TASK-008 — Assisted Single Live Order Flow

Status: COMPLETE

Spec: [docs/tasks/TASK-008.md](docs/tasks/TASK-008.md)

Merged to main before TASK-009. Real KCEX order mutation remains disabled.

### TASK-009 — Position Confirmation + UNKNOWN State

Status: COMPLETE

Spec: [docs/tasks/TASK-009.md](docs/tasks/TASK-009.md)

Merged to main at `02d761dd5bd3714921b23d75972aa40884f1d0d2`; post-merge GitHub Actions passed.

## Completed

### TASK-010 — TP/SL Management

Status: COMPLETE

Spec: [docs/tasks/TASK-010.md](docs/tasks/TASK-010.md)

Fixture protection only. Real KCEX protective-order mutation remains deferred.

## Completed

### TASK-011 — Daily Random Scheduler

Status: COMPLETE

Spec: [docs/tasks/TASK-011.md](docs/tasks/TASK-011.md)

Scheduler plans and tracks UTC slots only. It does not automatically arm,
preview, confirm, submit, or manage positions.

## Review Ready

### TASK-012 — Long-Running Resilience and Recovery

Status: REVIEW READY

Spec: [docs/tasks/TASK-012.md](docs/tasks/TASK-012.md)
