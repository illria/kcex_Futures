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

## In Progress

### TASK-006 — Paper Trading Lifecycle

Status: IN PROGRESS

Spec: [docs/tasks/TASK-006.md](docs/tasks/TASK-006.md)

- deterministic explicit plan/open/mark/close Paper lifecycle
- atomic lifecycle events and restart recovery through TASK-005 storage
- read-only Paper state API, WebSocket state, and separate Dashboard panel
- no scheduler, KCEX mutation, or live trading

## Planned

### TASK-007 — RiskEngine + Kill Switch

### TASK-008 — Assisted Single Live Order Flow

### TASK-009 — Position Confirmation + UNKNOWN State

### TASK-010 — TP/SL Management

### TASK-011 — Daily Random Scheduler

### TASK-012 — Long-Running Resilience and Recovery
