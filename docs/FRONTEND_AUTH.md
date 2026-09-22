# Local Dashboard & Authentication Design

## Purpose

The final application should have a local real-time web UI instead of relying only on CLI interaction.

Default bind:

```
http://127.0.0.1:6666
```

The port must be configurable, but the service should bind to loopback by default and must not expose the dashboard to the LAN unless the user explicitly changes that setting.

The UI serves two purposes:

1. secure KCEX login / email verification workflow
2. real-time trading status, positions, schedules, PnL and logs

## Authentication inputs

The local UI should support:

- Local master key / unlock key
- KCEX account (email or supported login identifier)
- KCEX password
- Email verification code when KCEX requests one

These values have different storage rules.

### Local master key

The master key is used to unlock locally encrypted secrets.

Rules:

- never store the master key itself
- never commit it
- never print it
- never send it to GitHub Actions
- hold it in process memory only for the current runtime
- require re-entry after restart

Recommended derivation/encryption:

```
master key
   ↓
Argon2id or scrypt KDF
   ↓
256-bit encryption key
   ↓
AES-256-GCM encrypted vault
```

The encrypted vault may contain the KCEX account and password.

### KCEX account and password

The user may choose to save them locally.

If saved:

- encrypt at rest
- never store plaintext in SQLite, JSON, logs or screenshots
- decrypt only in backend memory when a login attempt is required
- never return the stored password to the frontend after save
- UI should show only a masked state such as `•••••••• / saved`

If the user does not enable "save credentials", keep them memory-only for the current runtime.

### Email verification code

Email OTP is always transient.

Rules:

- frontend input is shown only when backend state is `OTP_REQUIRED`
- never persist the OTP
- never include OTP in logs
- never store OTP in browser localStorage/sessionStorage
- clear the input after submission
- clear backend memory immediately after KCEX accepts/rejects it
- expire the pending OTP state after a short timeout

## Login state machine

```
APP_LOCKED
  ↓ enter master key
VAULT_UNLOCKED
  ↓
SESSION_CHECK
  ├── valid session ──────────────→ AUTHENTICATED
  └── invalid/no session
            ↓
       CREDENTIALS_REQUIRED
            ↓
         LOGGING_IN
            ├── no verification ─→ AUTHENTICATED
            ├── email code ─────→ OTP_REQUIRED
            ├── captcha ────────→ MANUAL_CHALLENGE
            └── failure ────────→ AUTH_FAILED

OTP_REQUIRED
  ↓ user enters code in local UI
SUBMITTING_OTP
  ├── success ──────────────────→ AUTHENTICATED
  └── failure ──────────────────→ OTP_REQUIRED / AUTH_FAILED

AUTHENTICATED
  ↓ session expires
SESSION_LOST
  ↓
SESSION_CHECK
```

Captcha / anti-bot challenges must never be bypassed automatically.

## Session persistence

Prefer encrypted Playwright storage state over an unprotected plaintext browser profile when practical.

Suggested flow:

1. after successful login, obtain Playwright storage state
2. serialize the state
3. encrypt it with the same local vault key
4. store only encrypted bytes locally
5. on restart, ask for the master key
6. decrypt storage state in memory
7. initialize browser context from the decrypted object
8. if the state is rejected by KCEX, fall back to the normal login flow

If KCEX later proves to require browser state that storageState cannot preserve, a persistent profile may be introduced, but it must be documented as sensitive local data and never committed or uploaded.

## Local web architecture

Recommended:

```
Browser
  React + TypeScript UI
        │
        │ HTTP
        │ WebSocket
        ▼
Local Backend
  Fastify + TypeScript
        │
        ├── AuthService
        ├── KcexBrowserService
        ├── MarketStateService
        ├── TradingEngine
        ├── RiskEngine
        ├── Scheduler
        ├── SQLite
        └── EventBus
                │
                ▼
          Playwright / KCEX
```

The frontend must never talk directly to KCEX or receive decrypted credentials.

## Real-time transport

Use WebSocket for runtime events.

Examples:

```
auth.state
market.snapshot
account.balance
position.changed
order.changed
scheduler.plan
trade.opened
trade.closed
risk.blocked
system.log
system.heartbeat
```

All WebSocket payloads should have a versioned schema and be validated.

## Main UI layout

### Top status bar

Always visible:

- KCEX: Connected / Login Required / OTP Required / Session Lost
- Browser: Running / Stopped
- Mode: PAPER / LIVE
- Trading: Running / Paused / Halted
- Kill Switch: Normal / Active
- current time

LIVE must be visually unmistakable.

## Login / Vault panel

When locked:

```
Local unlock key
[****************]

[ Unlock ]
```

When credentials are missing:

```
KCEX account
[________________]

KCEX password
[****************]

[ ] Save encrypted credentials locally

[ Login ]
```

When verification is required:

```
KCEX requires email verification

Verification code
[ ______ ]

[ Submit code ]
```

Do not show trading controls until authentication is complete.

## Trading dashboard

Initial GPS_USDT view should show:

### Market

- Symbol: GPS_USDT
- Last price
- Mark price when available
- page/data freshness
- connection state

### Account

- available USDT
- margin mode
- current leverage
- current GPS position
- side
- entry price
- position size
- unrealized PnL

### Automation

- desired daily trade range: 1–10
- today's generated target
- completed trades today
- next planned time
- fixed margin: 50 USDT
- leverage: 10x
- direction mode
- TP / SL settings
- running / paused

### Current position

A dedicated high-visibility card when a position exists.

### History

Table:

- time
- side
- margin
- leverage
- entry
- exit
- PnL
- reason
- status

### Runtime logs

Streaming recent events with severity filters.

Secrets must be redacted before an event reaches the frontend.

## Control separation

Authentication and live trading are separate permissions.

Successfully logging into KCEX must **not** enable automated trading.

Runtime sequence:

```
UNLOCK VAULT
    ↓
LOGIN KCEX
    ↓
READ-ONLY READY
    ↓
PAPER READY
    ↓
explicit LIVE arm
    ↓
RiskEngine check
    ↓
LIVE READY
```

Restart always returns LIVE to OFF, even if login/session remains valid.

## Suggested local API

Exact routes may change, but the responsibility boundaries should resemble:

```
POST /api/v1/vault/unlock
POST /api/v1/vault/credentials
DELETE /api/v1/vault/credentials

GET  /api/v1/auth/state
POST /api/v1/auth/login
POST /api/v1/auth/otp
POST /api/v1/auth/logout

GET  /api/v1/dashboard/snapshot
GET  /api/v1/trades
GET  /api/v1/logs

POST /api/v1/trading/pause
POST /api/v1/trading/resume
POST /api/v1/trading/arm-live
POST /api/v1/trading/disarm-live

WS   /api/v1/events
```

Sensitive endpoints must accept requests only from the local dashboard origin by default.

## Logging / redaction

The logger must redact fields named or shaped like:

- password
- pass
- secret
- key
- otp
- code when attached to auth requests
- cookie
- authorization
- token
- storageState

Frontend network errors must not echo raw backend request bodies for secret-bearing endpoints.

## GitHub Actions testing

All development validation remains CI-only.

GitHub Actions can test:

- frontend build
- backend typecheck
- vault encryption/decryption using fake credentials
- wrong master key rejection
- credential redaction
- auth state-machine transitions
- fake OTP workflow
- API request validation
- WebSocket event schemas
- dashboard reducers/components
- mock KCEX page fixtures

GitHub Actions must never receive real:

- KCEX account
- KCEX password
- OTP
- cookies
- session tokens
- encrypted vault copied from the user's machine

## First implementation order

1. Dashboard shell + WebSocket connection state
2. Vault format + encryption service
3. Credential save/update/delete UI
4. Auth state machine with fake adapter
5. OTP-required UI and fake OTP flow
6. CI tests
7. Playwright KCEX login adapter
8. real page state extractor
9. trading controls

This keeps credentials/UI concerns separate from order execution.
