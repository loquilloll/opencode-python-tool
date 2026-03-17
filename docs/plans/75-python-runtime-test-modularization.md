---
title: Python Runtime Test Modularization
status: done
plan_type: build
plan: 75-python-runtime-test-modularization
created: 2026-03-16
updated: 2026-03-17
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/testing
  - topic/refactoring
  - topic/python-runtime
---

# Python Runtime Test Modularization

## Objective

Break `.opencode/test/python.test.ts` into smaller, focused runtime test files while preserving existing test semantics, keeping Bun test discovery simple, and avoiding new shared-state coupling between suites.

## Scope

### In Scope

- `.opencode/test/python.test.ts`
- new runtime test files under `.opencode/test/`
- new shared runtime-test helper module(s) under `.opencode/test/fixtures/`
- `README.md`
- `docs/python-custom-tool-plan.md`
- this plan file

### Out of Scope

- changing runtime behavior in `src/python.ts`
- changing analyzer behavior or coverage in `src/python/python-*`
- broad test assertion rewrites beyond what is needed to move suites safely
- renaming existing analyzer/session-report test files
- introducing a new nested test directory structure beyond `fixtures/`

## Design Direction

The split should follow runtime-behavior seams that already exist in the monolith instead of slicing by arbitrary line count. The current file naturally groups into validation, inline permission planning, script/external-directory boundary behavior, and real process execution. Keeping those seams intact reduces merge risk and makes future reviews more local.

### Target file layout

- `.opencode/test/fixtures/python-runtime.ts`
  - shared helpers/constants extracted from the former `python.test.ts` monolith and now imported by the split runtime files
  - `INVALID_PYTHON_BIN`, `HAS_PYTHON3`, `toSlash`, `withWorkspace`, `getAsk`, `getAskMetadata`, `executeExpectingEnoent`
  - `collectInlinePermissionParity` now lives in `.opencode/test/python-inline-permissions-basic.test.ts` with its sole parity-fixture consumer set
- `.opencode/test/python-validation.test.ts`
  - arg validation, subprocess hard-fail, ENOENT text, other small runtime-guard cases
- `.opencode/test/python-inline-permissions-basic.test.ts`
  - preview metadata, literal read auto-allow, pure/emit/non-blocking behavior, parity smoke fixtures, low-coupling permission-shape tests
- `.opencode/test/python-inline-permissions-inference.test.ts`
  - inference-heavy inline permission coverage: Path/match/string/builtin/container/json/response/self-receiver provenance, direct HTTP/request classification, and conservative guardrail cases
- `.opencode/test/python-external-directory.test.ts`
  - scriptPath permission behavior, external-directory detection, symlink/fallback boundary cases, workdir boundary asks, and temporarily colocated always-pattern checks for permission-shape cohesion
- `.opencode/test/python-runtime-execution.test.ts`
  - workdir semantics plus real execution, timeout, abort, streaming, and `HAS_PYTHON3`-gated runtime tests
- remove `.opencode/test/python.test.ts` after all sections are migrated and validated

### Split constraints

- keep flat `python-*.test.ts` naming to match existing repo conventions
- preserve current test titles unless a rename materially improves discoverability
- avoid `beforeEach`/`afterEach` env mutation shared across files; keep local `try/finally` restoration for `OPENCODE_PYTHON_BIN`
- keep the real-execution `HAS_PYTHON3` gate attached only to the execution-focused file
- keep boundary/fallback tests close to script/workdir/external-directory suites rather than mixing them into generic execution tests
- keep parity helper logic local unless at least two split files need it; prefer a small shared helper surface over a large all-purpose fixture module

## Commit-Safe Phases

### Phase 1 - Extract shared runtime-test helpers

**Goal:** Create a stable helper seam before moving suites.

**Files:**

- `.opencode/test/python.test.ts`
- new `.opencode/test/fixtures/python-runtime.ts`
- this plan file

**Changes:**

- move the shared helper/constants block out of the top of `python.test.ts`
- keep helper signatures and behavior unchanged so this phase is pure extraction
- leave all tests in `python.test.ts` for this phase; only imports change

**Validation:**

- `cd .opencode && bun test test/python.test.ts`

**Suggested commit message:**

- `refactor: extract python runtime test helpers`

#### Notes
- Status: Done (2026-03-17)
- Summary: Extracted the shared runtime test helper/constants block into `.opencode/test/fixtures/python-runtime.ts` and rewired `.opencode/test/python.test.ts` to import it. `collectInlinePermissionParity()` stays local in the monolith for now so Phase 1 remains a pure helper extraction.
- Files: `.opencode/test/fixtures/python-runtime.ts`, `.opencode/test/python.test.ts`
- Tests: `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test`
- Follow-ups: Capture the Phase 2 baseline inventory before moving any suites.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Split validation and execution-lifecycle suites

**Pre-step — capture baseline inventory:**

Before any test moves, run `cd .opencode && bun test test/python.test.ts 2>&1` and record:
- total test count (currently 116)
- full list of `describe` → `it` titles (copy from terminal output or use `--reporter=json` if available)

This inventory is the source of truth for verifying no tests are silently dropped or renamed across all later phases.

**Goal:** Peel off the smallest, least-coupled suites first.

**Files:**

- `.opencode/test/python.test.ts`
- new `.opencode/test/python-validation.test.ts`
- new `.opencode/test/python-runtime-execution.test.ts`
- this plan file

**Changes:**

- move `arg validation` (5 tests), `subprocess hard-fail` (2 tests), `ENOENT handling` (1 test), and similar small guard suites into `python-validation.test.ts`
- move the `"workdir semantics"` describe block (2 tests) into `python-runtime-execution.test.ts`
- move the `HAS_PYTHON3`-gated `"process execution, timeout, abort, and streaming"` describe block (7 tests) into the same file
- preserve local env-var restoration patterns in each moved test
- keep `python.test.ts` as the temporary host for the remaining permission-planning suites
- capture a pre-split inventory of test titles/counts for the moved suites so later phases can detect silent drops or renames

**Validation:**

- `cd .opencode && bun test test/python-validation.test.ts`
- `cd .opencode && bun test test/python-runtime-execution.test.ts`
- `cd .opencode && bun test`
- compare moved test titles/counts against the pre-split inventory before deleting any source block

**Suggested commit message:**

- `refactor: split python runtime validation and execution tests`

#### Notes
- Status: Done (2026-03-17)
- Summary: Split the validation/guard suites into `.opencode/test/python-validation.test.ts` and moved workdir plus gated execution-lifecycle coverage into `.opencode/test/python-runtime-execution.test.ts`. `.opencode/test/python.test.ts` now retains the remaining permission-planning and boundary suites for later phases.
- Files: `.opencode/test/python.test.ts`, `.opencode/test/python-validation.test.ts`, `.opencode/test/python-runtime-execution.test.ts`
- Tests: `cd .opencode && bun test test/python.test.ts 2>&1`; `cd .opencode && bun test test/python-validation.test.ts`; `cd .opencode && bun test test/python-runtime-execution.test.ts`; `cd .opencode && bun test`
- Inventory: Pre-split baseline `bun test test/python.test.ts` recorded 116 tests; post-split parity is `.opencode/test/python.test.ts` = 99, `.opencode/test/python-validation.test.ts` = 8, `.opencode/test/python-runtime-execution.test.ts` = 9, for the same 116-test total.
- Validation titles: `arg validation` -> `errors when neither code nor scriptPath is provided`, `errors when both code and scriptPath are provided`, `errors for negative and zero timeout`, `errors for empty inline code`, `errors for empty script file`; `subprocess hard-fail` -> `fails immediately for inline subprocess usage without permission asks`, `fails immediately for script subprocess usage without permission asks`; `ENOENT handling` -> `returns friendly invalid OPENCODE_PYTHON_BIN error`.
- Execution titles: `workdir semantics` -> `resolves relative workdir from context.directory`, `honors absolute workdir as-is`; `process execution, timeout, abort, and streaming` -> `returns hello output`, `includes Exit code metadata for non-zero exits`, `passes args to inline code`, `executes scriptPath correctly`, `reports timeout metadata`, `handles pre-aborted and in-flight aborts`, `streams metadata incrementally and caps metadata output`.

##### Baseline Inventory Snapshot (116 tests)

```text
FILE python-validation.test.ts
- arg validation -> errors when neither code nor scriptPath is provided
- arg validation -> errors when both code and scriptPath are provided
- arg validation -> errors for negative and zero timeout
- arg validation -> errors for empty inline code
- arg validation -> errors for empty script file
- subprocess hard-fail -> fails immediately for inline subprocess usage without permission asks
- subprocess hard-fail -> fails immediately for script subprocess usage without permission asks
- ENOENT handling -> returns friendly invalid OPENCODE_PYTHON_BIN error

FILE python.test.ts
- permission patterns (inline code) -> includes inline code preview metadata in python ask
- permission patterns (inline code) -> truncates large inline source preview deterministically
- permission patterns (inline code) -> omits expanded source metadata when source exceeds 50KB
- permission patterns (inline code) -> auto-allows literal read paths inside the worktree and keeps read metadata
- permission patterns (inline code) -> asks for exec call
- permission patterns (inline code) -> includes multiple write patterns
- permission patterns (inline code) -> uses no-calls fallback ask
- permission patterns (inline code) -> uses callable unknown ask pattern
- permission patterns (inline code) -> skips python ask for emit-only code and keeps emit operations in runtime metadata
- permission patterns (inline code) -> keeps analyzer metadata consistent for large-script fallback
- permission patterns (inline code) -> skips python ask for pure-only code and keeps pure operations in runtime metadata
- permission patterns (inline code) -> skips python ask for pure-only ast helpers and keeps canonical pure metadata
- permission patterns (inline code) -> skips python ask for pure-only unittest.mock helpers and keeps pure metadata
- permission patterns (inline code) -> skips python ask for tracked Path aliases, match methods, and exact path joins
- permission patterns (inline code) -> adds canonical source and guard metadata to runtime operations without changing permission patterns
- permission patterns (inline code) -> tracks dynamic and receiver-assigned Path provenance in runtime permission metadata
- permission patterns (inline code) -> tracks parenthesized Path read_bytes receivers into bytes decode chains in runtime metadata
- permission patterns (inline code) -> tracks zero-arg local factories that return Path values in runtime permission metadata
- permission patterns (inline code) -> phase 1 runtime parity smoke fixtures -> preserves tracked path and guarded metadata projection
- permission patterns (inline code) -> phase 1 runtime parity smoke fixtures -> preserves direct-import HTTP projection
- permission patterns (inline code) -> phase 1 runtime parity smoke fixtures -> preserves assignment invalidation projection
- permission patterns (inline code) -> phase 1 runtime parity smoke fixtures -> preserves parse-error projection
- permission patterns (inline code) -> phase 1 runtime parity smoke fixtures -> preserves no-calls-detected projection
- permission patterns (inline code) -> keeps arbitrary group and path-like receivers on unknown permission patterns
- permission patterns (inline code) -> skips python review noise for bounded iterated Path receivers
- permission patterns (inline code) -> keeps unbound join calls on unknown permission patterns
- permission patterns (inline code) -> skips python ask for tracked in-memory container mutation
- permission patterns (inline code) -> skips python ask for comprehension-backed containers and pure dict factories
- permission patterns (inline code) -> skips python ask for all standard string methods on tracked text values
- permission patterns (inline code) -> skips python ask for tracked string self-reassignment
- permission patterns (inline code) -> keeps arbitrary and unsupported string-like receivers on unknown permission patterns
- permission patterns (inline code) -> skips python ask for bounded loop variables from string split helpers
- permission patterns (inline code) -> keeps unsupported loop string provenance on unknown permission patterns
- permission patterns (inline code) -> skips python ask for tracked built-in type methods beyond strings
- permission patterns (inline code) -> keeps unsupported built-in type method receivers conservative while allowing tracked decode chains on permission patterns
- permission patterns (inline code) -> keeps shadowed built-in type constructors from seeding tracked methods on unknown permission patterns
- permission patterns (inline code) -> keeps Path replace on write permission patterns
- permission patterns (inline code) -> classifies builtin-page calls with bounded permission categories
- permission patterns (inline code) -> keeps shadowed and special-case builtins on unknown permission patterns
- permission patterns (inline code) -> skips python ask for common unshadowed builtin helpers
- permission patterns (inline code) -> skips python ask for direct temporary builtin and json container receiver methods
- permission patterns (inline code) -> keeps unseeded subscript and attribute receiver container methods on unknown permission patterns
- permission patterns (inline code) -> skips python ask for exact same-scope subscript and attribute receiver containers
- permission patterns (inline code) -> skips python ask for common receiver paths with one-hop attribute deps and shallow nested attributes
- permission patterns (inline code) -> keeps deeper attribute index dependencies on unknown permission patterns
- permission patterns (inline code) -> skips python ask for tracked same-scope self attribute container methods
- permission patterns (inline code) -> keeps reassigned or shadowed self attribute container methods on unknown permission patterns
- permission patterns (inline code) -> keeps common receiver-path containers on unknown permission patterns after dependency rebinding or excluded shapes
- permission patterns (inline code) -> keeps shadowed, callback-customized, and unresolved builtin helpers on unknown permission patterns
- permission patterns (inline code) -> skips python ask for standard builtin exception raises
- permission patterns (inline code) -> keeps shadowed and custom raise targets on unknown permission patterns
- permission patterns (inline code) -> keeps rebound standard exception names on unknown permission patterns
- permission patterns (inline code) -> keeps shadowed dict.fromkeys on unknown permission patterns
- permission patterns (inline code) -> keeps parameter-shadowed dict.fromkeys on unknown permission patterns
- permission patterns (inline code) -> keeps imported dict.fromkeys on unknown permission patterns
- permission patterns (inline code) -> skips python ask for json-derived in-memory container mutation
- permission patterns (inline code) -> skips python ask for json-derived iteration item access
- permission patterns (inline code) -> skips python ask for tracked-response json fallback and derived iteration
- permission patterns (inline code) -> keeps arbitrary and customized response json access on unknown permission patterns
- permission patterns (inline code) -> keeps shadowed tracked response names on unknown permission patterns
- permission patterns (inline code) -> keeps customized json decoder container methods on unknown permission patterns
- permission patterns (inline code) -> keeps emit non-blocking when mixed with write patterns
- permission patterns (inline code) -> keeps pure non-blocking when mixed with unknown patterns
- permission patterns (inline code) -> asks read permissions for direct HTTP reads
- permission patterns (inline code) -> asks write permissions for direct HTTP writes
- permission patterns (inline code) -> asks read/write permissions for bounded from-import HTTP helpers
- permission patterns (inline code) -> asks read/write permissions for tracked HTTP client instance methods
- permission patterns (inline code) -> asks read/write permissions for bounded HTTP request(method) calls
- permission patterns (inline code) -> asks read/write permissions for tracked private HTTP transport request calls
- permission patterns (inline code) -> keeps dynamic or unrelated request calls on unknown permission patterns
- permission patterns (inline code) -> keeps unsupported literal request methods on unknown permission patterns
- script-file permission behavior -> includes script code preview metadata when a script still needs a python ask
- script-file permission behavior -> does not ask external_directory when script is inside worktree
- script-file permission behavior -> does not ask external_directory when a symlinked script still resolves inside the worktree
- script-file permission behavior -> asks external_directory when script path is outside worktree
- script-file permission behavior -> asks external_directory before reading a symlinked outside script path
- script-file permission behavior -> asks external_directory for script paths that escape through symlink plus dotdot
- script-file permission behavior -> falls back conservatively to external_directory when script boundary resolution fails
- script-file permission behavior -> falls back conservatively to external_directory when script boundary resolution hits ENOTDIR
- script-file permission behavior -> asks external_directory for literal outside paths in script
- external directory detection -> reuses permission code preview metadata in external_directory ask
- external directory detection -> asks when workdir is outside worktree
- external directory detection -> asks external_directory when workdir is a symlink into an outside directory
- external directory detection -> asks external_directory when workdir escapes through symlink plus dotdot
- external directory detection -> falls back conservatively to external_directory when workdir boundary resolution fails
- external directory detection -> falls back conservatively to external_directory when workdir boundary resolution hits ENOTDIR
- external directory detection -> asks external_directory without python ask for emit-only outside workdir
- external directory detection -> does not ask external_directory when workdir is inside worktree
- external directory detection -> does not ask external_directory when a symlinked workdir still resolves inside the worktree
- external directory detection -> asks external_directory for inline literal outside path
- external directory detection -> does not ask external_directory for literal reads through an in-worktree symlink that stays inside
- external directory detection -> asks external_directory for literal reads through an in-worktree symlink to outside
- external directory detection -> asks external_directory for symlink plus dotdot literal reads that resolve outside the worktree
- external directory detection -> falls back conservatively to external_directory on boundary-resolution errors
- external directory detection -> falls back conservatively to external_directory for literal reads when boundary resolution hits ENOTDIR
- always pattern checks -> includes read wildcard for dynamic read paths
- always pattern checks -> includes exec module wildcard
- always pattern checks -> includes callable unknown specific always pattern
- always pattern checks -> uses unknown:* for parser/meta unknown events

FILE python-runtime-execution.test.ts
- workdir semantics -> resolves relative workdir from context.directory
- workdir semantics -> honors absolute workdir as-is
- process execution, timeout, abort, and streaming -> returns hello output
- process execution, timeout, abort, and streaming -> includes Exit code metadata for non-zero exits
- process execution, timeout, abort, and streaming -> passes args to inline code
- process execution, timeout, abort, and streaming -> executes scriptPath correctly
- process execution, timeout, abort, and streaming -> reports timeout metadata
- process execution, timeout, abort, and streaming -> handles pre-aborted and in-flight aborts
- process execution, timeout, abort, and streaming -> streams metadata incrementally and caps metadata output
```
- Follow-ups: Phase 3 should move the remaining scriptPath/workdir external-directory suites and keep always-pattern checks with that boundary-focused file.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Split script and external-directory boundary coverage

**Goal:** Isolate scriptPath/workdir/external-directory behavior into its own test file.

**Files:**

- `.opencode/test/python.test.ts`
- new `.opencode/test/python-external-directory.test.ts`
- this plan file

**Changes:**

- move `script-file permission behavior`, `external directory detection`, `always pattern checks`, and workdir-boundary-specific suites into `python-external-directory.test.ts`
- `always pattern checks` stays here for now because it exercises the same permission-shape wiring as the boundary host file, even though the individual cases are generic inline `python`-ask coverage; keeping them colocated avoids splitting related permission-shape assertions mid-modularization
- keep the symlink, symlink-plus-`..`, `ELOOP`, and `ENOTDIR` fallback regressions together in that file
- preserve any tests that intentionally override `context.ask` to prove approval ordering or fail-closed behavior

**Validation:**

- `cd .opencode && bun test test/python-external-directory.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: split python boundary permission tests`

#### Notes
- Status: Done (2026-03-17)
- Summary: Moved the scriptPath/workdir/external-directory boundary coverage into `.opencode/test/python-external-directory.test.ts`, including the symlink, symlink-plus-`..`, `ELOOP`, `ENOTDIR`, and `context.ask` override regressions. `.opencode/test/python.test.ts` now retains only the inline permission-planning suites for later phases.
- Files: `.opencode/test/python.test.ts`, `.opencode/test/python-external-directory.test.ts`
- Tests: `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test test/python-external-directory.test.ts`; `cd .opencode && bun test`
- Inventory: Pre-split remaining-monolith baseline was 99 tests in `.opencode/test/python.test.ts`; post-split parity is `.opencode/test/python.test.ts` = 71 and `.opencode/test/python-external-directory.test.ts` = 28. Moved titles match the Phase 2 baseline inventory snapshot recorded above.
- Follow-ups: Phase 4 should peel off preview metadata, simple ask/no-ask behavior, non-blocking pure/emit cases, and parity smoke fixtures while keeping `collectInlinePermissionParity()` local with its sole consumer.
- Commit: Not committed
- PR/Jira: None

### Phase 4 - Split inline permission basics and parity fixtures

**Goal:** Remove the low-risk inline permission cases from the monolith while keeping the inference-heavy middle band separate.

**Files:**

- `.opencode/test/python.test.ts`
- new `.opencode/test/python-inline-permissions-basic.test.ts`
- this plan file

**Changes:**

- move preview metadata tests, simple ask/no-ask behavior, non-blocking pure/emit cases, and the parity smoke fixtures into `python-inline-permissions-basic.test.ts`
- keep late non-blocking mixed-permission cases such as emit/write and pure/unknown with the basic file even if they currently live near the end of the inline block
- keep `collectInlinePermissionParity()` local here if no other file needs it
- leave only the inference-heavy inline suites in `python.test.ts` after this phase

**Validation:**

- `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: split basic python inline permission tests`

#### Notes
- Status: Done (2026-03-17)
- Summary: Moved the low-coupling inline preview/basic permission tests into `.opencode/test/python-inline-permissions-basic.test.ts` and moved `collectInlinePermissionParity()` with its parity smoke fixtures so the helper stays local to its sole consumer. `.opencode/test/python.test.ts` now holds only the inference-heavy inline suites for Phase 5.
- Files: `.opencode/test/python.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`
- Tests: `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test`
- Inventory: Pre-split inline monolith baseline was 71 tests in `.opencode/test/python.test.ts`; post-split parity is `.opencode/test/python-inline-permissions-basic.test.ts` = 20 and `.opencode/test/python.test.ts` = 51.
- Moved coverage: preview metadata (3), simple ask/no-ask behavior (5), non-blocking pure/emit basics plus large-script analyzer metadata (5), `phase 1 runtime parity smoke fixtures` (5), and late mixed non-blocking cases for emit/write and pure/unknown (2).
- Follow-ups: Phase 5 can now move the remaining 51 inference-heavy inline suites plus the HTTP/request cases into `.opencode/test/python-inline-permissions-inference.test.ts` and retire `.opencode/test/python.test.ts`.
- Commit: Not committed
- PR/Jira: None

### Phase 5 - Split inference-heavy inline suites and retire the monolith

**Goal:** Move the remaining large runtime-permission coverage into a focused inference file and delete the old monolithic test file.

**Files:**

- `.opencode/test/python.test.ts`
- new `.opencode/test/python-inline-permissions-inference.test.ts`
- this plan file

**Changes:**

- move the remaining Path/string/builtin/container/JSON/response/self-receiver inference suites plus the inline HTTP/request cases into `python-inline-permissions-inference.test.ts`
- preserve current describe-grouping for guardrail and conservative cases so failures still point to the right runtime concept
- confirm the destination inventory matches the pre-split title/count inventory (captured in Phase 2 pre-step) before removing `.opencode/test/python.test.ts`; the sum of test counts across all split files must equal the baseline 116
- delete `.opencode/test/python.test.ts` once its last suite has moved

**Validation:**

- `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `refactor: modularize python runtime permission tests`

#### Notes
- Status: Done (2026-03-17)
- Summary: Renamed the remaining inference-only runtime suite to `.opencode/test/python-inline-permissions-inference.test.ts` and removed `.opencode/test/python.test.ts`. The moved file keeps the prior describe structure and titles intact, so the final split is now fully modular ahead of doc cleanup.
- Files: `.opencode/test/python-inline-permissions-inference.test.ts`, `.opencode/test/python.test.ts` (deleted)
- Tests: `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun test`
- Inventory: Pre-move `.opencode/test/python.test.ts` was 51 tests with SHA-256 `75ca1abbca676fcc6ff68a049a8213221edff09bf88c752efd177f903782c63d`; post-move `.opencode/test/python-inline-permissions-inference.test.ts` has the same 51-test count and identical SHA-256. Final split counts are validation 8 + execution 9 + external-directory 28 + inline-basic 20 + inline-inference 51 = baseline 116.
- Follow-ups: Phase 6 should update docs and skill references that still describe `.opencode/test/python.test.ts` as the runtime test host.
- Commit: Not committed
- PR/Jira: None

### Phase 6 - Update docs to match the new test layout

**Goal:** Remove stale references to the old single-file runtime test structure.

**Files:**

- `README.md`
- `docs/python-custom-tool-plan.md`
- `.claude/skills/python-review-pipeline/SKILL.md`
- this plan file

**Changes:**

- update test layout references that currently name `.opencode/test/python.test.ts` as the single runtime integration file
- update `.claude/skills/python-review-pipeline/SKILL.md` validation target and `bun test` command to reference the new split file set
- document the new split runtime test file set and the shared fixture location
- update plan notes/status once the split is complete

**Validation:**

- doc read-through
- `cd .opencode && bun test`

**Suggested commit message:**

- `docs: describe split python runtime tests`

#### Notes
- Status: Done (2026-03-17)
- Summary: Updated `README.md`, `docs/python-custom-tool-plan.md`, and `.claude/skills/python-review-pipeline/SKILL.md` to describe the split runtime test layout and shared runtime fixture instead of the retired `.opencode/test/python.test.ts` monolith, and marked this plan complete with final status/frontmatter cleanup.
- Files: `README.md`, `docs/python-custom-tool-plan.md`, `.claude/skills/python-review-pipeline/SKILL.md`, `docs/plans/75-python-runtime-test-modularization.md`
- Tests: `cd .opencode && bun test` (348 pass)
- Follow-ups: `docs/plans/76-python-permission-preview-provenance.md` still references `.opencode/test/python.test.ts` and should be refreshed when that plan next changes.
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- no single replacement runtime test file is monolithic on the current scale of `.opencode/test/python.test.ts`
- Bun still discovers and runs the full runtime suite via `cd .opencode && bun test`
- current permission-planning, boundary, and execution assertions remain semantically unchanged
- shared helper behavior is centralized or intentionally kept local with no duplicated env-var cleanup bugs
- `README.md`, `docs/python-custom-tool-plan.md`, and `.claude/skills/python-review-pipeline/SKILL.md` no longer describe `.opencode/test/python.test.ts` as the runtime test host

## Phase Status

- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
- Phase 5: DONE
- Phase 6: DONE
