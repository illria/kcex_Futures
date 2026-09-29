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
risk.state
system.log
system.heartbeat
```

The frontend consumes these events to maintain the live dashboard.

## Key design decisions

### Storage layer (TASK-005)

Trading lifecycle services pass validated durable records to `StorageService`:

```
Trading services
      ↓
StorageService
      ↓
TradeRepository · DailyPlanRepository · AuditRepository
      ↓
Node.js node:sqlite / local SQLite
```

The SQLite layer owns versioned migrations, prepared statements, bounded reads,
Zod validation before writes and after reads, append-only event APIs, and atomic
trade transitions. The default database is `data/trading.sqlite3`; `TRADING_DB_FILE`
may select another local path. Initialization and migrations complete before
the HTTP server listens, and any initialization failure prevents server startup.
Dashboard history reads are bounded and report storage as degraded if a runtime
read fails.

SQLite stores trade records, trade lifecycle events, daily plan records, and
runtime audit events only. It does not store credentials, account/password data,
OTP values, cookies, tokens, encrypted or plaintext browser sessions, storage
state, KCEX snapshots, or market time series. Credentials and sessions remain
owned by the encrypted vault/session store. Live-arm state is runtime-only and
is never persisted; process startup always forces `LIVE_TRADING=false`.

TASK-005 introduced read APIs to the Dashboard. TASK-006 adds a server-internal
deterministic Paper lifecycle that persists only PAPER-mode records through the
same storage layer. It does not submit or cancel KCEX orders or modify
exchange positions, leverage, or margin mode.

### Paper Trading Layer (TASK-006)

Only a future explicit server-side caller may invoke
PaperTradingService.planPaperTrade(), openPaperTrade(),
markPaperTrade(), or closePaperTrade(). The service depends on
StorageService, the shared EventBus, an injectable clock/ID generator, and
the bounded simulated fee rate. It has no KCEX auth adapter, browser page,
credential, session, or Playwright dependency.

Data path: future explicit caller → PaperTradingService → pure linear USDT PnL
model → StorageService / TradeRepository → SQLite. The service publishes shared
paper.state and trade lifecycle events through EventBus to the Dashboard.

Paper simulation uses marginUsdt * leverage notional and
notionalUsdt / entryPrice quantity. Its fees are configurable simulation
values, defaulting to zero; this is not a verified KCEX fee model. Mark
updates remain runtime-only and do not write per-tick database records.
Startup recovery restores at most one persisted open PAPER GPS_USDT record,
with mark and unrealized PnL reset to null. Multiple open records halt Paper
mutations and surface an ERROR runtime state while the read-only Dashboard
remains available.

The Dashboard exposes only GET /api/v1/paper/state. Paper lifecycle commands
are not HTTP endpoints. paper.state uses the shared schema and remains separate
from futures.position, which represents KCEX read-only data. LIVE_TRADING=false
remains enforced; this layer has no KCEX write capability.

Server startup initializes storage, initializes RiskService, constructs and
recovers the Paper service, then creates/listens on the HTTP server. A Paper
recovery conflict is surfaced as runtime ERROR without blocking the read-only
Dashboard. Shutdown stops the Paper service before futures/auth services and
storage.

### Risk Controls (TASK-007)

RiskService is initialized after storage and before Paper recovery. It owns the
read-only file Kill Switch check, bounded SQLite aggregates, execution-failure
recovery from RISK audit events, and shared risk.state / risk.blocked events.
The pure RiskEngine receives only a validated trade intent, runtime context, and
bounded limits; it has no filesystem, database, logger, browser, or KCEX imports.

PaperTradingService requires an explicit Risk guard and checks it after loading
the active PLANNED record but before calculating or persisting an OPEN fill.
Risk blocks leave the plan unchanged. Kill Switch state applies only to new
entries; marking, closing, and startup recovery of existing Paper positions
remain available. The Dashboard and `/api/v1/risk/state` expose read-only state.
Risk uses existing `trades` and `audit_events` tables; TASK-007 adds no
migration, write API, scheduler, or live execution path.

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

- a separately authorized execution provider; configuration alone is not authorization
- explicit runtime arm
- RiskEngine approval
- supported symbol and bounded intent
- verified position evidence; UNKNOWN fails closed

`LIVE_TRADING` stays `false` and cannot enable execution. TASK-008 permits only
the `FIXTURE` provider through its runtime arm and RiskEngine gate. It has no
KCEX write adapter, selector, browser interaction, or order request.

### Assisted Execution Layer (TASK-008)

The fixture-only path is deliberately separate from Paper lifecycle persistence
and the KCEX read-only extractor:

```text
Human confirmation
        ↓
Runtime-only five-minute arm
        ↓
Immutable 60-second preview
        ↓
Single-use confirmation token
        ↓
RiskEngine precheck with explicit fixture position source
        ↓
Single-flight executor (one attempt, no retry)
        ↓
FixtureExecutionAdapter
```

The execution provider defaults to `DISABLED`; GitHub Actions selects
`FIXTURE`. A confirmation consumes the arm and preview before precheck, so
blocked and failed attempts cannot be replayed. `SUBMITTED` means only that the
fixture adapter accepted one submission action. It never means fill or open
position. TASK-009 adds bounded fixture-only position evidence and the durable
UNKNOWN reconciliation state; it does not add a real KCEX confirmation source.

Arm state, active preview, and confirmation token exist only in process memory
and are never persisted to SQLite, JSON files, or Vault; restart always starts
DISARMED. The local `execution.state` event carries status, arm expiry, and the
active preview but never the confirmation token. The token is returned only in
the preview HTTP response for its one confirmation and is excluded from logs
and audit records. Audits record intent fields and reason codes only. There is
no live trade record or schema migration.

Real KCEX browser mutation remains disabled pending required platform
authorization, authenticated manual page verification, verified contract-size
semantics, verified isolated/leverage controls, and a separate safety review.
Runtime arm is local intent and does not grant KCEX automation permission.

The UI presents explicit LONG/SHORT selection and separate Arm, Preview, and
Confirm actions. It displays the fixed MARKET/ISOLATED intent and clearly labels
reference price as not a guaranteed fill price. There is no scheduler, random
direction, TP, or SL in TASK-008.

### Position Confirmation and UNKNOWN (TASK-009)

Implementation status: REVIEW READY in PR #10; not merged.

TASK-009 appends SQLite schema v2 for durable attempts. `SUBMITTING` and its
audit event commit atomically before the fixture adapter call. The execution
state then moves through `SUBMITTED` and `CONFIRMING`; only fresh fixture
evidence matching GPS_USDT, intended side, positive entry price, and positive
size can produce fixture `CONFIRMED`. This is not an exchange position.

Timeout, adapter throw, malformed response, or insufficient confirmation
evidence becomes durable `UNKNOWN`. One unresolved attempt blocks all new
arming, preview, confirmation, and adapter calls. Restart converts interrupted
SUBMITTING/SUBMITTED/CONFIRMING attempts to UNKNOWN. Manual reconciliation only
reads bounded fixture evidence and never resubmits. Risk outcome accounting is
keyed by attempt ID so UNKNOWN is counted once. No LIVE trade row is created;
real KCEX confirmation and mutation remain deferred.

### 6. Restart behavior

On every process restart:

- master key must be entered again
- live mode resets to OFF
- encrypted session may be restored after vault unlock
- schedule/history may be restored
- positions must be re-detected from KCEX before any further action
- no persisted flag may silently re-arm live trading

## First-version scope

Long-term proposed scope (not all implemented in TASK-008):

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
