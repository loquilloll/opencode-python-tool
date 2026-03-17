---
title: Python Permission Preview Provenance
status: active
plan_type: build
plan: 76-python-permission-preview-provenance
created: 2026-03-17
updated: 2026-03-17T14:01
tags:
  - type/plan
  - status/active
  - project/opencode-python-tool
  - topic/permissions
  - topic/tui
  - topic/python-runtime
---

# Python Permission Preview Provenance

## Objective

Show bounded provenance context in the Python permission preview so the allow
view explains not only the source code being executed, but also how the runtime
classified the operations that drove the permission ask.

## Scope

### In Scope

- `src/python.ts`
- `.opencode/test/python-external-directory.test.ts`
- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission-python.ts`
- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
- `opencode/packages/opencode/test/permission-python.test.ts`
- `README.md`
- this plan file

### Out of Scope

- changing analyzer classification semantics in `src/python/python-*`
- changing permission pattern or always-rule semantics
- app/web permission UI parity
- a raw JSON operation inspector in the prompt
- changing the early outside-worktree `scriptPath` preflight ask to read source
  or analysis data before approval

## Current State Summary

- `src/python.ts` already records bounded operation provenance in
  `metadata.operations`, including fields such as `canonicalSource`,
  `receiverKind`, `dependencySignature`, `ruleHit`, and `guardFailure`.
- that provenance currently reaches `python` asks, but post-analysis
  `external_directory` asks only receive preview metadata, so the external
  prompt cannot show the same provenance context
- the TUI helper in
  `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission-python.ts`
  extracts source-preview fields but ignores `operations`
- the renderer in
  `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
  currently shows source text only, so provenance never appears in the allow
  preview
- existing `python`-ask provenance coverage now lives in the split inline
  runtime tests (`.opencode/test/python-inline-permissions-basic.test.ts` and
  `.opencode/test/python-inline-permissions-inference.test.ts`); this plan's
  runtime parity work is limited to sharing that metadata with analyzed
  `external_directory` asks

## Design Direction

- use a compact per-operation summary, not raw metadata dumps
- derive the display from existing `operations` metadata instead of creating a
  second analyzer-specific provenance model
- keep runtime permission behavior unchanged; this is a metadata-parity and UI
  projection change only
- keep external approval context visible for Python-shaped
  `external_directory` prompts: directory and pattern information must remain
  visible alongside provenance and code preview
- preserve the existing code-preview/fullscreen source precedence
  (`codeExpanded` -> `input().code` -> `codePreview`)
- keep the early outside-worktree `scriptPath` preflight ask unchanged: when the
  runtime has not loaded or analyzed the script yet, provenance may be absent
- keep the helper defensive: malformed or partial provenance payloads should
  degrade gracefully without breaking the prompt

### Provenance Preview Shape

The compact preview should normalize `operations` into bounded rows that can be
rendered in both `python` and Python-shaped `external_directory` prompts.

Each normalized row should prefer:

- operation kind (`read`, `write`, `exec`, `unknown`, and any non-blocking
  context rows that are intentionally kept)
- outward call identity
- canonical source when it differs from the outward call
- short guard or receiver context when available and high signal

Each rendered row should stay on a single line in bracketed form:

- `[kind] [source] [provenance]`
- `kind` is the normalized operation kind
- `source` is the outward call identity shown to the user
- `provenance` is the shortest high-signal context available, preferring a
  differing canonical source, then guard context, then receiver context
- omit the trailing provenance segment by default unless it adds meaningful
  signal beyond `[kind] [source]`; rows should stay concise rather than filling
  the third bracket with low-value or repetitive context
- if no high-signal provenance field remains after normalization, omit the
  trailing provenance segment rather than wrapping the row onto multiple lines

The preview contract should stay explicit:

- compact mode shows at most 4 normalized provenance rows
- fullscreen mode shows at most 12 normalized provenance rows
- rows are ordered by a stable partition: permission-driving kinds first
  (`read`, `write`, `exec`, `unknown`), then any retained non-blocking context
  rows (`emit`, `pure`) in original runtime order within each partition
- the first implementation should not dedupe rows; preserve runtime order after
  partitioning so tests can assert a simple, stable rule — this is a
  first-pass simplification, not an invariant; the analyzer may emit multiple
  entries for the same call site (e.g., a call that triggers both a guard
  failure and a rule hit), and dedup can be revisited once the preview is
  validated interactively
- malformed entries are dropped during normalization
- if no rows remain after normalization, omit the provenance block entirely
- if rows are hidden by the compact or fullscreen cap, show a `+N more
  operations` remainder indicator instead of dumping raw metadata

## Commit-Safe Phases

### Phase 1 - Runtime provenance parity for permission asks

**Goal:** Make analyzed Python-originated `external_directory` asks carry the
same bounded provenance context already available on `python` asks.

**Files:**

- `src/python.ts`
- `.opencode/test/python-external-directory.test.ts`
- this plan file

**Changes:**

- reuse the existing permission provenance metadata for post-analysis
  `external_directory` asks, not only `python` asks
- preserve current preflight outside-worktree `scriptPath` approval behavior,
  where source preview and provenance may still be absent because analysis has
  not run yet
- keep `patterns`, `always`, and execution behavior unchanged
- add provenance-parity tests in `python-external-directory.test.ts` covering
  analyzed `external_directory` asks carrying `operations` metadata, and
  guardrails asserting the early preflight path omits provenance

**Validation:**

- `cd .opencode && bun test test/python-external-directory.test.ts`
- `cd .opencode && bun test`

**Suggested commit message:**

- `feat: share python permission provenance with external directory asks`

### Phase 2 - TUI helper provenance view-model

**Goal:** Normalize raw permission provenance into a small, defensive view-model
that the prompt can render without understanding analyzer internals.

**Files:**

- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission-python.ts`
- `opencode/packages/opencode/test/permission-python.test.ts`
- this plan file

**Changes:**

- extend `buildPythonPermissionView()` to parse permission provenance from
  metadata
- normalize operation rows into compact display entries instead of passing raw
  metadata through the renderer; the view-model should expose single-line row
  segments for `[kind] [source] [provenance]`
- add bounded row-count metadata so the UI can show a concise preview and a
  remainder indicator when needed
- keep parsing tolerant of missing, malformed, or partial metadata payloads
- add helper coverage for empty provenance, malformed rows, and over-limit
  operation lists
- cover both `python` and Python-shaped `external_directory` metadata in helper
  tests

**Validation:**

- `cd opencode/packages/opencode && bun test test/permission-python.test.ts`

**Suggested commit message:**

- `feat(tui): extract python permission provenance preview data`

### Phase 3 - TUI renderer provenance block

**Goal:** Show provenance context directly in the allow preview for Python
permission prompts.

**Files:**

- `opencode/packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
- `opencode/packages/opencode/test/permission-python.test.ts`
- this plan file

**Changes:**

- render a compact provenance section in the Python permission body above or
  alongside the existing code preview, with each operation rendered on one line
  in the bracketed `[kind] [source] [provenance]` format
- reuse the same provenance section for Python-originated
  `external_directory` prompts
- wire the existing `patterns` parameter in `renderPythonBody()` so that
  Python-shaped `external_directory` prompts actually render their
  directory/pattern target; this parameter is currently accepted but never used
  in the JSX output
- keep the approved external directory path and pattern list visible for
  Python-originated `external_directory` prompts
- show a bounded remainder indicator when compact mode hides additional rows
- keep current code-preview/fullscreen behavior unchanged
- preserve graceful fallback when provenance is unavailable

**Validation:**

- `cd opencode/packages/opencode && bun test test/permission-python.test.ts`
- manual TUI verification of the Python and Python-shaped
  `external_directory` renderer paths in `opencode`

**Suggested commit message:**

- `feat(tui): show python permission provenance in preview`

### Phase 4 - Docs and interactive validation

**Goal:** Document the new preview behavior and verify it in the interactive TUI.

**Files:**

- `README.md`
- this plan file

**Changes:**

- update the permission metadata/UI documentation to note that Python prompts
  now surface bounded provenance context in addition to source preview
- manually validate compact and fullscreen behavior for both `python` and
  Python-shaped `external_directory` prompts
- record the verification outcome in the phase notes

**Validation:**

- `cd opencode/packages/opencode && bun test test/permission-python.test.ts`
- `cd .opencode && bun test test/python-external-directory.test.ts`
- manual TUI verification of compact and fullscreen provenance preview behavior
  in `opencode`

**Suggested commit message:**

- `docs: document python permission provenance preview`

## Acceptance Criteria

- Python permission prompts show a compact provenance summary derived from
  `metadata.operations`
- Python-shaped `external_directory` prompts show the same provenance summary
  once the runtime has already loaded and analyzed the source
- early outside-worktree `scriptPath` preflight approval remains unchanged and
  may still omit preview/provenance fields
- malformed or partial provenance metadata does not crash the helper or prompt
- Python-shaped `external_directory` prompts keep their directory/pattern target
  visible while also showing provenance
- compact mode caps provenance rows at 4 and fullscreen caps them at 12, with a
  remainder indicator when additional rows exist
- each displayed provenance item stays on one line in bracketed
  `[kind] [source] [provenance]` form, omitting the third segment when there is
  no meaningful high-signal provenance context or when it would add only
  low-value repetition
- code-preview/fullscreen source precedence remains unchanged
- permission patterns, always rules, analyzer behavior, and execution semantics
  remain unchanged

## Phase Status

- Phase 1: TODO
- Phase 2: TODO
- Phase 3: TODO
- Phase 4: TODO
