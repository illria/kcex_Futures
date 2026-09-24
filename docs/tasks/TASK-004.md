# TASK-004 — KCEX Futures Read-Only State Extractor

Status: REVIEW READY

## Scope

Read the trusted `GPS_USDT` futures page through the already authenticated
KCEX adapter. The extractor may read explicit selectors for market prices,
available USDT, margin mode, leverage, current position, and open orders.

The feature flag `KCEX_READONLY_ENABLED` defaults to `false`. Polling is
single-flight, bounded to 2–60 seconds, and stops on session loss, challenge
pages, or a symbol mismatch. Missing or malformed numbers remain `null` and
are reported with field health instead of being guessed.

## Security boundary

The extractor receives a page only through `TrustedPageSource`, which checks
the exact official `https://www.kcex.com` host before and after each read. It
does not own a browser, receive credentials, read storage state, or call any
Playwright mutation method. There is no order, position, leverage, margin, or
TP/SL write path in TASK-004.

## Verification

Unit tests use static fixture HTML for normal, no-position, no-orders, partial,
malformed, wrong-symbol, session-lost, and challenge states. GitHub Actions
also runs Chromium fixtures behind a loopback-only network guard. Real KCEX
DOM, account, session, and login verification remain **DEFERRED MANUAL
VERIFICATION**.
