# AGENTS.md

Instructions for ChatGPT / Codex / coding agents working in this repository.

## General

Work one task at a time.

Read:
- README.md
- ARCHITECTURE.md
- SAFETY.md
- current task spec under docs/tasks/

Do not implement later phases early.

## CRITICAL: no local execution

The user's machine is **editing-only** for development tasks unless the user explicitly changes this rule.

The coding agent MUST NOT run any development, validation, build, test, dependency-install, or Playwright command on the user's machine.

Do **not** run locally:

- `npm install`
- `npm ci`
- `npm run dev`
- `npm run build`
- `npm run typecheck`
- `npm test`
- `npx playwright ...`
- Chromium/Playwright browser launches
- database migrations
- scripts that write runtime data
- package-manager commands that modify the local environment
- any KCEX automation

Do not install Node.js, npm packages, Playwright browsers, system packages, databases, or other dependencies on the user's machine.

All automated validation must run in **GitHub Actions**.

The local coding agent may:
- inspect and edit repository files
- create branches/commits
- push changes
- open PRs
- inspect GitHub Actions results
- fix code based on CI logs

If a task cannot be fully verified without a real logged-in KCEX browser, mark that verification as **DEFERRED MANUAL VERIFICATION** instead of running it locally.

## Critical trading restrictions

Until a task explicitly authorizes live execution:

- do not click Long/Short submit buttons
- do not place test orders
- do not create real positions
- do not add a hidden live fallback
- do not auto-enable live mode
- do not reverse engineer private KCEX APIs
- do not bypass captcha or security checks

## Coding rules

- TypeScript strict mode
- isolate Playwright selectors in KCEX adapter files
- avoid fragile nth-child selectors unless there is no alternative
- prefer role/text/label/stable attributes
- write structured logs
- failures must be explicit
- unknown page state must fail closed
- add tests for pure logic
- use static/mock HTML fixtures for DOM-state tests where possible
- never commit browser profile, cookies, logs, screenshots, databases, or secrets

## CI-only validation

Every implementation PR must be validated by GitHub Actions.

At minimum CI should run:

```
npm ci
npm run typecheck
npm test
```

If browser-level fixture tests are added later, Playwright browsers must be installed and executed **inside GitHub Actions**, never on the user's machine.

Do not upload KCEX login cookies, browser profiles, passwords, API credentials, or authenticated session data to GitHub Actions.

Authenticated KCEX verification is intentionally separate from CI.

## Completion report

For each task, report:

1. files changed
2. behavior implemented
3. GitHub Actions workflow/run used
4. CI typecheck result
5. CI test result
6. deferred manual verification, if any
7. known limitations
8. confirmation that no unauthorized real order was placed
9. confirmation that no test/build/install command was run on the user's machine
