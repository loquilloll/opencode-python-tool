---
title: Python Analyzer Test Naming Cleanup
status: done
plan_type: build
plan: 79-python-analyzer-test-naming-cleanup
created: 2026-03-27
updated: 2026-03-27
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/testing
  - topic/python-analyzer
  - topic/cleanup
---

# Python Analyzer Test Naming Cleanup

## Objective

Tighten the remaining analyzer test naming debt after plan 78 so Bun output, grep results, and future edits reflect the current split suite layout more clearly, while keeping analyzer behavior and file organization stable.

## Scope

### In Scope

- `.opencode/test/python-analyze-parity.test.ts`
- `.opencode/test/python-analyze-library-pure.test.ts`
- `.opencode/test/python-analyze-exec-network.test.ts`
- `.opencode/test/python-analyze-integrations.test.ts`
- this plan file

### Out of Scope

- changing analyzer behavior in `src/python/*.ts`
- moving tests between analyzer files
- renaming individual `it(...)` titles or assertion text
- introducing shared analyzer-specific fixtures
- renaming `python-analyze-*.test.ts` files in this pass unless a later plan explicitly takes that on

## Design Direction

This should be a suite-title-first cleanup. Plan 78 intentionally preserved legacy labels so the modularization could land as pure file movement; this follow-up should now replace those historical names with behavior-first labels while preserving test bodies verbatim.

### Naming rules

- prefer behavior/domain names over phase-history labels
- avoid duplicate sibling `describe(...)` names in the same file
- keep the flat `python-analyze-*.test.ts` file layout unchanged
- keep the top-level `describe("python analyzer")` hosts unchanged
- for the broad exec-network host, choose a replacement suite title that explicitly names the current network/db/tempfile/deserialization scope instead of implying a narrower exec-only seam
- if `python-analyze-exec-network.test.ts` still feels too broad after suite-title cleanup, treat any file rename as a separate later plan rather than broadening this pass

### Target cleanup areas

- `.opencode/test/python-analyze-parity.test.ts`
  - rename `phase 1 parity fixtures` to `parity fixture regressions`
- `.opencode/test/python-analyze-exec-network.test.ts`
  - rename `phase 5 network/db/tempfile/deserialization` to `network db tempfile deserialization and supporting regressions`
- `.opencode/test/python-analyze-integrations.test.ts`
  - rename `phase 11 oci coverage` to `oci classification`
  - rename `phase 12 ghapi coverage` to `ghapi classification`
  - rename `phase 13 atlassian-python-api coverage` to `atlassian-python-api classification`
- `.opencode/test/python-analyze-library-pure.test.ts`
  - rename the `zlib classification` block that includes decode-chain cases to `zlib decompression and decode-chain classification`
  - rename the shorter `zlib classification` block that centers on direct-import and rebinding behavior to `zlib decompression import and rebinding regressions`

### Planned old -> new suite-title mapping

- `.opencode/test/python-analyze-parity.test.ts`
  - `phase 1 parity fixtures` -> `parity fixture regressions`
- `.opencode/test/python-analyze-exec-network.test.ts`
  - `phase 5 network/db/tempfile/deserialization` -> `network db tempfile deserialization and supporting regressions`
- `.opencode/test/python-analyze-integrations.test.ts`
  - `phase 11 oci coverage` -> `oci classification`
  - `phase 12 ghapi coverage` -> `ghapi classification`
  - `phase 13 atlassian-python-api coverage` -> `atlassian-python-api classification`
- `.opencode/test/python-analyze-library-pure.test.ts`
  - `zlib classification` block with decode-chain cases -> `zlib decompression and decode-chain classification`
  - shorter `zlib classification` block focused on direct-import/rebinding behavior -> `zlib decompression import and rebinding regressions`

## Commit-Safe Phases

### Phase 1 - Rename legacy analyzer suite titles

**Goal:** Replace the remaining phase-history and duplicate analyzer suite labels with behavior-first names.

**Files:**

- `.opencode/test/python-analyze-parity.test.ts`
- `.opencode/test/python-analyze-library-pure.test.ts`
- `.opencode/test/python-analyze-exec-network.test.ts`
- `.opencode/test/python-analyze-integrations.test.ts`
- this plan file

**Changes:**

- rename the targeted nested `describe(...)` titles only
- preserve all test bodies, `it(...)` titles, imports, and file layout
- keep the current `python-analyze-*.test.ts` filenames unchanged
- record the final old -> new suite-title mapping in this plan's completion notes
- update this plan with completion notes once the cleanup lands

**Validation:**

- `cd .opencode && bun test test/python-analyze-parity.test.ts`
- `cd .opencode && bun test test/python-analyze-library-pure.test.ts`
- `cd .opencode && bun test test/python-analyze-exec-network.test.ts`
- `cd .opencode && bun test test/python-analyze-integrations.test.ts`
- `! rg 'describe\("phase [0-9]+' .opencode/test/python-analyze-parity.test.ts .opencode/test/python-analyze-exec-network.test.ts .opencode/test/python-analyze-integrations.test.ts`
- `python3 -c "from pathlib import Path; import re, sys; text = Path('.opencode/test/python-analyze-library-pure.test.ts').read_text(); names = re.findall(r'describe\(\"([^\"]+)\"', text); dups = sorted({name for name in names if names.count(name) > 1}); print('\n'.join(dups)); sys.exit(1 if dups else 0)"`
- `cd .opencode && bun test`

**Suggested commit message:**

- `test: clarify python analyzer suite names`

#### Notes
- Status: Done (2026-03-27)
- Summary: Renamed the remaining historical and duplicate analyzer suite hosts without changing file layout or test bodies. The final mapping is: `phase 1 parity fixtures` -> `parity fixture regressions`; `phase 5 network/db/tempfile/deserialization` -> `network db tempfile deserialization and supporting regressions`; `phase 11 oci coverage` -> `oci classification`; `phase 12 ghapi coverage` -> `ghapi classification`; `phase 13 atlassian-python-api coverage` -> `atlassian-python-api classification`; `zlib classification` (block with decode-chain coverage) -> `zlib decompression and decode-chain classification`; `zlib classification` (shorter direct-import/rebinding block) -> `zlib decompression import and rebinding regressions`.
- Files: `.opencode/test/python-analyze-parity.test.ts`, `.opencode/test/python-analyze-library-pure.test.ts`, `.opencode/test/python-analyze-exec-network.test.ts`, `.opencode/test/python-analyze-integrations.test.ts`, `docs/plans/79-python-analyzer-test-naming-cleanup.md`
- Tests: `cd .opencode && bun test test/python-analyze-parity.test.ts` (17 pass); `cd .opencode && bun test test/python-analyze-library-pure.test.ts` (29 pass); `cd .opencode && bun test test/python-analyze-exec-network.test.ts` (43 pass); `cd .opencode && bun test test/python-analyze-integrations.test.ts` (28 pass); `! rg 'describe\("phase [0-9]+' .opencode/test/python-analyze-parity.test.ts .opencode/test/python-analyze-exec-network.test.ts .opencode/test/python-analyze-integrations.test.ts`; `python3 -c "from pathlib import Path; import re, sys; text = Path('.opencode/test/python-analyze-library-pure.test.ts').read_text(); names = re.findall(r'describe\(\"([^\"]+)\"', text); dups = sorted({name for name in names if names.count(name) > 1}); print('\\n'.join(dups)); sys.exit(1 if dups else 0)"`; `cd .opencode && bun test` (569 pass)
- Follow-ups: Possible later file-level rename or further split of `.opencode/test/python-analyze-exec-network.test.ts` stays deferred to a separate plan. Duplicate zlib `it(...)` titles remain intentionally out of scope for this suite-title-only cleanup.
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- no in-scope analyzer suite still uses a `phase N` `describe(...)` label
- no duplicate sibling `describe(...)` titles remain in `.opencode/test/python-analyze-library-pure.test.ts`
- the `python-analyze-*.test.ts` file layout remains unchanged in this cleanup pass
- focused and full Bun test runs stay green
- any future file-level rename of `python-analyze-exec-network.test.ts` is explicitly deferred rather than folded into this small cleanup

## Phase Status

- Phase 1: DONE
