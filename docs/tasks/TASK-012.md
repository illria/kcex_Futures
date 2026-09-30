# TASK-012 — Long-Running Resilience and Recovery

Status: COMPLETE

## Scope

Add a bounded, read-only runtime observer for the authenticated browser, futures read pipeline, local storage, and process heartbeat. The observer reports `IDLE`, `HEALTHY`, `DEGRADED`, `MANUAL_ACTION`, or `HALTED` with a small set of reason codes.

The service uses an injectable clock, a five-second unref'ed observation timer, single-flight recovery checks, and a one-second recovery cooldown. It never logs or persists raw page content, page URLs, cookies, sessions, credentials, tokens, or authentication input. Resilience audit transitions use the existing schema v4 storage layout; no database migration or schema version change is part of this task.

## State and recovery behavior

- `IDLE` is used for the FAKE provider and when `KCEX_READONLY_ENABLED=false`.
- `HEALTHY` requires authenticated state, a connected browser on a trusted page, and a fresh READY or PARTIAL financial snapshot.
- `DEGRADED` reports temporary unknown reads, bounded read failures, `AUTH_UNKNOWN`, or stale state.
- `MANUAL_ACTION` reports session loss, OTP requirements, security challenges, or selector drift suspicion.
- `HALTED` reports browser disconnection, a closed or unavailable page, untrusted host, symbol integrity mismatch, or degraded persistent storage.
- Session loss clears the encrypted session but preserves saved credentials. Challenges stop polling and require user action. Unknown state never starts a credential flow.
- Recovery checks only inspect current state. They do not navigate, relaunch a browser, fill inputs, submit OTP, bypass a challenge, retry login, or perform KCEX mutation.

## Read diagnostics

The KCEX read adapter returns structured booleans for symbol, market, account, contract, position, and open-order evidence, plus a bounded list of missing selector field keys. Empty-position and empty-open-order markers count as valid evidence. Diagnostics never contain DOM text or HTML.

Selector drift is only suspected after three consecutive authenticated, trusted, challenge-free observations with the same missing required selector evidence. The reader stops at that threshold. The service never confirms a new selector or edits one automatically. Recovery requires a user-triggered existing session check and a later valid read.

Financial freshness uses `max(15 seconds, poll interval × 3)`, so a configured 60-second polling interval is not marked stale between normal reads. Browser stop, unknown read health, and storage failure remain fail-closed.

## Protocol and UI

- `GET /api/v1/resilience/state` exposes the shared `ResilienceStateSchema`.
- `resilience.state` carries the same shared schema over `/api/v1/events`.
- `system.heartbeat` remains process status `OK` and also includes `resilienceStatus`, `liveTrading=false`, and uptime. The Dashboard separately marks heartbeat stale after 45 seconds without an event.
- The Dashboard shows auth, browser, read, failure, selector, storage, and heartbeat state. It displays `SESSION LOST — MANUAL LOGIN REQUIRED`, `SECURITY CHALLENGE — MANUAL ACTION REQUIRED`, and `SELECTOR DRIFT SUSPECTED — MANUAL DOM REVIEW REQUIRED` when applicable, plus the permanent warnings `NO AUTOMATIC LOGIN`, `NO CAPTCHA BYPASS`, and `NO AUTOMATIC KCEX ORDER RECOVERY`.
- There is no resilience recovery write endpoint. Scheduler eligibility is blocked with `RUNTIME_UNHEALTHY` for `MANUAL_ACTION` and `HALTED`; existing due times and lifecycle records are not shifted or regenerated.

## Safety boundary

- `LIVE_TRADING=false`, `AUTH_PROVIDER=FAKE`, `KCEX_READONLY_ENABLED=false`, and `LIVE_EXECUTION_PROVIDER=FIXTURE` remain the CI defaults.
- No real KCEX request, real account/session/OTP, order, position mutation, leverage or margin change, TP/SL mutation, CAPTCHA bypass, or TASK-013 work is included.
- Live KCEX DOM and selector verification is **DEFERRED MANUAL VERIFICATION**.
- Schema version remains 4. No migration is added.

## Validation

All install, typecheck, build, unit, auth-browser fixture, and futures-browser fixture checks run only in GitHub Actions. No local npm, Node, SQLite, Playwright, or browser command may be run for this task.

Acceptance coverage includes state transitions, fake/disabled IDLE, auth signal propagation, encrypted-session cleanup, safe browser inspection, long-poll freshness, 1/2/3 selector evidence observations and recovery, privacy and audit deduplication, scheduler blocking without due-time changes, heartbeat staleness, read-only HTTP/WebSocket protocol, Dashboard banners, schema version 4, CI safety defaults, and static checks for prohibited recovery or mutation calls.
