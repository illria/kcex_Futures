# Roadmap

## Phase 0 — Bootstrap

- TypeScript project
- Playwright
- Vitest
- Zod
- Pino
- SQLite dependency
- lint/typecheck/test scripts
- local directories ignored by git

Exit criteria:
- install succeeds
- typecheck succeeds
- tests succeed
- project starts without placing orders

## Phase 1 — Task 001: browser + read-only KCEX session

- launch persistent browser
- reuse local user-data directory
- open KCEX
- detect whether login is active
- navigate to GPS_USDT futures page
- print read-only status
- capture diagnostic screenshot on failure

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

Add selector diagnostics.

## Phase 3 — paper engine

- deterministic fake order lifecycle
- long/short paper positions
- simulated TP/SL
- persistence
- restart recovery
- at least 1000 lifecycle simulations

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

## Phase 5 — one-shot assisted live order

Only after manual approval.

- set isolated
- set leverage
- fill fixed margin
- choose side
- final re-read validation
- human confirmation
- submit once
- no retry on uncertain result

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
