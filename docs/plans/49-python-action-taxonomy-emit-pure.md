---
title: Python Action Taxonomy (Emit + Pure) Plan
status: done
plan: 49-python-action-taxonomy-emit-pure
created: 2026-03-07
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/permissions
  - topic/review-workflow
---

# Python Action Taxonomy (Emit + Pure) Plan

## Objective

Adopt the expanded action taxonomy:

- `read`: ingesting information from outside the in-memory computation
- `write`: mutating any external entity (file, database, API, queue, service)
- `emit`: outward reporting/signaling without durable external state mutation (stdout, logs, metrics, traces)
- `exec`: behavior/control execution outside normal data I/O (subprocess, shell, dynamic code execution, workflow triggers)
- `pure`: in-memory-only computation with no external interaction
- `unknown`: unresolved or ambiguous

with the runtime policy that `pure` is analyzer-only and excluded from permission/review flows by default.

## Scope

### In Scope

- `src/python/python-analyze.ts`
- `src/python/python-rules.json`
- `src/python.ts`
- `src/python-session-report.ts`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

### Out of Scope

- OpenCode core/TUI changes outside this repository
- historical reclassification migration of old stored review artifacts
- introducing additional categories beyond `emit` and `pure`

## Semantics

### `read`

Information ingestion from external sources.

Examples:

- file reads
- DB query/read
- API GET/list/query
- env var reads

### `write`

External state mutation.

Examples:

- file writes/deletes/renames
- DB insert/update/delete
- API POST/PUT/PATCH/DELETE
- queue publish where message causes side effects

### `emit`

External reporting/signaling with no intended durable state mutation.

Examples:

- `print(...)`
- logging
- metrics/tracing instrumentation

### `exec`

Execution/control operations outside data I/O classification.

Examples:

- subprocess/shell execution
- `eval`, `exec`, `compile`, dynamic import patterns
- explicit workflow/job trigger calls

### `pure`

In-memory-only transformations/computation.

Examples:

- regex match/group extraction
- parsing/formatting/transforms
- math/string/object operations with no external IO side effects

### `unknown`

Calls that cannot be reliably classified.

## Runtime + Permission Policy

- `read`, `write`, `exec`, and `unknown` continue to participate in permission planning.
- `emit` becomes first-class in analysis/report/review, but does not trigger permission asks by default.
- `pure` does not trigger permission asks and is excluded from review queues by default.
- Promotion flow supports `emit` into live rules.

## Commit-Safe Phases

### Phase 1 - Analyzer taxonomy extension

**Goal:** Extend analyzer/rules to emit `emit` and `pure` event kinds.

**Files:**

- `src/python/python-analyze.ts`
- `src/python/python-rules.json`
- `.opencode/test/python-analyze.test.ts`

**Changes:**

- Add `emit` and `pure` to event kinds.
- Add declarative rule buckets for `emit` calls/methods where appropriate.
- Classify obvious pure patterns (e.g., regex extraction) as `pure`.
- Keep unhandled patterns in `unknown`.

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`

**Commit message:**

- `feat: add emit and pure analyzer categories`

#### Notes

- Status: Done (2026-03-07)
- Summary: Extended analyzer taxonomy to emit `emit` and `pure` kinds with conservative declarative coverage, while preserving existing read/write/exec behavior and unknown fallback semantics.
- Files: `src/python/python-analyze.ts`, `src/python/python-rules.json`, `.opencode/test/python-analyze.test.ts`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`
- Follow-ups: Phase 2 must ensure runtime permission mapping keeps `emit` non-blocking and excludes `pure` from permission asks.
- Commit: `cdc79b7`
- PR/Jira: None

### Phase 2 - Runtime permission behavior

**Goal:** Ensure runtime honors new taxonomy.

**Files:**

- `src/python.ts`
- `.opencode/test/python.test.ts`

**Changes:**

- Update permission-plan mapping for new categories.
- Exclude `pure` from permission asks.
- Keep `emit` non-blocking by default (no ask), while still surfaced in metadata for review/observability.

**Validation:**

- `cd .opencode && bun test test/python.test.ts`

**Commit message:**

- `feat: honor emit and pure runtime semantics`

#### Notes

- Status: Done (2026-03-07)
- Summary: Updated runtime permission planning so `emit`/`pure` are non-blocking for `python` asks, while preserving these events in runtime metadata operations for observability.
- Files: `src/python.ts`, `.opencode/test/python.test.ts`
- Tests: `cd .opencode && bun test test/python.test.ts`
- Follow-ups: Phase 3 should ensure review/report defaults mirror runtime behavior by including `emit` and suppressing `pure` unless explicitly requested.
- Commit: `0701000`
- PR/Jira: None

### Phase 3 - Review/report/TUI taxonomy update

**Goal:** Integrate `emit` in review and suppress `pure` by default.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`

**Changes:**

- Update scanning/review queue to include `emit` and skip `pure` unless explicitly requested.
- Update `--review-next` and `--review-tui` suggestions and key mappings for `emit`.
- Add promotion support for reviewed `emit` callables.

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`
- `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`

**Commit message:**

- `feat: support emit in review and promotion`

#### Notes

- Status: Done (2026-03-07)
- Summary: Updated session-review scanning, one-key review actions, and promotion planning so `emit` is first-class in review/promote flows while `pure` remains suppressed by default unless `--include-pure` is provided.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`
- Follow-ups: Phase 4 should document `--include-pure`, emit decision guidance, and emit promotion destinations in README/operator docs.
- Commit: `12d1983`
- PR/Jira: None

#### Follow-up Notes

- Status: Done (2026-03-07)
- Summary: Extended scorer confidence storage/output to include full taxonomy confidences (`read`, `write`, `emit`, `exec`, `pure`, `unknown`) with legacy read/write compatibility, and updated default `y`/`n` suggestions to default to `read`/`write`/`emit`/`ignore`/`pure` (no automatic `needs-code`).
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed (working tree)
- PR/Jira: None

#### Follow-up Notes (TUI readability)

- Status: Done (2026-03-07)
- Summary: Improved review TUI readability by adding ANSI syntax highlighting for Python snippets and stronger current-call emphasis (focused gutter marker plus highlighted `[[call]]` token).
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed (working tree)
- PR/Jira: None

#### Follow-up Notes (review default tightening)

- Status: Done (2026-03-08)
- Summary: Tightened the default review queue back to unresolved `unknown` callables only, added opt-in `--include-emit` support for auditing rule-backed emit callables, and verified that promoted emit callables no longer reappear in default review runs.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

#### Follow-up Notes (TUI responsiveness)

- Status: Done (2026-03-07)
- Summary: Added transient processing status feedback in the review TUI so operators can see immediate response while saving a decision and loading/rescoring the next candidate.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed (working tree)
- PR/Jira: None

#### Follow-up Notes (Callable reuse)

- Status: Done (2026-03-07)
- Summary: Updated review/promotion behavior so a recorded, consistent callable decision is reused across later snippet contexts for the same callable, avoiding repeated classification of calls such as `print` while leaving conflicting call histories reviewable.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed (working tree)
- PR/Jira: None

#### Follow-up Notes (TUI full-page default)

- Status: Done (2026-03-08)
- Summary: Changed the review TUI to open with the full code page visible by default while keeping `v` as a toggle back to the focused-window view around the active call.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`, `docs/plans/49-python-action-taxonomy-emit-pure.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed (working tree)
- PR/Jira: None

### Phase 4 - Docs and operator guidance

**Goal:** Document the new taxonomy clearly.

**Files:**

- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan

**Changes:**

- Document category definitions and decision guidance.
- Document updated review controls and promotion rules for `emit`.
- Clarify that `pure` is analyzer-visible but excluded from permission/review by default.

**Validation:**

- `cd .opencode && bun test`
- `cd .opencode && bun run ../src/python-session-report.ts --help`

**Commit message:**

- `docs: describe expanded python action taxonomy`

#### Notes

- Status: Done (2026-03-07)
- Summary: Updated README and operator guidance to document the expanded taxonomy, emit decision controls, `--include-pure` behavior, and emit-aware promotion destinations.
- Files: `README.md`, `docs/python-session-report-operator-guide.md`, `docs/plans/49-python-action-taxonomy-emit-pure.md`
- Tests: `cd .opencode && bun test`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: None
- Commit: `bc26adc`
- PR/Jira: None

## Acceptance Criteria

- Analyzer can emit `emit` and `pure` categories.
- Runtime permission policy remains safe and predictable with `pure` excluded.
- Review loop supports `emit` as a first-class decision/promotion path.
- Operators have clear definitions and examples for each category.

## Risks and Mitigations

- **Risk:** `emit` and `write` confusion for APIs that both signal and mutate.
  - **Mitigation:** default such calls to `write` unless strongly non-mutating.
- **Risk:** over-broad `pure` suppression hiding meaningful events.
  - **Mitigation:** keep a debug/report switch to include `pure` when needed.
- **Risk:** breaking existing review controls.
  - **Mitigation:** preserve existing keys; add one dedicated key for `emit` and regression coverage.

## Phase Status

- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
