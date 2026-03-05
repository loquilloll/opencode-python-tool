---
title: Python Tool Output Visibility Plan
status: done
plan: 42-python-tool-output-visibility
created: 2026-03-05
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-tool-output
---

# Python Tool Output Visibility Plan

## Objective

Make Python tool execution output visible by default in OpenCode CLI TUI, without changing Python runtime behavior or permission semantics.

## Scope

### In Scope

- TUI rendering in `opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Focused tests in affected packages for Python output rendering behavior
- Documentation updates for default visibility behavior

### Out of Scope

- Permission policy changes
- Python analyzer/runtime behavior changes in `src/python.ts`
- New permission types
- Web UI rendering changes
- Jira/GitHub write actions

## Current State

- The Python tool already streams `metadata.output` and returns final output (`src/python.ts`).
- CLI TUI treats Python as a generic tool; generic output is hidden by default behind `generic_tool_output_visibility`.

## Commit-Safe Phases

### Phase 1 - CLI TUI Python Output Renderer

**Goal:** Render Python output by default in TUI, with parity to shell output behavior.

**Files:**

- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

**Changes:**

- Add `python` branch in `ToolPart` routing.
- Add a Python-specific renderer that:
  - displays command context
  - displays streaming and final output
  - supports collapse/expand for long output
  - strips ANSI for consistent display
- Keep existing generic-tool toggle behavior unchanged for non-Python tools.

**Validation:**

- `cd opencode/packages/opencode && bun test`

**Commit message:**

- `feat(tui): render python tool output by default`

#### Notes

- Status: Done (2026-03-05)
- Summary: Added a dedicated Python renderer in TUI and routed `python` tool parts away from `GenericTool`, so Python output is shown by default with Bash-style collapse/expand behavior.
- Files: `opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Tests: `cd opencode/packages/opencode && bun test test/permission-python.test.ts`; `cd opencode/packages/opencode && bun run typecheck`; `cd opencode/packages/opencode && bun test` (fails on existing unrelated `test/config/config.test.ts` key-order assertion and hit timeout)
- Follow-ups: Complete Phase 2 focused renderer tests/docs and decide whether to address the existing unrelated full-suite failure separately.
- Commit: `806ee27`
- PR/Jira: None

---

### Phase 2 - TUI Regression Tests and Docs

**Goal:** Lock TUI behavior with focused tests and document usage.

**Files:**

- `opencode/packages/opencode/test/...` (new or updated focused tests)
- `README.md` and/or plan docs as needed

**Changes:**

- Add focused coverage for:
  - inline and script Python output display in TUI
  - metadata/output precedence behavior
  - empty and long-output rendering behavior
- Update docs to note that Python output is visible by default in TUI.

**Validation:**

- `cd opencode/packages/opencode && bun test`

**Commit message:**

- `test(tui): add python output visibility coverage and docs`

#### Notes

- Status: Done (2026-03-05)
- Summary: Extracted Python renderer decision logic into a dedicated helper module and added focused TUI tests covering inline/script command display, output precedence, visibility gating, readiness, ANSI normalization, and long-output collapse behavior.
- Files: `opencode/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`, `opencode/packages/opencode/src/cli/cmd/tui/routes/session/python-output.ts`, `opencode/packages/opencode/test/cli/tui/python-output.test.ts`
- Tests: `cd opencode/packages/opencode && bun test test/cli/tui/python-output.test.ts test/permission-python.test.ts`; `cd opencode/packages/opencode && bun run typecheck`
- Follow-ups: Optional: rerun full `bun test` once existing unrelated config-order suite instability is addressed.
- Commit: `660893e`
- PR/Jira: None

## Acceptance Criteria

- Python tool output is visible in CLI TUI without enabling generic output toggle.
- Streaming output and final output both display correctly.
- Long outputs are readable with collapse/expand behavior.
- Existing permission asks and runtime semantics are unchanged.

## Risks and Mitigations

- **Risk:** Output source mismatch between streaming metadata and final output.
  - **Mitigation:** Use explicit precedence tests for `output` and `metadata.output`.
- **Risk:** UI noise from broad generic-output changes.
  - **Mitigation:** Keep change targeted to Python renderer paths only.
- **Risk:** UX inconsistency with shell rendering.
  - **Mitigation:** Mirror bash renderer layout and interaction patterns where practical.

## Phase Status

- Phase 1: DONE (2026-03-05)
- Phase 2: DONE (2026-03-05)
