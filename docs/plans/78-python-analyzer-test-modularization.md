---
title: Python Analyzer Test Modularization
status: done
plan_type: build
plan: 78-python-analyzer-test-modularization
created: 2026-03-27
updated: 2026-03-27
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/testing
  - topic/python-analyzer
  - topic/refactoring
---

# Python Analyzer Test Modularization

## Objective

Break `.opencode/test/python-analyze.test.ts` into smaller, focused analyzer test files while preserving existing test semantics, keeping Bun test discovery simple, and avoiding new shared-state coupling between suites.

## Scope

### In Scope

- `.opencode/test/python-analyze.test.ts`
- new analyzer test files under `.opencode/test/`
- optional shared analyzer-test helper modules under `.opencode/test/fixtures/`
- `README.md`
- `docs/python-classification-system-design.md`
- `docs/python-custom-tool-plan.md`
- this plan file

### Out of Scope

- changing analyzer behavior in `src/python/*.ts`
- broad assertion rewrites beyond what is needed to move suites safely
- changing runtime permission test layout in `.opencode/test/python-inline-permissions-*.test.ts`
- introducing nested analyzer test directories beyond `fixtures/`
- renaming existing test titles unless a later cleanup phase explicitly does so

## Design Direction

The split should follow analyzer-domain seams that already exist in the monolith instead of slicing by arbitrary line count. The current file naturally groups into parity and loader behavior, filesystem/path effects, core pure-call provenance, library-specific pure-call families, exec/network classification, SDK/integration coverage, and conservative fallback behavior. Keeping those seams intact reduces merge risk and keeps later analyzer work local to one test host.

### Target file layout

- `.opencode/test/python-analyze-parity.test.ts`
  - analyzer metadata/evidence smoke tests plus Phase 1 parity fixtures
- `.opencode/test/python-analyze-rules-loading.test.ts`
  - `OPENCODE_PYTHON_RULES` env and temp-file loader coverage
- `.opencode/test/python-analyze-paths-io.test.ts`
  - `open()`, `Path`, `os`/`shutil`, and JSON/YAML IO coverage
- `.opencode/test/python-analyze-pure-core.test.ts`
  - core emit/pure classification and provenance-heavy receiver tracking
- `.opencode/test/python-analyze-library-pure.test.ts`
  - `inspect`, `datetime`, `time`, `calendar`, `Counter`, `hashlib`, `zlib`, and `difflib`
- `.opencode/test/python-analyze-exec-network.test.ts`
  - exec classification plus network/db/tempfile/deserialization coverage
- `.opencode/test/python-analyze-integrations.test.ts`
  - GitHub, model-dump, tabulate, RequestInformation, OCI, GHAPI, and Atlassian coverage
- `.opencode/test/python-analyze-fallbacks.test.ts`
  - edge cases, fallback behavior, decorators, and nested-context detection
- optional `.opencode/test/fixtures/python-analyze.ts`
  - only if at least two split files share a helper worth centralizing; keep the shared surface small

### Split constraints

- keep flat `python-analyze-*.test.ts` naming to match existing repo conventions
- preserve current `it(...)` titles unless a rename materially improves discoverability
- keep `describe("python analyzer")` as the shared top-level host in each split file
- keep rules-loading env mutation isolated in its own file; do not share `OPENCODE_PYTHON_RULES` setup through global hooks
- keep parity helper logic local unless more than one split file needs it
- retire `.opencode/test/python-analyze.test.ts` only after moved-suite counts and focused/full Bun runs stay green

## Commit-Safe Phases

### Phase 1 - Split parity and rules-loading suites

**Goal:** Peel off the lowest-risk suites first and establish the split pattern.

**Pre-step - capture baseline inventory:**

- run `cd .opencode && bun test test/python-analyze.test.ts`
- record baseline count before moving suites (current baseline at plan start: 273 tests)

**Files:**

- `.opencode/test/python-analyze.test.ts`
- new `.opencode/test/python-analyze-parity.test.ts`
- new `.opencode/test/python-analyze-rules-loading.test.ts`
- this plan file

**Changes:**

- move analyzer metadata/evidence smoke tests and `phase 1 parity fixtures` into `python-analyze-parity.test.ts`
- move `rules file loading` into `python-analyze-rules-loading.test.ts`
- keep `stripEvidence()` local to the parity file unless another split file needs it
- trim now-unused imports from the remaining monolith without changing surviving tests

**Validation:**

- `cd .opencode && bun test test/python-analyze-parity.test.ts`
- `cd .opencode && bun test test/python-analyze-rules-loading.test.ts`
- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: split python analyzer parity tests`

#### Notes
- Status: Done (2026-03-27)
- Summary: Split the analyzer metadata/evidence smoke coverage plus Phase 1 parity fixtures into `.opencode/test/python-analyze-parity.test.ts` and isolated rules-loader coverage in `.opencode/test/python-analyze-rules-loading.test.ts`, leaving `.opencode/test/python-analyze.test.ts` with the remaining 249 suites. Baseline accounting stays intact at `249 + 17 + 7 = 273` tests.
- Files: `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-analyze-parity.test.ts`, `.opencode/test/python-analyze-rules-loading.test.ts`, `docs/plans/78-python-analyzer-test-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze-parity.test.ts` (17 pass); `cd .opencode && bun test test/python-analyze-rules-loading.test.ts` (7 pass); `cd .opencode && bun test test/python-analyze.test.ts` (249 pass); `cd .opencode && bun test` (fails in pre-existing `test/python-session-report.test.ts` `hashlib.sha256` family-cluster expectation)
- Follow-ups: Existing full-suite failure outside the Phase 1 scope still blocks a green `cd .opencode && bun test`. Phase 2 should peel off the path and IO suites next.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Split path and IO classifier suites

**Goal:** Isolate filesystem-oriented analyzer coverage into a dedicated test host.

**Files:**

- `.opencode/test/python-analyze.test.ts`
- new `.opencode/test/python-analyze-paths-io.test.ts`
- this plan file

**Changes:**

- move `open() mode and path handling`, `Path method classification`, `os/shutil write classification`, and `json/yaml classification` into `python-analyze-paths-io.test.ts`
- keep table-driven Path method cases together with the surrounding path provenance assertions
- preserve current titles and source snippets verbatim where possible

**Validation:**

- `cd .opencode && bun test test/python-analyze-paths-io.test.ts`
- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: split python analyzer path and io tests`

#### Notes
- Status: Done (2026-03-27)
- Summary: Moved the top-of-file path and IO suites into `.opencode/test/python-analyze-paths-io.test.ts`, preserving the existing `describe(...)` blocks verbatim so the broader Path-seeded provenance cases stayed attached to the `Path method classification` host. The remaining monolith now starts at `emit and pure classification` with 209 tests, while the new path/IO host carries 40 tests.
- Files: `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-analyze-paths-io.test.ts`, `docs/plans/78-python-analyzer-test-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts` (249 pass pre-split baseline); `cd .opencode && bun test test/python-analyze-paths-io.test.ts` (40 pass); `cd .opencode && bun test test/python-analyze.test.ts` (209 pass); `cd .opencode && bun test` (569 pass)
- Follow-ups: Phase 3 should peel off the pure-call and library-focused suites next. Some generic pure/builtin coverage intentionally remains in the new path/IO host because it is still seeded by tracked `Path` reads; revisit that boundary only if later pure-suite extraction can do so without splitting the current Path provenance block apart.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Split core and library pure-call suites

**Goal:** Break the largest provenance-heavy pure-call coverage into focused files.

**Files:**

- `.opencode/test/python-analyze.test.ts`
- new `.opencode/test/python-analyze-pure-core.test.ts`
- new `.opencode/test/python-analyze-library-pure.test.ts`
- optional `.opencode/test/fixtures/python-analyze.ts`
- this plan file

**Changes:**

- move `emit and pure classification` into `python-analyze-pure-core.test.ts`
- move `inspect`, `datetime`, `time and zoneinfo`, `calendar and os.path`, `collections.Counter`, `hashlib`, both `zlib` blocks, and `difflib` into `python-analyze-library-pure.test.ts`
- extract a shared fixture only if duplicate helper code appears in more than one new file

**Validation:**

- `cd .opencode && bun test test/python-analyze-pure-core.test.ts`
- `cd .opencode && bun test test/python-analyze-library-pure.test.ts`
- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: split python analyzer pure classification tests`

#### Notes
- Status: Done (2026-03-27)
- Summary: Split the largest pure-call coverage out of the monolith by moving `emit and pure classification` into `.opencode/test/python-analyze-pure-core.test.ts` and the library-focused pure suites into `.opencode/test/python-analyze-library-pure.test.ts`. No shared analyzer-test fixture was needed; the remaining monolith now begins at `github classification` with 113 tests.
- Files: `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-analyze-pure-core.test.ts`, `.opencode/test/python-analyze-library-pure.test.ts`, `docs/plans/78-python-analyzer-test-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts` (209 pass pre-split baseline); `cd .opencode && bun test test/python-analyze-pure-core.test.ts` (67 pass); `cd .opencode && bun test test/python-analyze-library-pure.test.ts` (29 pass); `cd .opencode && bun test test/python-analyze.test.ts` (113 pass); `cd .opencode && bun test` (569 pass)
- Follow-ups: Phase 4 should move the remaining exec, integration, and fallback suites next. Keep the duplicate `zlib classification` host names unchanged until a later cleanup pass so failure triage remains behavior-preserving through the modularization work.
- Commit: Not committed
- PR/Jira: None

### Phase 4 - Split exec, integrations, and fallback suites; retire the monolith

**Goal:** Move the remaining domain-specific suites out of the monolith and delete the old host file.

**Files:**

- `.opencode/test/python-analyze.test.ts`
- new `.opencode/test/python-analyze-exec-network.test.ts`
- new `.opencode/test/python-analyze-integrations.test.ts`
- new `.opencode/test/python-analyze-fallbacks.test.ts`
- this plan file

**Changes:**

- move `exec classification` and `phase 5 network/db/tempfile/deserialization` into `python-analyze-exec-network.test.ts`
- move SDK and integration coverage into `python-analyze-integrations.test.ts`
- move `edge cases and fallbacks` plus `decorator and nested contexts` into `python-analyze-fallbacks.test.ts`
- delete `.opencode/test/python-analyze.test.ts` once the moved-suite counts still sum to the baseline and focused/full Bun runs pass

**Validation:**

- `cd .opencode && bun test test/python-analyze-exec-network.test.ts`
- `cd .opencode && bun test test/python-analyze-integrations.test.ts`
- `cd .opencode && bun test test/python-analyze-fallbacks.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: modularize python analyzer test suites`

#### Notes
- Status: Done (2026-03-27)
- Summary: Retired `.opencode/test/python-analyze.test.ts` by moving the remaining 113 tests into `.opencode/test/python-analyze-exec-network.test.ts`, `.opencode/test/python-analyze-integrations.test.ts`, and `.opencode/test/python-analyze-fallbacks.test.ts`. The broader historical `phase 5 network/db/tempfile/deserialization` block stays intact inside the exec/network host so Phase 4 remains a pure file move rather than a behavioral reshuffle.
- Files: `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-analyze-exec-network.test.ts`, `.opencode/test/python-analyze-integrations.test.ts`, `.opencode/test/python-analyze-fallbacks.test.ts`, `docs/plans/78-python-analyzer-test-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts` (113 pass pre-split baseline); `cd .opencode && bun test test/python-analyze-exec-network.test.ts` (43 pass); `cd .opencode && bun test test/python-analyze-integrations.test.ts` (28 pass); `cd .opencode && bun test test/python-analyze-fallbacks.test.ts` (42 pass); `cd .opencode && bun test` (569 pass)
- Follow-ups: Phase 5 should update stale docs and command references that still point at `.opencode/test/python-analyze.test.ts`. The new exec/network host is intentionally broader than its name suggests because the historical Phase 5 block includes a few non-network fallback and purity cases that remain safer to move intact.
- Commit: Not committed
- PR/Jira: None

### Phase 5 - Refresh docs and test inventory references

**Goal:** Remove stale references to the analyzer test monolith and document the split layout.

**Files:**

- `README.md`
- `docs/python-classification-system-design.md`
- `docs/python-custom-tool-plan.md`
- this plan file

**Changes:**

- replace monolith references with the split analyzer file set
- document any shared analyzer-test fixture introduced during earlier phases
- update the plan notes and final status once the split is complete

**Validation:**

- doc read-through
- `cd .opencode && bun test`

**Suggested commit message:**

- `docs: describe split python analyzer tests`

#### Notes
- Status: Done (2026-03-27)
- Summary: Updated the current docs to describe the split analyzer test layout instead of the retired `.opencode/test/python-analyze.test.ts` monolith. `README.md`, `docs/python-classification-system-design.md`, and the current-layout sections of `docs/python-custom-tool-plan.md` now point contributors to the focused `python-analyze-*.test.ts` files and matching validation commands.
- Files: `README.md`, `docs/python-classification-system-design.md`, `docs/python-custom-tool-plan.md`, `docs/plans/78-python-analyzer-test-modularization.md`
- Tests: doc read-through; `cd .opencode && bun test` (569 pass)
- Follow-ups: Historical plan notes in `docs/python-custom-tool-plan.md` may still mention the old monolith where they describe pre-split history, but current-state inventory and verification guidance now use the split analyzer files.
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- no single replacement analyzer test file remains monolithic on the current scale of `.opencode/test/python-analyze.test.ts`
- Bun still discovers and runs the full analyzer suite via `cd .opencode && bun test`
- analyzer assertions remain semantically unchanged apart from file movement
- shared helper behavior is centralized only when it reduces duplication without adding cross-file state risk
- docs no longer describe `.opencode/test/python-analyze.test.ts` as the sole analyzer regression host

## Phase Status

- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
- Phase 5: DONE
