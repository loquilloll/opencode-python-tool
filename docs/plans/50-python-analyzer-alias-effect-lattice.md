---
title: Python Analyzer Alias Resolution + Internal Effect Lattice
status: done
plan: 50-python-analyzer-alias-effect-lattice
created: 2026-03-08
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/static-analysis
---

# Python Analyzer Alias Resolution + Internal Effect Lattice

## Objective

Improve static callable side-effect detection without per-call LLM usage by:

- resolving explicit import aliases and simple local callable/module rebindings
- defining an internal effect lattice richer than the outward event taxonomy
- preserving the existing outward analyzer API and review fallback behavior

## Scope

### In Scope

- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`
- this plan file

### Out of Scope

- full Python interprocedural analysis
- dynamic attribute/reflection/monkeypatch resolution
- changing `src/python.ts` or `src/python-session-report.ts` outward APIs in Phase 1

## Internal Effect Model

The analyzer should move toward an internal effect lattice, then fold those
effects back into existing outward event kinds.

### Proposed internal effects

- `fs.read`
- `fs.write`
- `network.exec`
- `db.exec`
- `process.exec`
- `dynamic.exec`
- `emit.signal`
- `pure.compute`
- `unknown`

### Fold-down rules

| Internal effect | Outward kind |
|---|---|
| `fs.read` | `read` |
| `fs.write` | `write` |
| `network.exec` | `exec` |
| `db.exec` | `exec` |
| `process.exec` | `exec` |
| `dynamic.exec` | `exec` |
| `emit.signal` | `emit` |
| `pure.compute` | `pure` |
| `unknown` | `unknown` |

Phase 1 keeps this as design guidance only. The live `analyze()` API continues to
return `PythonEvent[]` with current outward kinds.

## Commit-Safe Phases

### Phase 1 - Alias resolution and local rebinding prototype

**Goal:** Normalize explicit aliases and simple local callable/module rebindings
before rule matching.

**Files:**

- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`

**Changes:**

- add a bounded scope-aware binding table for import aliases and same-scope
  local rebindings
- resolve the leftmost identifier of a callable before rule matching
- preserve current outward event kinds and unknown fallback behavior
- clear bindings on non-alias reassignment to avoid stale inference

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`

**Commit message:**

- `feat: resolve python analyzer aliases and rebindings`

#### Notes

- Status: Done (2026-03-08)
- Summary: Added scope-aware alias resolution for explicit import aliases and simple local rebindings in the analyzer, so canonical call identities can be recovered before rule matching while preserving current outward event kinds and conservative unknown fallback behavior.
- Files: `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: Phase 2 should document the new alias coverage and explicitly note that non-assignment rebinding forms (`for`/`with`/`except`) still remain outside the prototype.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Analyzer docs for new resolution behavior

**Goal:** Document what the alias prototype does and does not resolve.

**Files:**

- `README.md`
- this plan file

**Changes:**

- document supported alias forms and rebinding limits
- document that wrappers/interprocedural summaries remain deferred

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`

**Commit message:**

- `docs: describe python analyzer alias resolution`

#### Notes

- Status: Done (2026-03-08)
- Summary: Updated README analyzer documentation to describe the new bounded alias-resolution pass, supported alias/rebinding forms, and the remaining prototype limits around non-assignment rebinding and deferred wrapper/interprocedural summaries.
- Files: `README.md`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`
- Follow-ups: Phase 3 should introduce the internal resolved-effect layer without changing outward `PythonEvent` behavior.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Internal effect lattice refactor under current API

**Goal:** Introduce an internal resolved-effect layer while keeping outward
`PythonEvent` behavior unchanged.

**Files:**

- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- add internal resolved-effect atoms and fold-down mapping
- separate canonical resolved call identity from outward event emission
- keep runtime/review interfaces unchanged

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`

**Commit message:**

- `refactor: add internal python effect lattice`

#### Notes

- Status: Done (2026-03-08)
- Summary: Refactored the analyzer to classify calls through internal resolved-effect atoms plus fold-down mapping, separating canonical/resolved call identity from outward `PythonEvent` emission while preserving existing runtime-facing behavior.
- Files: `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: The documented non-assignment rebinding limitation (`for`/`with`/`except`) remains unchanged; Phase 4 can build on the new internal layer for bounded callable passthroughs.
- Commit: Not committed
- PR/Jira: None

### Phase 4 - Bounded local wrapper/callable passthroughs

**Goal:** Extend alias-aware resolution to one additional safe pattern for local
callable passthroughs.

**Files:**

- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- support direct callable alias passthroughs such as constructor aliases and
  function-valued locals
- keep dynamic/conflicting cases on `unknown`

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`

**Commit message:**

- `feat: extend python analyzer callable passthrough resolution`

#### Notes

- Status: Done (2026-03-08)
- Summary: Added bounded zero-arg local callable-factory passthrough support so assignments like `fetch = get_fetch()` or `Ctor = get_ctor()` can reuse existing alias and constructor-instance resolution, while parameterized, decorated, wrapper-style, and subscript-return factories remain conservative `unknown` cases.
- Files: `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: Any broader local wrapper summaries should be driven by observed review data rather than enabled eagerly.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: Done (2026-03-08)
- Summary: Added explicit invalidation for non-assignment rebinding sites (`for`, `with ... as`, `except ... as`) so stale aliases and tracked instances are cleared conservatively before body and later calls, and documented the updated boundary in `README.md`.
- Files: `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `README.md`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: Low-priority regression coverage could still be added for nested-scope shadowing across these same rebinding forms.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: Done (2026-03-08)
- Summary: Added regression coverage for multi-item `with` header ordering and nested-scope shadowing so the analyzer now explicitly proves alias invalidation happens in source order without leaking across lexical scopes.
- Files: `.opencode/test/python-analyze.test.ts`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: Done (2026-03-08)
- Summary: Added async regression coverage for `async for` and `async with`, and tightened invalidation to leave a same-scope shadow barrier so inner rebinds stop falling back to parent aliases while outer lexical scopes remain intact.
- Files: `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `README.md`, `docs/plans/50-python-analyzer-alias-effect-lattice.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- explicit import aliases such as `import requests as rq` normalize before
  classification
- simple local rebindings such as `fetch = requests.get` can classify later
  calls conservatively
- non-alias reassignment invalidates prior bindings
- outward `PythonEvent.kind` values remain unchanged

## Risks and Mitigations

- **Risk:** stale alias inference after rebinding.
  - **Mitigation:** delete bindings on non-alias reassignment.
- **Risk:** alias leakage across scopes.
  - **Mitigation:** use parent-linked lexical scopes with local shadowing.
- **Risk:** overconfidence on dynamic Python features.
  - **Mitigation:** stop on unsupported patterns and emit `unknown`.

## Phase Status

- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
