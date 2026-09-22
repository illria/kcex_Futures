# TASK-002 — Local Dashboard + Encrypted Credential Vault

## Objective

Implement the local dashboard foundation and secure credential vault without connecting to a real KCEX account.

Default dashboard:

```
http://127.0.0.1:6666
```

All automated validation runs in GitHub Actions only.

## Scope

Implement:

- React + TypeScript frontend
- local TypeScript backend
- WebSocket event channel
- vault lock/unlock state
- encrypted KCEX account/password storage
- credential save/update/delete
- secret redaction
- fake auth adapter for UI development
- fake `OTP_REQUIRED` flow
- dashboard shell with placeholder trading data

Do not implement real KCEX login in this task.

## Security requirements

- master key is never persisted
- account/password are never stored plaintext
- password is never returned to frontend after save
- OTP is never persisted
- logs redact auth secrets
- bind to `127.0.0.1` by default
- LIVE_TRADING is always false

## UI states

At minimum:

- APP_LOCKED
- VAULT_UNLOCKED
- CREDENTIALS_REQUIRED
- LOGGING_IN
- OTP_REQUIRED
- AUTHENTICATED (fake adapter only)
- AUTH_FAILED

## Dashboard placeholders

Show cards for:

- KCEX connection
- GPS_USDT price
- available USDT
- leverage
- margin mode
- current position
- unrealized PnL
- today's trade target
- completed trades
- next planned trade
- runtime logs

Values may be mock/fixture data in this task.

## CI requirements

GitHub Actions must run:

- dependency install
- backend typecheck
- frontend typecheck/build
- unit tests

Tests must cover:

- encrypt/decrypt round-trip with fake credentials
- wrong key cannot decrypt
- password absent from persisted plaintext
- log redaction
- OTP not persisted
- auth state transitions
- WebSocket event schema validation
- dashboard can render fake snapshot

## Local-machine restriction

The coding agent must not run the app, install dependencies, launch a browser, or execute tests on the user's machine.

## Acceptance

CI green, no real credentials, no KCEX login, no trading interaction.
