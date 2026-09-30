# TASK-011 — Daily Random Scheduler

Status: REVIEW READY

## Scope

Create one immutable daily schedule per UTC date. Each plan contains 1–10 GPS_USDT slots with independently random LONG/SHORT directions, margin 50 USDT, and leverage 10x. Times use the 5-minute UTC grid and every adjacent slot is at least 30 minutes apart. Production randomness uses `node:crypto.randomInt`; tests inject a deterministic `RandomSource`.

The scheduler plans, marks slots DUE or MISSED, and tracks an entry only when it matches a manually confirmed fixture execution attempt. A match requires CONFIRMED status, GPS_USDT, the planned side, and `confirmedAt` inside the inclusive 15-minute grace window. A single attempt cannot complete more than one slot. Ambiguous matching fails closed.

## Durable behavior

- SQLite schema v4 appends `scheduler_slots`; migrations 1–3 remain unchanged.
- Daily header, all slots, and `SCHEDULER_DAILY_PLAN_CREATED` audit are inserted in one transaction.
- Existing dates are read as stored and never randomized again or overwritten.
- Recovery reconciles unbound, same-symbol/same-side confirmations from the inclusive slot window before expiry. A valid durable confirmation completes a `SCHEDULED` or `DUE` slot even when the next tick arrives after the grace period. No match expires the slot; multiple matches preserve it in `DEGRADED` for review.
- Completing a slot, binding its attempt, updating `daily_plans.completed`, and writing the audit event are atomic.
- UTC date rollover marks unfinished prior-day slots MISSED with `DAY_ROLLOVER` and creates the new day's plan. History is retained.
- Slots past `dueAt + 15 minutes` become MISSED. Startup does not catch up, shift, stack, or force-close positions.

## Runtime and blockers

Runtime statuses are READY, DUE, BLOCKED, COMPLETE, and DEGRADED. One DUE slot maximum is enforced. OPEN or UNKNOWN position state, unresolved execution, PLANNED/ACTIVE/UNKNOWN protection, or an ENGAGED/UNKNOWN Kill Switch blocks entry eligibility. Degraded storage prevents plan creation and transitions. These are informational planning gates; RiskEngine pretrade evaluation remains in the existing manual execution path.

The shared `SchedulerStateSchema` is the protocol for the Dashboard snapshot and `scheduler.plan` WebSocket event. `GET /api/v1/scheduler/state` is read-only. There are no scheduler write endpoints. The Dashboard shows UTC date, target, completed/missed/remaining, next slot, due side/window, fixed parameters, and blockers.

## Safety boundary

Dashboard text: `SCHEDULE ONLY — NO AUTOMATIC ORDER SUBMISSION` and `LIVE_TRADING=false`.

Scheduler code has no browser, KCEX, network, or execution adapter dependency. It never arms, previews, confirms, submits, activates protection, places or cancels orders, closes positions, shifts later slots, or catches up missed work. Real KCEX order, TP/SL, and close mutations remain disabled.

## Validation

All installation, typecheck, build, unit, auth-browser fixture, and futures-browser fixture validation runs only in GitHub Actions. Local development/test commands and local SQLite or Playwright execution are prohibited.

## Acceptance coverage

- UTC date keys, target boundaries, random directions, five-minute grid, bounded partial Fisher–Yates sampling, and minimum spacing.
- v3 to v4 migration preserving trades, execution attempts, and protection plans.
- Atomic creation/completion, duplicate attempt rejection, immutable restart recovery, late startup, grace boundaries, rollover, and no catch-up.
- Matching, wrong-side, out-of-window, ambiguous execution evidence, position/execution/protection/Kill Switch blockers, and storage degradation.
- Read-only HTTP and WebSocket state, Dashboard rendering, and static scheduler safety checks.
