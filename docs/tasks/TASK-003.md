# TASK-003 — KCEX Login + Email OTP Integration

## Objective

Connect the dashboard authentication state machine to Playwright KCEX login behavior.

This task adds real page automation logic, but all implementation testing remains mock/fixture-based in GitHub Actions until the user explicitly approves a later manual verification.

## Required flow

```
vault unlocked
  ↓
load/decrypt account + password
  ↓
open KCEX login page
  ↓
fill account/password
  ↓
submit login
  ↓
detect result
  ├── authenticated
  ├── email OTP required
  ├── captcha/manual challenge
  └── failed
```

If email OTP is required:

```
backend auth state = OTP_REQUIRED
        ↓
frontend shows OTP input
        ↓
user enters code
        ↓
POST /api/v1/auth/otp
        ↓
backend fills code into Playwright
        ↓
detect authenticated/failure
```

## OTP requirements

- never persist
- never log
- never echo back after submission
- clear from frontend immediately
- clear backend memory immediately after use
- timeout pending challenge

## Session persistence

Prefer encrypted Playwright storage state.

After successful authentication:

- export storage state
- encrypt it using the local vault key
- persist only encrypted state
- on next restart, require master key and attempt session restore
- if restore fails, return to credential login

## Failure behavior

Captcha or security challenge:

```
MANUAL_CHALLENGE
```

Do not bypass it.

Unknown page:

```
AUTH_UNKNOWN
```

Do not guess authenticated state.

## CI

Use static login-page fixtures/mocks only.

No real KCEX username, password, OTP, session or cookies in GitHub Actions.

## Deferred manual verification

Real KCEX login and OTP behavior are not considered CI blockers and must be marked DEFERRED until the user explicitly authorizes a local runtime test.
