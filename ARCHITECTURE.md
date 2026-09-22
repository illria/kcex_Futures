# Architecture

## Goal

Build a local KCEX Futures automation tool around Playwright with strong separation between:

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
src/
  browser/
    launch.ts
    session.ts
  kcex/
    urls.ts
    selectors.ts
    page.ts
    state.ts
  trading/
    models.ts
    executor.ts
    position.ts
  scheduler/
    daily-plan.ts
    runner.ts
  risk/
    engine.ts
    rules.ts
  storage/
    db.ts
    schema.ts
  config/
    schema.ts
    load.ts
  logging/
    logger.ts
  utils/

tests/
  unit/
  integration/

docs/
  tasks/

data/
logs/
screenshots/
```

## Runtime state machine

```
BOOT
  ↓
BROWSER_READY
  ↓
LOGIN_REQUIRED / LOGIN_OK
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

## Key design decisions

### 1. KCEX adapter layer

All page-specific selectors and interaction logic must live under `src/kcex/`.

Do not spread selectors through strategy or scheduler code.

### 2. Persistent browser profile

Use Playwright persistent context and a local profile directory.

Credentials are entered manually by the user. The app must not ask for or persist username/password.

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

### 5. Live trading gate

Live execution must require all of:

- config allows live mode
- explicit CLI flag
- explicit typed confirmation
- RiskEngine approval
- correct symbol
- correct leverage
- correct isolated/cross mode
- no unexpected existing position
- sufficient balance

### 6. Restart behavior

On every process restart:

- live mode resets to OFF
- schedule may be restored
- logs and history may be restored
- positions must be re-detected from KCEX page before any further action
- no persisted flag may silently re-arm live trading

## First-version scope

Supported:

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
