# KCEX Read-Only Verification

## Purpose

The verification stage confirms real page evidence and contract semantics before the KCEX writer can be enabled. It is read-only: it must not click a Long/Short submit control, change leverage or margin mode, create protection, or send any order.

The coding agent does not perform this stage. It remains deferred until the code PR is reviewed and the user explicitly authorizes the local manual verification checkpoint.

## Procedure

1. Start with `LIVE_TRADING=false`, `AUTH_PROVIDER=KCEX`, and `KCEX_READONLY_ENABLED=true`.
2. Unlock the local Vault, then choose Password/Email OTP or `Continue with Google`. Complete Google password, 2FA, and challenges yourself in the browser.
3. Confirm the trusted KCEX origin and the live Dashboard's GPS_USDT, market, balance, contract, position, and order evidence. The reader reports UNKNOWN or stops when evidence is insufficient.
4. Review actual control IDs and semantics without submitting an order or changing position settings. Record only stable selector IDs/control types and verified numeric contract metadata.
5. In `KCEX Verification Mode`, save the strict local report. A PASS report requires every required check, every trading selector, the trusted host, and the contract profile to be verified, plus the exact phrase `CONFIRM KCEX READ-ONLY VERIFICATION`.
6. Confirm the report is present only at the ignored local path `data/kcex-verification-report.json`. Do not copy it into Git, attach it to an issue, or send it elsewhere.

## Report restrictions

Allowed: fixed check names/statuses, stable selector IDs, control semantics enums, symbol/unit/step/precision/tick/contract-size and bounded numeric limits, and verification timestamps.

Forbidden: account/email, password, OTP, Google credentials, cookies, tokens, authorization headers, storage state/session data, HTML, screenshots, full DOM, or full page text. The API schema is strict and local; invalid bodies return a generic error and are not logged.

## After verification

A passing read-only report does not authorize a trade. Keep `LIVE_TRADING=false` until a separately reviewed user-started Canary checkpoint. A Canary is one attempt, is not scheduled, and cannot be retried. Only a confirmed entry, confirmed protection, and passing UNKNOWN-handling check can set Canary PASS and unblock Auto Live. Any ambiguous state requires manual reconciliation.
