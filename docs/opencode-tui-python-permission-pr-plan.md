# Python Permission Fullscreen Plan (TUI-First, PR-Ready)

## Objective

Implement Python permission UX in the OpenCode TUI so reviewers can:

- see a compact summary in the permission prompt body,
- toggle fullscreen with the existing `ctrl+f` behavior,
- and view the full Python source in fullscreen (not only a truncated preview),

while preserving existing permission semantics and keeping changes split into
commit-safe phases suitable for upstream PR submission.

## Scope

### In Scope

- `opencode` fork TUI permission prompt rendering (`packages/opencode/.../permission.tsx`).
- Python tool metadata shape in this repository (`src/python.ts`) to guarantee
  full-source availability for TUI rendering.
- Runtime + UI verification with `tmux-cli` using isolated config paths (no
  dependency on `~/.config/opencode`).

### Out of Scope (for this PR wave)

- App/web permission dock parity.
- Permission engine/rule semantics changes.
- New permission types.

## Hard Requirements

- Keep permission domain as `python` (do not proxy through `bash`).
- Keep existing `python` and `external_directory` ask flow semantics.
- Do not use local global config during TUI validation.
- Keep phase commits independent and reviewable.

## Current State Summary

- Phase 1 is complete in root repo commit `484f0bd`:
  `src/python.ts` now emits bounded `codeExpanded` / `codeExpandedAvailable`
  metadata with the 50 KB cap, and `.opencode` runtime tests are green.
- Phases 2-3 are complete in forked `./opencode` commits `bdc1d13` and
  `9f1bb60`: Python helper, renderer wiring, explicit `permission.python`
  schema key, and stricter Python external-directory detection are in place.
- Focused fork validation is green after dependency restore:
  `bun test test/permission-python.test.ts test/config/config.test.ts`
  => `69 pass, 0 fail`.
- Remaining implementation work is Phase 4 (isolated `tmux-cli` E2E capture)
  and Phase 5 (PR packaging + final verification).

## Design Direction

Use a two-layer metadata model with size-conscious boundaries:

1. **Summary layer (compact)**: keep current preview fields for fast glance.
2. **Expanded layer (bounded)**: add a `codeExpanded` field with the full source
   **only when truncated AND total bytes ≤ 50 KB**. When the source exceeds
   50 KB, set `codeExpandedAvailable: false` so the TUI knows full content
   exists but was intentionally omitted from metadata.
3. **When `codePreviewTruncated === false`**: `codePreview` already IS the full
   source. No extra field is needed; the TUI treats `codePreview` as complete.

This avoids unbounded metadata payloads. `AskInput.metadata` is
`{ [key: string]: any }` with zero SDK-level size validation — serialized to
JSON over IPC, stored in session state, and potentially logged. The existing
code deliberately caps preview at 4 KB / 120 lines and streaming metadata at
30 KB. An unlimited full-source field would be a design regression.

### TUI Render Precedence (two modes)

The TUI `info()` function has access to two distinct data sources:

- **`request.metadata`** — from the `ask()` call (Python tool's preview/stats).
- **`input()`** — the tool's input parameters (`code`, `scriptPath`, `args`,
  `workdir`, `description`).

**Compact view** (always):
1. `request.metadata.codePreview`
2. fallback message if none present

**Fullscreen view** (ctrl+f):
1. `request.metadata.codeExpanded` (present only when truncated + ≤ 50 KB)
2. `input().code` (inline mode — the full source the tool received)
3. `request.metadata.codePreview` (bounded fallback for very large scripts)
4. fallback message if none present

## Phase Status (2026-02-27)

- **Phase 1**: DONE (`484f0bd`)
- **Phase 2**: DONE (`bdc1d13`, refined by `9f1bb60`)
- **Phase 3**: DONE (`bdc1d13`, refined by `9f1bb60`)
- **Phase 4**: TODO (isolated `tmux-cli` manual E2E not yet captured)
- **Phase 5**: TODO (PR packaging and final pass)

## Commit-Safe Phases

### Phase 1 - Python Tool Metadata for Expanded Source (DONE)

**Goal**: Guarantee bounded full Python source is available in permission
metadata when truncation occurs.

**Preamble (branch setup)**:

- Create feature branches in both repos (`opencode-python-tool`, `./opencode`).
- Record baseline test status (`bun test` green in both).
- Record exact target files for upcoming commits.

**Files**:

- `src/python.ts`
- `.opencode/test/python.test.ts`
- (if needed) `src/python/python.txt`

**Changes**:

- Add `codeExpanded` metadata field: full source text, included only when
  `codePreviewTruncated === true` AND `totalBytes <= 50_000`.
- Add `codeExpandedAvailable` boolean: `true` when `codeExpanded` is present,
  `false` when source exceeds 50 KB (signals TUI to fall back to `input()`).
- When `codePreviewTruncated === false`, omit both fields (preview IS complete).
- Keep existing bounded preview fields for compact summary.
- Include same metadata payload for both asks:
  - `external_directory`
  - `python`

**Verification**:

- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`

**Commit message**:

- `feat: add bounded expanded-source metadata for python permission prompts`

**Parallelization**:

- Can run in parallel with Phase 2 helper extraction in `./opencode`.

**Progress**:

- Implemented in root repo commit `484f0bd`.
- Recorded validation:
  - `cd .opencode && bun test test/python.test.ts` => `37 pass, 0 fail`
  - `cd .opencode && bun test` => `74 pass, 0 fail`

---

### Phase 2 - TUI Python Permission View-Model Helper (DONE)

**Goal**: Add typed/defensive extraction of Python permission display data.

**Files**:

- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission-python.ts` (new)
- `opencode/packages/opencode/test/permission-python.test.ts` (new)
- `opencode/packages/opencode/src/config/config.ts` (schema addition)

**Changes**:

- Extract helper logic that reads:
  - `request.metadata` (`codeExpanded`, `codeExpandedAvailable`, `codePreview`,
    truncation/count fields, `mode`, `scriptPath`, `description`)
  - tool input fallback (`code`, `scriptPath`, `description`, `args`, `workdir`)
- Add robust type narrowing for unknown metadata payloads.
- Register `python` as a named permission key in the config schema (alongside
  `bash`, `task`, etc.) at `config.ts` for discoverability and autocompletion.
  The existing `.catchall(PermissionRule)` already handles it at runtime, but
  explicit registration improves UX.

**Test strategy note**: No existing tests exist for `permission.tsx`. The
helper can be unit-tested in isolation (pure data extraction). The renderer
(Phase 3) will be validated via tmux E2E captures rather than component-level
unit tests, since the component depends on Ink runtime and there are no
existing patterns to follow.

**Verification**:

- `cd opencode/packages/opencode && bun test test/permission-python.test.ts test/config/config.test.ts`

**Commit message**:

- Delivered as part of `feat(tui): render python permission summary and fullscreen code view`
  (`bdc1d13`), then tightened by follow-up `9f1bb60`.

**Parallelization**:

- Can run in parallel with Phase 1 once contract fields are agreed.

**Progress**:

- Helper + focused tests + config key are implemented and committed.
- Final focused validation for helper/config suites is green (`69 pass, 0 fail`).

---

### Phase 3 - TUI Python Permission Renderer + Fullscreen Body (DONE)

**Goal**: Render Python permission prompts with summary and full code body.

**Prerequisite**: Rebase `./opencode` feature branch against upstream `dev`
immediately before starting this phase, since `permission.tsx` is a
high-traffic file and stale base risks merge conflicts during PR.

**Files**:

- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`

**Changes**:

- Add `permission === "python"` branch in `info()`.
- Render compact summary:
  - description
  - mode (`inline` / `script`)
  - script path (if present)
  - `args` (if present, from `input()`)
  - `workdir` (if present and differs from project root, from `input()`)
  - preview/full counters and truncation marker state
- Render code body in a scrollable region using existing prompt layout so
  `ctrl+f` fullscreen toggle shows full content.
- Fullscreen body source selection (per render precedence):
  1. `request.metadata.codeExpanded` (bounded full source, when present)
  2. `input().code` (inline mode fallback — the original full source)
  3. `request.metadata.codePreview` (bounded fallback for very large scripts)
- Add `external_directory` sub-case: when an `external_directory` ask carries
  Python-specific metadata fields (`mode`, `codePreview`), render Python
  context (description, mode, script path) alongside the directory information
  instead of showing only the generic directory/filepath display. Detect via
  `request.metadata.mode` plus at least one Python-specific signal
  (`source`, `codePreview`, or `codePreviewTruncated`) to avoid false positives.

**Verification**:

- `cd opencode/packages/opencode && bun test test/permission-python.test.ts test/config/config.test.ts`

**Commit message**:

- `feat(tui): render python permission summary and fullscreen code view`

**Parallelization**:

- Depends on Phase 2 helper complete.

**Progress**:

- Implemented in `bdc1d13`, with follow-up refinement in `9f1bb60`
  (source rendering + stricter external-directory Python detection).

---

### Phase 4 - Isolated tmux-cli End-to-End Validation (TODO)

**Goal**: Validate interactive TUI behavior without local global config.

**Files**:

- `docs/opencode-tui-python-permission-test-matrix.md` (execution log updates)

**Changes**:

- Run TUI via `tmux-cli` with isolated env:
  - `OPENCODE_TEST_HOME`
  - `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`
  - unset `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`
- Trigger a python permission request and capture:
  - compact summary appearance
  - fullscreen (`ctrl+f`) code rendering
  - full-source availability for inline + script modes

**Verification**:

- `tmux-cli capture` evidence snapshots
- package test suites still green

**Commit message**:

- `test(tui): validate python permission fullscreen flow in isolated env`

**Parallelization**:

- Can be executed while PR description drafting starts.

**Progress**:

- Not started yet. This is the primary remaining technical validation task.

---

### Phase 5 - PR Packaging and Docs (TODO)

**Goal**: Prepare clean upstream PR from fork branch.

**Files**:

- PR body (GitHub)
- optional design note in `opencode/packages/opencode/docs/` if needed

**Changes**:

- Summarize problem, solution, screenshots/captures, and safety.
- Explicitly state no permission engine semantics changed.
- Include isolated-env tmux validation evidence.

**Verification**:

- Final `bun test` for touched packages.

**Commit message**:

- docs-only commit if needed; otherwise PR metadata only.

**Progress**:

- Not started yet; depends on Phase 4 evidence capture.

---

## Parallel Workstreams

- **Lane A (Tool metadata)**: Phase 1 in this repo. **Status: DONE**
- **Lane B (TUI helper + renderer)**: Phases 2-3 in `./opencode`. **Status: DONE**
- **Lane C (Interactive QA harness)**: Phase 4 tmux isolated validation setup. **Status: TODO**
- **Lane D (PR packaging)**: Phase 5 finalization. **Status: TODO**

Recommended order for remaining work:

1. Execute Lane C isolated tmux runbook and capture evidence.
2. Run final regression checks for touched packages.
3. Complete Lane D PR packaging using captured evidence.

## Acceptance Criteria

- Python permission prompt has tool-specific rendering in TUI.
- Compact view shows meaningful summary, not generic fallback text.
- Fullscreen view displays full source (inline and script mode).
- `external_directory` asks from Python show Python context (mode, description).
- `args` and `workdir` are visible in the prompt when provided.
- No use of `~/.config/opencode` during validation.
- Existing tool permissions and ask flow remain unchanged.
- All relevant tests pass in both repos.

## Risk and Mitigation

- **Risk**: Large code payloads degrade prompt rendering.
  - **Mitigation**: `codeExpanded` only included when truncated AND ≤ 50 KB.
    Scripts above 50 KB show `codePreview` in compact and fallback views.
    Fullscreen can still access `input().code` for inline mode.
- **Risk**: Metadata shape drift between repos.
  - **Mitigation**: phase split with explicit contract fields and helper tests.
- **Risk**: Interactive test flakiness.
  - **Mitigation**: deterministic tmux env bootstrap + output capture checklist.
- **Risk**: No existing `permission.tsx` unit-test patterns.
  - **Mitigation**: helper logic is unit-tested in isolation; renderer behavior
    is validated via tmux E2E captures (Phase 4). Accept that renderer tests
    may require Ink test utilities added later.
- **Risk**: Upstream `permission.tsx` changes cause merge conflicts.
  - **Mitigation**: rebase against upstream `dev` immediately before Phase 3.
- **Risk**: Unbounded metadata payloads over IPC.
  - **Mitigation**: `AskInput.metadata` has no SDK-level size validation.
    All size discipline is enforced by the tool itself via the 50 KB cap.

## PR Strategy

- Base branch: `dev` on forked `./opencode`.
- Prefer one feature PR for TUI branch changes.
- Keep python-tool metadata commit in this repository separate and reference it
  in PR notes as upstream data contract dependency.
