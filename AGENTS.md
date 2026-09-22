# AGENTS.md

Instructions for local ChatGPT / Codex / coding agents working in this repository.

## General

Work one task at a time.

Read:
- README.md
- ARCHITECTURE.md
- SAFETY.md
- current task spec under docs/tasks/

Do not implement later phases early.

## Critical restrictions

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
- never commit browser profile, cookies, logs, screenshots, databases, or secrets

## Local inspection

The local coding agent may use the user's already logged-in browser session to inspect DOM and selectors.

When inspecting KCEX:
- keep Task 001 read-only
- do not press order submission controls
- do not alter leverage or margin mode during Task 001
- save discovered selector notes in code comments or docs if useful

## Completion report

For each task, report:

1. files changed
2. behavior implemented
3. commands run
4. test/typecheck result
5. manual verification steps
6. known limitations
7. confirmation that no unauthorized real order was placed
