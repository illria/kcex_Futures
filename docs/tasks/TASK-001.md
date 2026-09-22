# TASK-001 — KCEX Playwright Bootstrap & Read-Only Browser Session

## Objective

Create the initial TypeScript + Playwright project for a future persistent KCEX browser session, implement the read-only session/page-detection architecture, and validate all automated behavior in GitHub Actions.

This task must not place or prepare any real order.

**The user's machine must not be used to install dependencies, run tests, run typecheck/build, launch Playwright, or validate the implementation.**

Live authenticated KCEX verification is deferred until the user explicitly requests it in a later step.

## Required stack

- Node.js 22+
- TypeScript
- Playwright
- Zod
- Pino
- Vitest

SQLite may be declared now, but persistence is not required in this task.

## Required project structure

At minimum:

```
src/
  browser/
  kcex/
  config/
  logging/
  utils/

tests/
  fixtures/
data/
logs/
screenshots/
```

## Required package scripts

Provide sensible equivalents of:

```
npm run dev
npm run typecheck
npm test
```

The coding agent must create these scripts but **must not execute them locally**.

Optional:
- lint
- format

## GitHub Actions requirement

Create/maintain a workflow under:

```
.github/workflows/ci.yml
```

CI is the only automated validation environment.

Once `package.json` exists, CI must:

1. use Node.js 22
2. require a committed lockfile
3. run `npm ci`
4. run `npm run typecheck`
5. run `npm test`

No KCEX credentials, cookies, browser profile, or authenticated state may be uploaded to Actions.

## Persistent browser session implementation

Implement a launcher using Playwright persistent context.

Expected future runtime behavior:

1. create/reuse a local browser profile directory
2. launch Chromium in headed mode by default
3. open KCEX
4. allow the user to manually log in if needed
5. reuse the same authenticated browser profile on a later run

Never request the user's KCEX password in the CLI.

The browser profile directory must be ignored by git.

**Do not launch this browser on the user's machine during TASK-001 development.**

## KCEX navigation

Create a KCEX adapter with a single responsibility:

```
openGpsFuturesPage(page)
```

The URL should be centralized in one file and not repeated across the codebase.

Redirect and page-state logic should return explicit safe results rather than guessing.

## Login-state detection

Implement best-effort read-only login detection.

Return something explicit, for example:

```ts
type LoginState =
  | { status: "LOGGED_IN" }
  | { status: "LOGGED_OUT" }
  | { status: "UNKNOWN"; reason: string };
```

Do not assume "not seeing a login button" means logged in.

If DOM evidence is insufficient, return UNKNOWN.

## GPS futures page detection

Implement a read-only check that confirms whether DOM/URL evidence matches the requested futures symbol.

Target normalized symbol:

```
GPS_USDT
```

Possible evidence:
- URL
- visible pair text
- page heading
- stable read-only DOM evidence

Use more than one signal when practical.

Return UNKNOWN rather than guessing.

## Fixture-based testing

Because authenticated KCEX browser testing must not run on the user's machine or in public CI, test DOM interpretation with safe static fixtures/mocks.

Add representative fixture cases for:

- logged-in-like DOM evidence
- logged-out-like DOM evidence
- ambiguous DOM → UNKNOWN
- GPS_USDT page evidence
- mismatched symbol
- insufficient symbol evidence → UNKNOWN

Fixtures must contain no real user information, cookies, tokens, or KCEX session material.

## Output contract

Future runtime output should support a compact diagnostic summary such as:

```
KCEX Futures Bootstrap

Browser: READY
Profile: ./data/browser-profile
Login: LOGGED_IN
Requested Symbol: GPS_USDT
Page Symbol: GPS_USDT
Futures Page: READY
Live Trading: OFF
```

This output contract can be validated through unit/fixture tests in CI.

## Screenshots

Runtime code may support timestamped diagnostic screenshots under:

```
screenshots/
```

Do not commit screenshots.

TASK-001 does not require launching the browser locally to produce them.

## Configuration

Add `.env.example` and/or a local config example.

For Task 001, config should include only safe non-trading options such as:

```
KCEX_BASE_URL=
KCEX_SYMBOL=GPS_USDT
BROWSER_HEADLESS=false
BROWSER_PROFILE_DIR=./data/browser-profile
LIVE_TRADING=false
```

The application must reject or ignore attempts to enable live trading in Task 001.

## Git ignore

At minimum ignore:

```
node_modules/
.env
data/
logs/
screenshots/
playwright-report/
test-results/
```

## Automated tests

All automated tests run in GitHub Actions only.

Cover at least:

- symbol normalization
- URL / page-symbol matching
- config default of LIVE_TRADING=false
- attempts to enable live trading are rejected/ignored in Task 001
- LOGGED_IN / LOGGED_OUT / UNKNOWN classification using fixtures
- UNKNOWN behavior for insufficient evidence
- no exported Task-001 path exposes order submission

No automated test should place an order or contact an authenticated KCEX account.

## Acceptance criteria

Task 001 implementation is complete when:

- [ ] project structure is committed
- [ ] package lockfile is committed
- [ ] GitHub Actions CI passes
- [ ] CI dependency install passes
- [ ] CI TypeScript typecheck passes
- [ ] CI unit/fixture tests pass
- [ ] persistent-browser launcher is implemented but not locally executed
- [ ] login-state detector has fixture coverage
- [ ] GPS_USDT detector has fixture coverage
- [ ] browser profile/runtime directories are gitignored
- [ ] no real order button interaction exists
- [ ] no code path submits a live order
- [ ] LIVE_TRADING remains OFF
- [ ] no dependency/test/build/Playwright command was run on the user's machine

The following are explicitly **deferred**, not blockers for TASK-001 CI completion:

- real KCEX login verification
- actual persistent-session reuse verification
- actual GPS_USDT live-page selector verification
- real browser screenshots

These require a later user-approved manual/browser verification step.

## Completion report format

When finished, provide:

```
TASK-001 COMPLETE

Files changed:
- ...

Implemented:
- ...

GitHub Actions:
- workflow:
- run URL / run ID:
- conclusion:

CI results:
- npm ci:
- typecheck:
- tests:

Deferred manual verification:
- real KCEX login:
- persistent session reuse:
- live GPS_USDT DOM:

Known limitations:
- ...

Safety confirmation:
- No real order was submitted.
- No order button was clicked.
- LIVE_TRADING remains OFF.
- No install/build/test/Playwright command was run on the user's machine.
```

Do not begin TASK-002 until this task has been reviewed.
