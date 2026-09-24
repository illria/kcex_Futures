# Tasks

## Completed

### TASK-001 — KCEX Playwright Bootstrap & Read-Only Browser Session

Status: COMPLETE

Spec: [docs/tasks/TASK-001.md](docs/tasks/TASK-001.md)

Do not work on real order submission yet.

### TASK-002 — Local Dashboard + Encrypted Credential Vault

Status: COMPLETE

Spec: [docs/tasks/TASK-002.md](docs/tasks/TASK-002.md)

Build:

- local web UI on 127.0.0.1:6666
- vault unlock flow
- encrypted KCEX account/password storage
- fake auth state machine
- fake email OTP flow
- realtime WebSocket dashboard shell

No real KCEX login yet.

## In Progress

### TASK-002.1 — Pre-TASK-003 Security Hardening

Status: COMPLETE

Harden credential plaintext lifetime, credential deletion UI, master-key validation,
dynamic loopback WebSocket CSP, API validation responses, and secret redaction before TASK-003.

## Next

### TASK-003 — KCEX Login + Email OTP Integration

Status: IN PROGRESS

Spec: [docs/tasks/TASK-003.md](docs/tasks/TASK-003.md)

Connect Playwright login to:

- encrypted account/password
- email verification-code UI
- encrypted session restore
- auth/session realtime status

Real local browser verification remains deferred until explicitly approved.

## Planned

- TASK-004 — KCEX Futures read-only state extractor
- TASK-005 — local SQLite trading persistence
- TASK-006 — paper trading lifecycle
- TASK-007 — RiskEngine + kill switch
- TASK-008 — assisted single live order flow
- TASK-009 — position confirmation + UNKNOWN state
- TASK-010 — TP/SL management
- TASK-011 — daily random scheduler
- TASK-012 — long-running resilience and recovery
