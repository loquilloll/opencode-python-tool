---
title: JSON-Backed Python Rules and Session Report Plan
status: in-progress
plan: 45-python-json-rules-and-session-report
created: 2026-03-06
tags:
  - type/plan
  - status/in-progress
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/session-report
---

# JSON-Backed Python Rules and Session Report Plan

## Objective

Move declarative Python callable-classification rules out of `src/python/python-analyze.ts` and into a JSON file that the analyzer loads at runtime, then add a periodic utility that scans saved OpenCode sessions, re-runs the analyzer on saved inline Python snippets, reports unknown callables, and can update the JSON rules file without changing plugin code.

## Scope

### In Scope

- `src/python/python-analyze.ts`
- new `src/python/python-rules.json`
- new `src/python-session-report.ts`
- focused tests in `.opencode/test/`
- documentation for the JSON rule workflow and periodic utility

### Out of Scope

- `scriptPath` historical reconstruction
- persistence of live permission-request payloads
- exact historical replay when analyzer rules change over time
- web/TUI changes for displaying callable ownership
- full alias resolution or broader data-flow analysis

## Current State

- Declarative classification tables are currently hardcoded in `src/python/python-analyze.ts`.
- The analyzer emits `PythonEvent[]`, and the runtime immediately turns those into permission patterns in `src/python.ts`.
- Saved sessions retain inline Python source in tool `state.input.code`, but they do not persist permission `operations` metadata.
- Because inline source is already stored, historical analysis can be rebuilt by re-running `analyze()` on saved snippets instead of persisting live permission payloads.

## Design Direction

### Split declarative rules from procedural analysis

The analyzer currently mixes two concerns:

1. declarative knowledge about known call patterns
2. procedural AST logic that extracts names, paths, and context

This plan externalizes only the declarative knowledge.

### Declarative rules move to JSON

Create `src/python/python-rules.json` to hold data such as:

- read methods
- write methods
- direct read/write/exec call lists
- path-based write call specs
- OCI, GHAPI, and Atlassian declarative coverage tables
- report-maintained candidate entries for unknown callables

### Procedural logic stays in TypeScript

Keep the following in `src/python/python-analyze.ts`:

- parser initialization and caching
- AST traversal and node-name extraction
- string parsing and literal-path extraction
- `open()` mode interpretation
- dynamic-path detection
- GHAPI and Atlassian tracked-instance logic
- import-provenance checks and fallback behavior

### Shared rules file, safe write model

The session-report utility should modify the same JSON file, but the default write path should be a non-live `candidates` section instead of directly changing active `read` / `write` / `exec` buckets.

That keeps analyzer behavior stable while still letting the utility write discoveries into the shared rule file without touching TypeScript.

Example shape:

```json
{
  "version": 1,
  "methods": {
    "read": ["read_text", "read_bytes"],
    "write": ["write_text", "write_bytes"]
  },
  "calls": {
    "read": ["json.load", "yaml.safe_load"],
    "write": ["json.dump", "yaml.safe_dump"],
    "exec": ["requests.get", "sqlite3.connect"]
  },
  "path": {
    "write": {
      "os.remove": { "index": 0, "names": ["path"] }
    }
  },
  "sdk": {
    "ghapi": {
      "execCalls": ["ghapi.page.paged"],
      "writeCalls": ["ghapi.actions.create_workflow"],
      "instanceConstructors": ["GhApi"]
    }
  },
  "candidates": {
    "unknown": [
      {
        "call": "rq.get",
        "count": 4,
        "lastSeen": "2026-03-06T12:00:00Z",
        "examples": ["session_123", "session_456"]
      }
    ]
  }
}
```

### Session-report utility behavior

`src/python-session-report.ts` should:

- scan saved tool parts from the OpenCode SQLite database
- use inline `state.input.code` only
- skip `scriptPath` entries completely in v1
- re-run `analyze()` on each snippet
- group unknown callables by normalized name and count
- print human-readable summaries by default
- support `--json` for machine-readable output
- support an explicit update mode that writes findings into `src/python/python-rules.json`

## Proposed Rule File Shape

The JSON file should stay intentionally boring and serializable.

### Top-level sections

- `version`: schema version for forward-compatible changes
- `methods`: method-name arrays keyed by kind
- `calls`: direct callable arrays keyed by kind
- `path.write`: path-aware write specs keyed by call name
- `sdk`: grouped metadata for OCI, GHAPI, and Atlassian-specific heuristics
- `candidates`: utility-maintained review data, ignored by active classification unless explicitly promoted later

### Validation approach

Do lightweight runtime validation in `src/python/python-analyze.ts` with local shape checks.

Avoid adding new dependencies just to parse the rule file. The `.opencode/package.json` runtime currently stays minimal, and this change should preserve that property.

## Commit-Safe Phases

### Phase 1 - Introduce JSON rule file and loader

**Goal:** Externalize declarative rule tables without changing analyzer behavior.

**Files:**

- `src/python/python-analyze.ts`
- `src/python/python-rules.json`

**Changes:**

- Move declarative sets/records out of TypeScript constants into `src/python/python-rules.json`.
- Add a cached loader that reads the JSON relative to `import.meta.url`.
- Add minimal runtime shape validation and clear error messages for malformed files.
- Preserve all current analyzer outputs for existing supported patterns.

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- module-load smoke check for the analyzer import path

**Commit message:**

- `feat: load python analyzer rules from json`

#### Notes

- Status: Done (2026-03-06)
- Summary: Moved declarative analyzer rule inventories into `src/python/python-rules.json` and added a cached runtime loader with shape validation, normalized load errors, and retry-safe cache behavior. Existing analyzer classifications remain green under focused tests.
- Files: `src/python/python-analyze.ts`, `src/python/python-rules.json`, `.opencode/test/python-analyze.test.ts`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `bun -e "import('./src/python/python-analyze.ts').then((m) => m.analyze(\"open('f')\").then(() => console.log('analyzer loads ok')) )"`
- Follow-ups: Phase 5 must document shipping `src/python/python-rules.json` with copied installs; future utility work can now target the shared JSON file instead of TypeScript constants.
- Commit: `aceca95`
- PR/Jira: None

### Phase 2 - Refactor analyzer to consume JSON-backed rules

**Goal:** Keep procedural logic intact while routing all declarative lookups through the loaded rule set.

**Files:**

- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`

**Changes:**

- Replace hardcoded `Set`, `Record`, and constructor metadata initialization with JSON-backed structures.
- Keep `open()` handling, path extraction, tracked-instance heuristics, and fallback logic in code.
- Add tests that prove JSON-backed behavior matches current coverage.

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`

**Commit message:**

- `refactor: route python classification through json rules`

#### Notes

- Status: Done (2026-03-06)
- Summary: Declarative analyzer lookups were fully rerouted through loaded JSON during Phase 1 implementation, so no separate behavior-changing refactor was needed after `aceca95` landed.
- Files: `src/python/python-analyze.ts`, `src/python/python-rules.json`, `.opencode/test/python-analyze.test.ts`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`
- Follow-ups: Phase 3 can consume `analyze()` directly without any remaining hardcoded rule-table dependency.
- Commit: `aceca95`
- PR/Jira: None

### Phase 3 - Add saved-session report utility

**Goal:** Periodically mine unknown callables from saved inline Python snippets.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`

**Changes:**

- Read the OpenCode SQLite database directly.
- Default to the standard OpenCode data path, with `--db` override support.
- Load tool-part JSON blobs, filter to Python tool entries with inline `code`, and re-run `analyze()`.
- Report unknown callables with counts, session IDs, titles, timestamps, and bounded code previews.
- Keep v1 read-only by default.

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `feat: add saved-session python callable report`

#### Notes

- Status: Done (2026-03-06)
- Summary: Added a read-only `src/python-session-report.ts` utility that scans saved inline Python tool snippets from the OpenCode SQLite database, re-runs the analyzer, and reports grouped unknown callables in text or JSON form.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/45-python-json-rules-and-session-report.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: Phase 4 can build on this utility by writing findings into `src/python/python-rules.json` candidates.
- Commit: `eb9cb7f`
- PR/Jira: None

### Phase 4 - Add JSON update mode for report findings

**Goal:** Let the periodic utility update shared rule data without touching plugin code.

**Files:**

- `src/python-session-report.ts`
- `src/python/python-rules.json`
- `.opencode/test/python-session-report.test.ts`

**Changes:**

- Add an explicit write mode such as `--update-candidates`.
- Merge newly found unknown callables into `candidates.unknown` with deterministic ordering.
- Store bounded evidence such as count, last-seen timestamp, and a few example session IDs.
- Keep automatic writes out of live `read` / `write` / `exec` sections in v1.

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `feat: let session report update python rule candidates`

#### Notes

- Status: Done (2026-03-06)
- Summary: Added explicit `--update-candidates` and `--rules` modes so `src/python-session-report.ts` can merge unknown-call findings into `candidates.unknown` with deterministic ordering, bounded examples, and malformed-shape validation.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/45-python-json-rules-and-session-report.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: Phase 5 should document `--update-candidates` usage and refresh/copy steps for `src/python/python-rules.json`.
- Commit: Not committed
- PR/Jira: None

### Phase 5 - Document the operator workflow

**Goal:** Make JSON-backed rules and periodic reporting maintainable.

**Files:**

- `README.md`
- this plan file

**Changes:**

- Document the new `src/python/python-rules.json` file and its role.
- Update local/global refresh instructions to include the JSON file.
- Add example commands for periodic report runs and candidate updates.
- Document the promotion workflow from `candidates` into active rule buckets.

**Validation:**

- `cd .opencode && bun test`
- relevant module-load smoke checks

**Commit message:**

- `docs: add json-backed python rules workflow`

## Acceptance Criteria

- Declarative analyzer rules are loaded from `src/python/python-rules.json` instead of being hardcoded in TypeScript.
- Existing supported classifications keep their current behavior after the refactor.
- `src/python-session-report.ts` can scan saved sessions and re-analyze inline Python code.
- The utility can report unknown callables without relying on live permission metadata.
- The utility can update the JSON rule file in a deterministic, reviewable way.
- The README explains how to refresh copied installs so the JSON file ships with the analyzer.

## Risks and Mitigations

- **Risk:** A malformed JSON file breaks analyzer startup.
  - **Mitigation:** Add strict load-time validation with actionable error text and focused tests.
- **Risk:** Session-report writes accidentally change live classification semantics.
  - **Mitigation:** Default writes to `candidates` only; make live-rule edits an explicit manual promotion step.
- **Risk:** Historical reports drift as rules evolve.
  - **Mitigation:** Accept this as a non-goal; the utility is for periodic discovery, not exact replay.
- **Risk:** Downstream copied installs forget the new JSON file.
  - **Mitigation:** Update README refresh instructions and smoke checks to include `src/python/python-rules.json`.

## Phase Status

- Phase 1: DONE (2026-03-06)
- Phase 2: DONE (2026-03-06)
- Phase 3: DONE (2026-03-06)
- Phase 4: DONE (2026-03-06)
- Phase 5: TODO
