# TASK-013 — KCEX End-to-End Real Trading Launch

Status: REVIEW READY

## Scope

Implement the complete, gated path for KCEX password/Email OTP or manual Google OAuth, read-only GPS_USDT verification, a verified contract profile, a single Canary, and runtime-only automatic scheduler execution. TASK-013 is one branch and one pull request. There is no TASK-014 or split launch task.

The code stage must stop at **CODE REVIEW READY**. A green fixture CI run is not real KCEX verification, Canary completion, or launch approval.

## Authentication and local state

- Password and Email OTP continue through the existing Vault and AuthService. Password persistence is encrypted; OTP remains short-lived memory only.
- Google OAuth is opened from the trusted KCEX origin. The user completes Google password, 2FA, and any challenge in the browser. The adapter never reads or fills Google credentials.
- Exported browser state is filtered to the exact `www.kcex.com` origin and encrypted by the existing session store.
- Session restore is read-only. Every process restart creates Auto Live as `DISARMED`.
- CAPTCHA, security challenges, OTP-required state, session loss, and insufficient evidence stop live automation and require a user action. There is no auto-login or challenge bypass.

## Read-only verification and report

`KCEX Verification Mode` is shown only for an authenticated KCEX read-only session. It records a locally reviewed report at `data/kcex-verification-report.json`, which is gitignored and mode-restricted. The report schema accepts only fixed verification keys, selector IDs, numeric contract metadata, and verification status. It rejects arbitrary properties and does not contain credentials, email, OTP, cookies, tokens, storage state, HTML, or page text.

The report must establish the trusted host, login/account markers, GPS_USDT read fields, open/empty position and orders evidence, order controls, quantity semantics, isolated/10x/market semantics, position confirmation, TP/SL controls and evidence, UNKNOWN handling, and restart disarm. Contract metadata is unverified until all required manual checks pass. Unverified mutation selectors keep the KCEX writer blocked.

## Live execution boundaries

- `LIVE_TRADING` defaults to `false`; enabling it requires `KCEX_AUTOMATION_AUTHORIZED=true`, `AUTH_PROVIDER=KCEX`, and `LIVE_EXECUTION_PROVIDER=KCEX`.
- The only production KCEX order and protection writers are under `apps/server/src/kcex-live/`. They use verified selectors from the local report and a trusted KCEX page; there is no direct trading API or CAPTCHA bypass.
- Scheduler entries use the persisted slot side, GPS_USDT, ISOLATED, 10x, 50 USDT margin, and MARKET. Contract quantity is derived only from the manually verified profile. Out-of-range balance, step, precision, min/max, or notional blocks the attempt.
- A submit is attempted at most once. Ambiguous submission or protection outcomes become UNKNOWN and stop later entries.
- Position confirmation requires fresh read-only GPS_USDT evidence. Only then is a LIVE trade recorded. Unknown fees and exits remain null; an exit without trustworthy fill/history evidence is `UNKNOWN_EXIT` and requires manual action.
- TP/SL are configured explicitly, persisted as PLANNED before mutation, submitted once, and must have read-only confirmation. Missing or ambiguous protection blocks further entries and never closes a position automatically.
- Auto Live requires all RiskEngine, Kill Switch, resilience, auth, fresh-read, flat-position, empty-open-orders, storage, profile, Canary, and protection gates. Stop prevents future entries without closing the current position.
- Canary is separate from the scheduler: explicit side and margin (at most the risk cap), a preview, exact confirmation phrase, one durable attempt, position confirmation, and protection verification. Only one Canary attempt is permitted.

## CI and deferred acceptance

GitHub Actions runs `npm ci`, typecheck, frontend build, unit/migration tests, and loopback browser fixtures with `LIVE_TRADING=false`, `LIVE_EXECUTION_PROVIDER=FIXTURE`, `AUTH_PROVIDER=FAKE`, `KCEX_READONLY_ENABLED=false`, and `KCEX_AUTOMATION_AUTHORIZED=false`.

Deferred until code review and explicit user action:

- real password login and Email OTP
- manual Google OAuth completion
- authenticated GPS_USDT page/DOM and contract-profile verification
- first user-started live Canary
- end-to-end scheduler execution on KCEX

No real credentials, login, KCEX request, order, leverage/margin change, TP/SL action, or Canary is used by this coding task or CI.
