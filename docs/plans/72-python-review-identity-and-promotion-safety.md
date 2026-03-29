---
title: Python Review Identity and Promotion Safety
status: active
plan: 72-python-review-identity-and-promotion-safety
created: 2026-03-10
tags:
  - type/plan
  - status/active
  - project/opencode-python-tool
  - topic/session-report
  - topic/hitl-review
  - topic/python-rules
---

# Python Review Identity and Promotion Safety

## Objective

Replace bare-call review reuse with a stable review identity based on occurrence kind plus canonical callable context, keep legacy ledger rows exact-fingerprint compatible, and block auto-promotion when one live call string maps to multiple reviewed identities.

## Scope

### In Scope

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

### Out of Scope

- new analyzer evidence fields beyond the existing `kind`, `call`, and `sourceCall` metadata already emitted by the review pipeline
- persisting a precomputed review key in the ledger
- automatic promotion of `sourceCall` or canonical-source aliases into live rules
- widening live rules beyond the current `doc.calls.*` buckets

## Commit-Safe Phases

### Phase 1 - Add review identity to the ledger and write paths

**Goal:** Define one shared review-identity shape and persist the available identity fields everywhere a review decision is recorded.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- this plan file

**Changes:**

- add bounded helpers such as `isOccurrenceKind()`, `ReviewIdentity`, `reviewKeyOf()`, and `reviewLabel()` near the session-report review types
- widen `ReviewDecisionRecord` so ledger rows can carry optional `kind`, `call`, and `sourceCall` alongside `fingerprint`, `decision`, and `decidedAt`
- keep ledger parsing backward-compatible for old rows while refusing invalid `kind` values
- thread `kind` and `sourceCall` through `writeDecisions()`, `recordDecision()`, `applyDecisions()`, and the TUI decision save path
- update in-memory settling so repeated review items no longer collapse on bare `call`

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `refactor: add review identity to python review ledger`

#### Notes

- Status: Done (2026-03-10)
- Summary: Added review-identity metadata helpers and widened review-ledger write paths so persisted decisions can carry `kind` and `sourceCall` without breaking older rows. Tightened TUI in-memory settling to reuse only matching review identities instead of bare call strings.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/72-python-review-identity-and-promotion-safety.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: Phase 2 should switch replay and suggestion lookup from `byCall` to full review-key consensus while keeping exact-fingerprint decisions highest priority.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Replace call-level reuse with review-key consensus

**Goal:** Make review replay, queue resolution, and suggestion lookup all use the same identity function instead of falling back to callable-name-only reuse.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- this plan file

**Changes:**

- replace `DecisionLookup.byCall` with `byReviewKey`
- add a helper such as `decisionIdentity()` that reconstructs review identity from ledger rows or current report metadata
- keep exact-fingerprint matches as the highest-priority replay path
- limit legacy rows that only carry `call` to exact-fingerprint reuse unless the current report can safely reconstruct the same review identity
- update `resolvedDecision()`, `review()`, `suggestRules()`, and any other reuse path to take `{ fingerprint, kind, call, sourceCall }` rather than a bare call string

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `fix: replace call-level review reuse with review-key consensus`

#### Notes

- Status: Done (2026-03-10)
- Summary: Replaced bare call-level replay with review-key consensus keyed by `kind` plus canonical callable context, while keeping exact-fingerprint decisions highest priority and only reconstructing legacy call-only rows through the matching fingerprint's current identity.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/72-python-review-identity-and-promotion-safety.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`
- Follow-ups: Phase 3 should partition promotion planning by full review identity so one outward call string cannot silently merge multiple reviewed identities.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Partition promotions by review identity and guard live call targets

**Goal:** Keep the existing call-string rules writer, but stop promotion planning from merging distinct reviewed identities into one live call bucket.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- this plan file

**Changes:**

- rework `promotions()` to group occurrences by full review identity before considering promotion
- continue writing promotable entries as plain `row.call` values so the live rules shape stays unchanged in this patch
- block promotion when one outward call maps to multiple review identities, even if the reviewed decisions agree
- preserve existing blocking for unresolved contexts, non-promotable decisions, and conflicting decisions
- keep promotion, review replay, and TUI settling aligned on the same review-key semantics

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `fix: block python call promotion across multiple review identities`

#### Notes

- Status: Done (2026-03-10)
- Summary: Reworked `promotions()` to evaluate reviewed evidence per full review identity first, then block any outward call that would merge multiple identities into one live rule target while keeping promoted outputs as plain call strings.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/72-python-review-identity-and-promotion-safety.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`
- Follow-ups: Phase 4 should add README/operator-guide documentation and any remaining regression coverage around the narrower identity-aware promotion semantics.
- Commit: Not committed
- PR/Jira: None

### Phase 4 - Add regression coverage and operator docs

**Goal:** Lock the new identity semantics with targeted regressions and document the narrower reuse and promotion rules.

**Files:**

- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

**Changes:**

- update ledger assertions so stored decisions include `kind` and `sourceCall` when available
- rewrite cross-snippet reuse tests so they only reuse decisions when review identity matches
- add regressions for same display call with different `sourceCall`, same display call with different `kind`, TUI settle behavior, promotion blocking across multiple identities, and legacy-ledger exact-fingerprint compatibility
- update README and operator-guide wording so they describe exact-fingerprint reuse, review-identity-based cross-snippet reuse, and promotion blocking when one live call target maps to multiple review identities

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `test: add review identity and legacy-ledger regressions`

#### Notes

- Status: Done (2026-03-10)
- Summary: Added the remaining Phase 4 regressions around legacy fingerprint replay, source-aware TUI settling, and operator-visible identity semantics; updated README/operator guidance and now reject malformed ledger rows that set `kind` without a usable `call` (including empty-string calls), with malformed-ledger coverage exercised through review, suggestion, and promotion entrypoints.
- Files: `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`, `docs/plans/72-python-review-identity-and-promotion-safety.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

#### Follow-up Notes

- Status: Done (2026-03-10)
- Summary: Hardened the remaining review feedback in `src/python-session-report.ts` by blocking promotion when one review identity spans multiple outward call aliases and by keeping TUI in-memory settle propagation from overwriting candidates that already carry their own decisions.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/72-python-review-identity-and-promotion-safety.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- ledger rows can persist optional `kind` and `sourceCall` metadata without breaking old ledgers
- review reuse only crosses snippet boundaries when `kind` and canonical callable context match, while exact fingerprint decisions always replay
- TUI settle, non-interactive review, suggestion lookup, and promotion planning all resolve identity the same way
- promotion blocks any live call target that maps to multiple review identities instead of auto-merging them into one `doc.calls.*` bucket
- docs and regressions explain and enforce the safer migration behavior for old rows and ambiguous live-call targets

## Phase Status

- Phase 1: DONE (2026-03-10)
- Phase 2: DONE (2026-03-10)
- Phase 3: DONE (2026-03-10)
- Phase 4: DONE (2026-03-10)
