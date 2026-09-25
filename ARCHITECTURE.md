# Architecture

## Goal

Build a local KCEX Futures automation tool around Playwright with strong separation between:

- local dashboard
- secure credential vault
- browser/session control
- KCEX page adapters
- read-only state extraction
- strategy/scheduling
- risk controls
- execution
- persistence
- logging/auditing

## Proposed structure

```
apps/
  web/
    src/
  server/
    src/
      api/
      auth/
      futures/
      browser/
      kcex/
      realtime/
      trading/
      scheduler/
      risk/
      storage/
      logging/

packages/
  shared/
    src/

tests/
  unit/
  fixtures/
  integration/

docs/
  tasks/

data/
logs/
screenshots/
```

## Local dashboard

Default:

```
http://127.0.0.1:6666
```

The service binds to loopback by default.

Frontend responsibilities:

- unlock local vault
- enter/save KCEX account and password
- enter email OTP when requested
- show auth/session status
- show live market/account/position/scheduler state
- show logs
- expose pause/resume and later live-arm controls

The frontend must never receive a stored plaintext password after it has been saved.

## Secure vault

The application uses a local master key supplied at runtime.

Recommended design:

```
master key
  ↓
Argon2id / scrypt
  ↓
AES-256-GCM key
  ↓
encrypted vault
```

Vault may contain:

- KCEX account
- KCEX password
- encrypted Playwright session/storage state

Rules:

- master key is never persisted
- password is never stored plaintext
- OTP is never persisted
- credentials never enter GitHub Actions
- secrets are redacted from logs

## Authentication state machine

```
APP_LOCKED
  ↓
VAULT_UNLOCKED
  ↓
SESSION_CHECK
  ├── session valid ─────────────→ AUTHENTICATED
  └── no/invalid session
             ↓
       CREDENTIALS_REQUIRED
             ↓
         LOGGING_IN
           ├── success ─────────→ AUTHENTICATED
           ├── email OTP ───────→ OTP_REQUIRED
           ├── captcha ─────────→ MANUAL_CHALLENGE
           └── failure ─────────→ AUTH_FAILED

OTP_REQUIRED
  ↓
SUBMITTING_OTP
  ├── success ──────────────────→ AUTHENTICATED
  └── failure ──────────────────→ OTP_REQUIRED / AUTH_FAILED
```

Unknown auth state must fail closed.

Captcha/security challenges must not be bypassed automatically.

## Runtime trading state machine

```
BOOT
  ↓
APP_LOCKED
  ↓
AUTHENTICATED
  ↓
FUTURES_PAGE_READY
  ↓
READ_ONLY_READY
  ↓
PAPER_READY
  ↓
LIVE_ARMED
  ↓
PRECHECK
  ↓
SUBMITTING
  ↓
CONFIRMING
  ↓
POSITION_OPEN
  ↓
EXIT_PROTECTION_READY
  ↓
POSITION_CLOSED
```

Error states:

```
AUTH_LOST
PAGE_UNKNOWN
SYMBOL_MISMATCH
RISK_BLOCKED
SUBMIT_UNKNOWN
HALTED
```

Any unknown state must fail closed.

## Realtime event architecture

Backend publishes versioned events over WebSocket.

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

The frontend consumes these events to maintain the live dashboard.

## Key design decisions

### 1. KCEX adapter layer

All page-specific selectors and interaction logic must live under the KCEX adapter.

Do not spread selectors through strategy or scheduler code.

### 2. Session persistence

Prefer encrypted Playwright storage state when practical.

If KCEX requires persistent browser-profile state that storageState cannot preserve, the profile must be treated as sensitive local data and never committed/uploaded.

### 3. Read-only before write

The first milestones must only read:

- active symbol
- visible price
- wallet/available balance
- leverage
- margin mode
- open position
- active orders

No order button should be clicked before the read-only layer is stable.

TASK-004 makes this boundary explicit:

```
KcexAuthAdapter page
  -> KcexAuthenticatedPageSource (official host check)
  -> KcexFuturesReadAdapter (selectors + strict numeric parser)
  -> FuturesReadService (single-flight polling)
  -> shared KcexFuturesSnapshot
  -> WebSocket / local dashboard
```

The extractor has no Playwright mutation methods. `KCEX_READONLY_ENABLED=false`
is the default, and CI uses mock or loopback fixture pages only. A stale session,
challenge, symbol mismatch, or insufficient evidence stops or degrades the read
stream; it never triggers credential entry, refresh, or trading.

### 4. Execution is stateful

A click does not mean success.

The executor must transition through:

```
PLANNED
PRECHECK_OK
SUBMITTING
SUBMITTED
CONFIRMING
CONFIRMED
FAILED
UNKNOWN
```

If confirmation cannot be obtained, mark `UNKNOWN` and block further entries.

### 5. Authentication != live trading

Successful KCEX login only enables read-only access.

Live execution must separately require:

- config allows live mode
- explicit runtime arm
- RiskEngine approval
- correct symbol
- correct leverage
- correct isolated/cross mode
- no unexpected existing position
- sufficient balance

### 6. Restart behavior

On every process restart:

- master key must be entered again
- live mode resets to OFF
- encrypted session may be restored after vault unlock
- schedule/history may be restored
- positions must be re-detected from KCEX before any further action
- no persisted flag may silently re-arm live trading

## First-version scope

Supported:

- local dashboard on port 6666
- encrypted credential vault
- email OTP input UI
- realtime WebSocket status
- one symbol: `GPS_USDT`
- isolated mode
- 10x leverage
- one open position maximum
- fixed margin per trade
- random daily schedule
- optional random LONG/SHORT
- TP/SL
- local SQLite persistence
- screenshots and logs

Not in first version:

- multi-account
- multi-symbol
- martingale
- DCA
- hedge-mode portfolio logic
- copy trading
- API reverse engineering
- captcha bypass
- anti-bot bypass
