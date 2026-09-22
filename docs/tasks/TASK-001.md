# TASK-001 — KCEX Playwright Bootstrap & Read-Only Browser Session

## Objective

Create the initial local TypeScript + Playwright project and prove that it can open KCEX using a persistent browser profile, reuse a manually authenticated session, navigate to the GPS_USDT futures page, and report read-only session/page status.

This task must not place or prepare any real order.

## Required stack

- Node.js 22+
- TypeScript
- Playwright
- Zod
- Pino
- Vitest

SQLite may be installed now, but persistence is not required in this task.

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

Optional:
- lint
- format

## Persistent browser session

Implement a launcher using Playwright persistent context.

Expected behavior:

1. create/reuse a local browser profile directory
2. launch Chromium in headed mode by default
3. open KCEX
4. allow the user to manually log in if needed
5. reuse the same authenticated browser profile on the next run

Never request the user's KCEX password in the CLI.

The browser profile directory must be ignored by git.

## KCEX navigation

Create a KCEX adapter with a single responsibility:

```
openGpsFuturesPage(page)
```

The URL should be centralized in one file and not repeated across the codebase.

If KCEX redirects due to locale, authentication, or page structure, detect/report that clearly.

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

If the DOM does not provide enough evidence, return UNKNOWN.

## GPS futures page detection

Implement a read-only check that confirms the page appears to be the requested futures symbol.

Target normalized symbol:

```
GPS_USDT
```

The implementation may inspect:
- URL
- visible pair text
- page heading
- other stable read-only DOM evidence

Use more than one signal when practical.

Return UNKNOWN rather than guessing.

## Output

Running the app should print a compact diagnostic summary similar to:

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

If login is required:

```
Login: LOGGED_OUT
Action: please log in manually in the opened browser, then re-run or continue
```

## Screenshots

On significant failure/UNKNOWN state, save a timestamped screenshot under:

```
screenshots/
```

Do not commit screenshots.

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

The application must reject or ignore attempts to enable live trading in Task 001. Live execution is out of scope.

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

Keep directory placeholders only if needed.

## Tests

Write unit tests for pure logic such as:

- symbol normalization
- URL / page-symbol matching
- config default of LIVE_TRADING=false
- UNKNOWN behavior for insufficient evidence

No automated test should place an order.

## Acceptance criteria

Task 001 is complete only when:

- [ ] project installs successfully
- [ ] TypeScript compiles/typechecks
- [ ] unit tests pass
- [ ] Playwright opens a headed persistent browser
- [ ] browser profile is reused across runs
- [ ] user can log in manually
- [ ] app can distinguish LOGGED_IN / LOGGED_OUT / UNKNOWN reasonably
- [ ] app navigates to GPS_USDT futures
- [ ] app confirms or rejects the visible symbol without guessing
- [ ] failures produce useful logs and screenshots
- [ ] no real order button is clicked
- [ ] no code path submits a live order
- [ ] LIVE_TRADING remains OFF

## Manual verification checklist

The local developer should verify:

1. run app while logged out
2. confirm it opens browser and reports logged-out/unknown safely
3. manually log in
4. close app
5. rerun app
6. verify session is reused
7. verify GPS_USDT futures page opens
8. verify reported symbol matches actual page
9. inspect logs
10. confirm there are no order-submission interactions

## Completion report format

When finished, provide:

```
TASK-001 COMPLETE

Files changed:
- ...

Implemented:
- ...

Commands run:
- ...

Results:
- typecheck:
- tests:
- manual browser verification:

Known limitations:
- ...

Safety confirmation:
- No real order was submitted.
- No order button was clicked.
- LIVE_TRADING remains OFF.
```

Do not begin TASK-002 until this task has been reviewed.
