---
title: Python Workspace Read Parity
status: done
plan: 74-python-workspace-read-parity
created: 2026-03-16
updated: 2026-03-16
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/permissions
  - topic/workspace
---

# Python Workspace Read Parity

## Objective

Make the custom `python` tool behave like built-in workspace-scoped file-reading tools for statically resolved filesystem reads: literal reads inside the active worktree should not trigger a `python` permission ask, while outside-worktree reads should still require `external_directory` approval. Dynamic reads remain opt-in and continue to ask.

## Scope

### In Scope

- `src/python.ts`
- `.opencode/test/python.test.ts`
- `README.md`
- `docs/python-custom-tool-plan.md`
- this plan file

### Out of Scope

- auto-allowing `read:<dynamic>`
- runtime sandboxing or syscall interception
- changing analyzer classification semantics for `read` itself
- relaxing `write`, `exec`, `unknown`, or `external_directory` policy boundaries

## Design Direction

- Keep the analyzer and operations metadata unchanged: `read` events are still recorded.
- Change only the runtime permission plan so literal in-worktree reads are auto-allowed.
- Preserve explicit `external_directory` asks for any literal path outside `context.worktree`.
- Preflight outside-worktree `scriptPath` before reading the script file so external file contents are not loaded before approval.
- Keep dynamic reads conservative: `read:<dynamic>` still produces a `python` permission ask.

## Commit-Safe Phases

### Phase 1 - Runtime workspace read parity

**Goal:** Auto-allow statically resolved in-worktree literal reads and preflight outside-worktree script paths before loading source.

**Files:**

- `src/python.ts`
- this plan file

**Changes:**

- suppress `python` read permission patterns for literal read paths that resolve inside `context.worktree`
- keep those same read operations in metadata for observability
- preserve `external_directory` asks for literal paths outside the worktree
- ask `external_directory` for outside-worktree `scriptPath` before `readFile()`
- avoid duplicate external asks for the same outside script path later in permission planning

**Validation:**

- `cd .opencode && bun test test/python.test.ts`

**Commit message:**

- `fix: auto-allow workspace python reads`

### Phase 2 - Runtime regression coverage

**Goal:** Lock the new workspace-read boundary and external-script pre-approval behavior.

**Files:**

- `.opencode/test/python.test.ts`
- this plan file

**Changes:**

- update current in-worktree read expectations from `python` ask to no `python` ask
- add regression coverage that outside-worktree `scriptPath` triggers `external_directory` before file load
- preserve coverage showing outside literal reads still ask
- preserve coverage showing dynamic reads still ask

**Validation:**

- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `test: cover workspace read permission parity`

### Phase 3 - Permission model docs

**Goal:** Update the documented runtime permission contract to match the delivered workspace-read behavior.

**Files:**

- `README.md`
- `docs/python-custom-tool-plan.md`
- this plan file

**Changes:**

- document that literal reads inside the worktree are auto-allowed
- document that outside-worktree reads and script paths still prompt via `external_directory`
- document that dynamic reads remain conservative and still ask
- remove stale wording that implies every file under `cwd` is automatically workspace-scoped

**Validation:**

- doc read-through

**Commit message:**

- `docs: document workspace read parity`

### Phase 4 - Realpath boundary hardening and doc alignment

**Goal:** Close symlink-based workspace escape gaps in runtime permission planning and make the docs match the final behavior precisely.

**Files:**

- `src/python.ts`
- `.opencode/test/python.test.ts`
- `README.md`
- `docs/python-custom-tool-plan.md`
- this plan file

**Changes:**

- replace lexical workspace containment checks with realpath-aware checks where permission boundaries matter
- ensure outside-worktree `scriptPath` and symlinked `workdir` cases cannot bypass `external_directory`
- add regressions for symlinked in-worktree paths that target outside the worktree
- strengthen the outside-script approval test so it proves approval happens before file load
- correct any stale permission-flow or preview docs revealed by the review

**Validation:**

- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `fix: harden python workspace path boundaries`

#### Notes

- Status: Done (2026-03-16)
- Summary: Added realpath-aware workspace boundary checks with conservative fail-closed fallback for boundary-resolution errors, blocked symlink and symlink-plus-`..` escapes for `workdir`, `scriptPath`, and literal reads, and aligned the permission docs with the delivered runtime behavior.
- Files: `src/python.ts`, `.opencode/test/python.test.ts`, `README.md`, `docs/python-custom-tool-plan.md`, `docs/plans/74-python-workspace-read-parity.md`
- Tests: `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- `open('notes.txt', 'r')` from inside the worktree no longer triggers a `python` ask
- the same in-worktree read still appears in runtime operations metadata as `read`
- `open('/tmp/outside.txt', 'r')` still triggers `external_directory`
- an outside-worktree `scriptPath` is approved before the tool reads the script contents
- `read:<dynamic>` still triggers a `python` permission ask
- symlinked paths that resolve outside the worktree still require `external_directory`
- `write`, `exec`, `unknown`, and `external_directory` behavior remain otherwise unchanged

## Phase Status

- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
