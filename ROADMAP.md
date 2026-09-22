# Roadmap

## Global development rule

All automated validation runs in GitHub Actions.

The coding agent must not run install, build, typecheck, tests, Playwright, or KCEX automation on the user's machine unless the user explicitly changes this policy.

Authenticated live-browser verification is tracked separately as deferred manual verification.

## Phase 0 — Bootstrap

- TypeScript project
- Playwright
- Vitest
- Zod
- Pino
- SQLite dependency
- lint/typecheck/test scripts
- GitHub Actions CI
- local runtime directories ignored by git

Exit criteria:
- GitHub Actions dependency install succeeds
- GitHub Actions typecheck succeeds
- GitHub Actions tests succeed
- no local development command was executed

## Phase 1 — Task 001: browser architecture + read-only KCEX detection

- implement persistent-browser launcher
- implement KCEX URL/navigation adapter
- implement login-state classifier
- implement GPS_USDT page classifier
- use fixture/mock DOM tests
- keep live trading OFF
- defer real authenticated browser verification

No trading interaction.

## Phase 2 — page state extraction

Read and normalize:

- current symbol
- visible mark/last price
- available balance
- leverage
- isolated/cross mode
- current position
- active orders

Build fixture-based selector diagnostics first. Real authenticated verification remains a separate user-approved step.

## Phase 3 — paper engine

- deterministic fake order lifecycle
- long/short paper positions
- simulated TP/SL
- persistence
- restart recovery
- at least 1000 lifecycle simulations in CI

## Phase 4 — risk engine

Rules:

- symbol whitelist
- max margin per trade
- max leverage
- max open positions
- max trades per day
- minimum interval
- max consecutive failures
- daily loss cap
- kill switch

All pure risk behavior must be exhaustively testable in CI.

## Phase 5 — one-shot assisted live order

Only after explicit user approval and after the earlier phases are reviewed.

- set isolated
- set leverage
- fill fixed margin
- choose side
- final re-read validation
- human confirmation
- submit once
- no retry on uncertain result

This phase inherently requires a later real-machine manual verification step; it is not executed by GitHub Actions.

## Phase 6 — position confirmation

- detect actual opened position
- record entry
- record quantity
- record side
- record status
- screenshot before and after
- UNKNOWN handling

## Phase 7 — TP/SL

Prefer KCEX-native TP/SL once a position is confirmed.

Must distinguish:
- price percentage
- ROI percentage

## Phase 8 — daily random scheduler

- choose random count in configured range
- choose random times
- enforce minimum spacing
- skip if an existing position is open
- persist daily plan
- regenerate next day

Scheduler logic must be CI-testable with deterministic seeded/controlled clocks where appropriate.

## Phase 9 — unattended hardening

- auth-loss detection
- popup handling
- stale-page detection
- selector drift diagnostics
- controlled restart
- heartbeat
- structured logging

## Phase 10 — optional local dashboard

Only after execution stability.

Possible views:
- current status
- today plan
- trade history
- position
- logs
- pause/resume
- live mode status
