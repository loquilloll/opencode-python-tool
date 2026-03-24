---
title: Python Analyzer Modularization
status: done
plan: 73-python-analyzer-modularization
created: 2026-03-13
updated: 2026-03-23
tags:
  - type/plan
  - status/active
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/refactoring
  - topic/static-analysis
---

# Python Analyzer Modularization

## Objective

Break `src/python/python-analyze.ts` into smaller analyzer modules while keeping `analyzeDetailed()` and `analyze()` behavior stable, preserving the current permission contract, and making future classifier changes land in focused seams instead of one large file.

## Scope

### In Scope

- `src/python/python-analyze.ts`
- new focused modules under `src/python/`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python-inline-permissions-basic.test.ts`
- `.opencode/test/python-inline-permissions-inference.test.ts`
- `docs/python-classification-system-design.md`
- `README.md`
- this plan file

### Out of Scope

- changing the public analyzer API or output shape
- widening classifier coverage as part of the refactor itself
- changing permission-planning behavior in `src/python.ts`
- broad parser-front-end redesign beyond the existing `src/python/frontend/` seam
- full interprocedural or whole-program Python analysis

## Design Direction

The current analyzer already has partial seams in `src/python/python-ir.ts`, `src/python/python-values.ts`, `src/python/python-provenance.ts`, `src/python/python-rule-schema.ts`, `src/python/python-guard-eval.ts`, and `src/python/frontend/`. This plan continues that layering by extracting the remaining clusters from `src/python/python-analyze.ts` into explicit modules.

Historical notes below may mention the earlier `.opencode/test/python.test.ts` runtime suite from March 2026; that coverage now lives in `.opencode/test/python-inline-permissions-basic.test.ts` and `.opencode/test/python-inline-permissions-inference.test.ts`.

### Target module boundaries

- shared types and static data: `Scope`, `Rules`, `TimelineEntry`, `PathSpec`, Atlassian type aliases, pure-method sets, builtin guard sets, HTTP/network constants, and effect-kind maps
- analyzer bootstrap: rules loading, JSON validation, and frontend caching
- outward event contract: event folding, dedupe, and result assembly
- scope and import helpers: bindings, invalidation, direct-import canonicalization, and tracked-instance lookups
- timeline builder: assignment, definition, import, rebind, and call timeline collection
- replay and inference helpers: assignment/rebind replay plus path, container, iterable, and receiver inference
- call classifier: builtin, guarded, HTTP, SDK, and fallback classification
- thin orchestrator: parse, build timeline, replay entries, fold results, and export `analyzeDetailed()` / `analyze()`

### Module dependency direction

Extracted modules must form a strict DAG. The enforced import direction is:

```
orchestrator (python-analyze.ts)
  -> classifier
  -> inference
  -> scope
  -> timeline
  -> event-contract
  -> bootstrap
  -> shared types / static data
  -> existing seams (python-ir, python-provenance, python-rule-schema, python-guard-eval, frontend)
```

A module may import from any module below it in the stack but never from a module above it. In particular:
- the classifier may import from inference, scope, timeline, event-contract, types, and existing seams, but never from the orchestrator
- inference may import from scope, timeline, event-contract, and types, but never from the classifier or orchestrator
- scope, timeline, and event-contract import only from types and existing seams

### End-state file hierarchy

After all phases complete, `src/python/` will contain the original seam modules unchanged plus seven new modules extracted from the monolith. The thin orchestrator retains the public entry points.

```
src/python/
│
│── python-analyze.ts              ← thin orchestrator (~200 lines)
│                                    exports: analyzeDetailed(), analyze()
│                                    re-exports: PythonEventKind, PythonEvent
│
│── python-analyze-types.ts        ← NEW: shared internal types (~60 lines)
│                                    Scope, Rules, TimelineEntry, PathSpec,
│                                    PythonEventKind, PythonEvent,
│                                    AtlassianClientFamily, AtlassianCtor
│
│── python-known-methods.ts        ← NEW: static data tables (~440 lines)
│                                    LIST_PURE_METHODS, DICT_PURE_METHODS, …
│                                    SHADOW_GUARDED_PURE_BUILTINS, …
│                                    HTTP_REQUEST_CALL_BASES, EFFECT_KIND, …
│                                    CALLABLE_UNKNOWN_PREFIX, RULES_VERSION, FAMILIES
│
│── python-bootstrap.ts            ← NEW: rules + frontend loading (~170 lines)
│                                    loadRules, readRules, getFrontend,
│                                    JSON validation helpers
│
│── python-events.ts               ← NEW: outward event contract (~100 lines)
│                                    effect, pathEffect, foldResolvedEffect,
│                                    unique, analysisResult
│
│── python-scope.ts                ← NEW: scope + import helpers (~200 lines)
│                                    scope factory, lookupBinding, resolveQualified,
│                                    importBindings, shouldBindDirectImport,
│                                    tracked-instance lookups
│
│── python-timeline.ts             ← NEW: timeline builder (~100 lines)
│                                    collectTimeline, assignmentLeft/Right,
│                                    rebindTarget, definitionNode/Name,
│                                    pathFromPathMethod
│
│── python-inference.ts            ← NEW: replay + inference (~500 lines)
│                                    value, args, containerKind, trackedPathValue,
│                                    iterableElementKind, rebindContainerKinds,
│                                    rebindPathValues, kind resolution helpers
│
│── python-classifier.ts           ← NEW: call classification (~320 lines)
│                                    classify, classifyOpen, classifyOpenAtPath,
│                                    classifyHttpRequestFallback,
│                                    classifyGuardedHttpRequest,
│                                    Atlassian/GHAPI/evidence helpers
│
│   ── existing seam modules (unchanged) ──
│
│── python-ir.ts                     IR types, analyzerMetadata()
│── python-values.ts                 PythonValue, PythonArgs
│── python-provenance.ts             receiver/container provenance tracking
│── python-rule-schema.ts            rule parsing, GuardedRules
│── python-guard-eval.ts             guard predicate evaluation
│── python-rules.json                declarative classification rules
│── python.txt                       tool prompt guidance
│── env.d.ts                         environment type declarations
│
└── frontend/
    ├── interface.ts                 AST node/tree/frontend contracts
    └── tree-sitter.ts               tree-sitter frontend implementation
```

**Before vs after:**

| Metric | Before | After |
|--------|--------|-------|
| `python-analyze.ts` lines | ~2,319 | ~200 |
| Module count under `src/python/` | 11 | 18 |
| Largest non-data file | 2,319 lines | ~500 lines |
| Internal functions in monolith | 106 | 0 (distributed) |

Line estimates are approximate and may shift during extraction; the constraint is that no single extracted module should exceed ~500 lines.

### Refactor constraints

- preserve exact `PythonEvent[]` behavior for both `analyzeDetailed()` and `analyze()`
- preserve event ordering after `unique()` and keep `sourceCall`, `dynamicPath`, and `evidence` unchanged
- preserve sentinel outcomes: `empty-source`, `parse-error`, and `no-calls-detected`, plus the existing `no-classified-call` fallback branch even though no deterministic public reproducer is currently known
- keep comprehension rebinding, assignment invalidation, and direct-import binding behavior byte-for-byte unless a later plan explicitly changes semantics
- avoid introducing import cycles between any extracted modules
- extracted inference helpers receive `Scope` as a mutable reference parameter and mutate it in place, preserving current call-site semantics until a later plan introduces a narrower interface

## Commit-Safe Phases

### Phase 1 - Freeze seams and parity targets

**Goal:** Define the internal boundaries and exact parity gates before moving code.

**Files:**

- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- this plan file

**Changes:**

- document the extraction seams and module responsibilities in this plan
- identify the must-not-change analyzer outputs and sentinel events
- add snapshot-style parity tests that capture the full `PythonEvent[]` output (including event order, evidence shape, `sourceCall`, and `dynamicPath`) for a representative set of inputs spanning: builtin, guarded, HTTP, Path, GHAPI, Atlassian, subprocess, comprehension rebinding, assignment invalidation, direct-import canonicalization, and the reachable sentinel outcomes
- existing focused regressions remain; the snapshot tests add a second parity gate that catches ordering or evidence drift that individual assertions might miss

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`

**Commit message:**

- `test: lock python analyzer refactor parity`

#### Notes

- Status: Done (2026-03-13)
- Summary: Added explicit Phase 1 parity fixtures that freeze full `analyzeDetailed()` event arrays across representative analyzer domains and added runtime smoke checks for analyzer-to-permission metadata projection. Existing focused regressions remain in place as narrower behavioral guards, while the unreproduced `no-classified-call` fallback stays documented as a preserved branch.
- Files: `.opencode/test/python-analyze.test.ts`, `.opencode/test/python.test.ts`, `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python.test.ts`
- Follow-ups: `empty-source` remains analyzer-only because the runtime rejects empty inline/script input before permission planning. `no-classified-call` remains documented in `src/python/python-analyze.ts`, but no deterministic public source fixture was found because current call shapes fall back to `dynamic-call` or `callable:*` unknown events before that sentinel.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Extract shared types and static data tables

**Goal:** Move all internal type definitions and static constant tables out of `python-analyze.ts` into neutral modules so that every subsequent extraction phase can import types and data without back-importing from the monolith.

**Files:**

- `src/python/python-analyze.ts`
- `src/python/python-analyze-types.ts` (new)
- `src/python/python-known-methods.ts` (new)
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- extract `PythonEventKind`, `PythonEvent`, `Scope`, `Rules`, `TimelineEntry`, `PathSpec`, `AtlassianClientFamily`, and `AtlassianCtor` type definitions to `python-analyze-types.ts`
- extract all static constant tables (~440 lines) to `python-known-methods.ts`: pure-method sets (`LIST_PURE_METHODS`, `DICT_PURE_METHODS`, `SET_PURE_METHODS`, `STRING_PURE_METHODS`, `BYTES_PURE_METHODS`, `PATH_PURE_METHODS`, etc.), builtin guard sets (`SHADOW_GUARDED_PURE_BUILTINS`, `SHADOW_GUARDED_READ_BUILTINS`, `SHADOW_GUARDED_EXEC_BUILTINS`, etc.), HTTP/network constants (`TRACKED_HTTP_CLIENT_CONSTRUCTORS`, `HTTP_REQUEST_CALL_BASES`, `HTTP_REQUEST_METHOD_SUFFIXES`, etc.), and the `EFFECT_KIND` map
- also extract infra constants: `CALLABLE_UNKNOWN_PREFIX`, `RULES_VERSION`, `RULES_URL`, `FAMILIES`
- `python-analyze.ts` re-exports `PythonEventKind` and `PythonEvent` to keep the public surface unchanged

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `refactor: extract python analyzer shared types and static data`

#### Notes

- Status: Done (2026-03-13)
- Summary: Extracted shared analyzer types into `src/python/python-analyze-types.ts` and moved static method/HTTP/guard/infra tables into `src/python/python-known-methods.ts`, leaving `src/python/python-analyze.ts` to import those seams while preserving its public exports.
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-known-methods.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: `PythonAnalyzeResult` intentionally remains in `src/python/python-ir.ts` to avoid creating a new type cycle during this move-only phase. Consider adding an earlier import-cycle check once later extraction phases add more module edges.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Extract analyzer bootstrap

**Goal:** Move low-risk rules/frontend bootstrap code out of `python-analyze.ts`.

**Files:**

- `src/python/python-analyze.ts`
- new bootstrap-oriented module(s) under `src/python/`
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- extract rules loading, JSON shape validation helpers (`fail`, `record`, `list`, `listOrEmpty`, `num`, `spec`, `specs`, `family`, `ctors`, `loadRules`, `readRules`), and cache reset behavior
- extract frontend loading and parser memoization helpers (`getFrontend`)
- keep analyzer error behavior unchanged for missing rules or parse failures

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `refactor: extract python analyzer bootstrap`

#### Notes

- Status: Done (2026-03-13)
- Summary: Moved rules loading, JSON validation, and frontend cache/bootstrap helpers into `src/python/python-bootstrap.ts` while keeping `src/python/python-analyze.ts` as the caller of `loadRules()` before parse and preserving the existing analyzer API surface.
- Files: `src/python/python-analyze.ts`, `src/python/python-bootstrap.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: Consider a later targeted cache-switching test for `OPENCODE_PYTHON_RULES` overrides if Phase 3 bootstrap behavior starts changing. Public analyzer exports remain `analyzeDetailed`, `analyze`, and the `PythonEvent` / `PythonEventKind` re-export seam.
- Commit: Not committed
- PR/Jira: None

### Phase 4 - Extract outward event contract helpers

**Goal:** Isolate the outward event/result bridge before moving deeper analyzer logic.

**Files:**

- `src/python/python-analyze.ts`
- new event/result helper module under `src/python/`
- `src/python/python-ir.ts` if needed
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- extract `PythonEvent` helpers such as `effect()`, `pathEffect()`, `foldResolvedEffect()`, `unique()`, and result assembly (`analysisResult`)
- these helpers import only outward contract and IR/value types from extracted seam modules, without depending on analyzer state or scope mutation helpers
- keep the outward `analyzeDetailed()` and `analyze()` contract unchanged
- preserve evidence folding and path rendering semantics exactly

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`

**Commit message:**

- `refactor: extract python analyzer event folding`

#### Notes

- Status: Done (2026-03-13)
- Summary: Extracted outward event/result helpers into `src/python/python-events.ts`, keeping `src/python/python-analyze.ts` as the orchestrator that classifies calls and then folds resolved effects into the stable public `PythonEvent[]` contract.
- Files: `src/python/python-analyze.ts`, `src/python/python-events.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `.opencode/test/python.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test`
- Follow-ups: Existing parity fixtures already cover `sourceCall`, `dynamicPath`, evidence folding, and sentinel outputs. Add direct `unique()` / `foldResolvedEffect()` micro-regressions later only if future refactors make the helper boundary harder to reason about.
- Commit: Not committed
- PR/Jira: None

### Phase 5 - Extract scope and import helpers

**Goal:** Pull the mutable scope/binding layer into a dedicated seam without changing replay behavior.

**Files:**

- `src/python/python-analyze.ts`
- new scope-oriented module(s) under `src/python/`
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- extract `Scope` factory (`scope()`), binding lookup (`lookupBinding`, `hasBoundName`), qualified-name resolution (`resolveQualified`, `resolvedName`), invalidation (`clearTrackedName`, `invalidateTrackedName`), callable-factory helpers (`lookupCallableFactory`, `callableFactory`, `callableFactoryTarget`), and tracked instance lookup helpers (`hasGhapiInstance`, `atlassianInstance`, `httpClientInstance`, `hasHttpResponseInstance`, `containerInstance`, `iteratedElementInstance`, `iteratedPathInstance`, `pathInstanceValue`)
- extract import parsing (`importBindings`) and direct-import binding decisions (`shouldBindDirectImport()`)
- preserve canonicalization for `re`, `inspect`, HTTP request helpers, and tracked constructors

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `refactor: extract python analyzer scope helpers`

#### Notes

- Status: Done (2026-03-13)
- Summary: Extracted mutable scope, binding resolution, invalidation, tracked-instance lookup, import parsing, and direct-import binding helpers into `src/python/python-scope.ts` while preserving replay order and current canonicalization behavior.
- Files: `src/python/python-analyze.ts`, `src/python/python-scope.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: `callableFactoryTarget()` currently accepts caller-supplied parsed args to avoid pulling Phase 7 argument parsing into the scope seam. Consider tightening that boundary when inference helpers move later.
- Commit: Not committed
- PR/Jira: None

### Phase 6 - Extract timeline builder

**Goal:** Move syntax-to-timeline collection into its own module before moving replay or classification logic.

**Files:**

- `src/python/python-analyze.ts`
- new timeline-oriented module under `src/python/`
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- extract assignment/rebind target helpers (`assignmentLeft`, `assignmentRight`, `assignedNames`, `parameterNames`, `rebindTarget`, `definitionNode`, `definitionName`) and `collectTimeline()`
- extract path-from-method helpers (`pathFromPathMethod`, `canonicalPathMethodCall`)
- preserve current source-order semantics for definitions, imports, assignments, raises, and rebinding sites
- preserve the current comprehension-specific ordering that seeds `for_in_clause` targets before body calls

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `refactor: extract python analyzer timeline builder`

#### Notes

- Status: Done (2026-03-13)
- Summary: Extracted syntax-to-timeline collection into `src/python/python-timeline.ts`, keeping the analyzer as the replay/classification orchestrator while preserving decorated-definition, loop/except rebinding, and comprehension ordering semantics.
- Files: `src/python/python-analyze.ts`, `src/python/python-timeline.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test`
- Follow-ups: `pathFromPathMethod()` now uses a caller-supplied tracked-path callback so the timeline seam stays below inference/scope logic in the dependency DAG. Add a direct comprehension-order micro-regression later only if this seam becomes harder to reason about.
- Commit: Not committed
- PR/Jira: None

### Phase 7 - Extract replay and inference helpers

**Goal:** Isolate assignment/rebind support and the dense value/path/container inference cluster behind imported helpers while keeping replay sequencing in the orchestrator.

**Files:**

- `src/python/python-analyze.ts`
- new inference-oriented module(s) under `src/python/`
- `src/python/python-values.ts` if needed
- `src/python/python-provenance.ts` if needed
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- this plan file

**Changes:**

- extract argument/value parsing (`value`, `args`, `pick`, `parseString`), path tracking (`trackedPathValue`), container inference (`containerKind`, `directTemporaryContainerKind`, `trackedContainerKind`, `trackedReceiverContainerKind`, `returnedTrackedContainerKind`, `pureContainerMethod`), iterable inference (`generatorElementKind`, `homogeneousContainerKind`, `comprehensionElementKind`, `iterableElementKind`), kind resolution (`isBytesLiteralText`, `bytesKind`, `matchKind`, `numericKind`, `stringKind`), and rebinding helpers (`rebindSource`, `iteratedPathValue`, `iteratedContainerKind`, `enumeratedElementKind`, `enumeratedPathValue`, `rebindContainerKinds`, `rebindPathValues`)
- extracted inference helpers receive `Scope` as a mutable reference parameter and mutate it in place; this preserves the current call-site pattern where `analyzeDetailed()` passes a scope object and inference helpers read/write its fields directly
- orchestrator-owned replay order remains in `python-analyze.ts`, but the replay branches now delegate to extracted helpers for parsing, inference, and seeding behavior
- `aliasTarget()` remains in `python-scope.ts`, and response-json / builtin-pure support helpers move with inference to avoid a temporary cycle back into the classifier/orchestrator seam
- preserve assignment invalidation, receiver provenance seeding, and tracked iterated element/path behavior

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `refactor: extract python analyzer inference`

#### Notes

- Status: Done (2026-03-13)
- Summary: Extracted parsing, value/path/container inference, iterable/rebinding helpers, response-json inference, and builtin-pure support logic into `src/python/python-inference.ts`, while keeping replay sequencing and high-level classification orchestration in `src/python/python-analyze.ts`.
- Files: `src/python/python-analyze.ts`, `src/python/python-inference.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `.opencode/test/python.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test`
- Follow-ups: Consider adding direct micro-tests for comprehension rebind ordering and module-boundary checks once later phases add more seams. `aliasTarget()` intentionally stays in `python-scope.ts` so inference does not back-import into scope/timeline helpers.
- Commit: Not committed
- PR/Jira: None

### Phase 8 - Extract call classification

**Goal:** Move the fan-in classifier only after the inference and scope APIs are stable.

**Files:**

- `src/python/python-analyze.ts`
- new classifier-oriented module(s) under `src/python/`
- `src/python/python-rule-schema.ts` if needed
- `src/python/python-guard-eval.ts` if needed
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- this plan file

**Changes:**

- extract builtin, guarded, HTTP, Path, GHAPI, Atlassian, subprocess, and fallback classification helpers around `classify()`
- extract HTTP classification helpers (`httpRequestMethod`, `trackedHttpRequestBase`, `hasGenericHttpRequestSuffix`, `isHttpResponseCall`, `classifyHttpRequestFallback`, `classifyGuardedHttpRequest`)
- extract Atlassian helpers (`isAtlassianImportStatement`, `isAtlassianConstructorCall`, `atlassianFamilyForConstructor`)
- extract evidence helpers (`receiverEvidence`, `guardedCallEffect`, `guardedMethodEffect`, `hasLocalDefinition`, `localDefinitionEvidence`)
- extract open-file classification (`classifyOpen`, `classifyOpenAtPath`)
- move `classifyRaise()` with the classifier seam so call/raise effect resolution lives in one module while the orchestrator still owns replay order and event folding
- preserve guard-failure evidence, local-definition unknown behavior, and canonical/source-call folding
- enforce the dependency direction: classifier imports from inference, scope, timeline, event-contract, types, and existing seams, but never from the orchestrator; inference never imports from the classifier

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`
- verify no import cycles: `npx madge --circular src/python/` or equivalent grep-based check

**Commit message:**

- `refactor: extract python analyzer classifier`

#### Notes

- Status: Done (2026-03-13)
- Summary: Extracted the remaining call-classification helpers into `src/python/python-classifier.ts`, including open/path/HTTP/guarded/Atlassian/GHAPI/fallback logic plus `classifyRaise()`, while keeping `src/python/python-analyze.ts` as the replay-and-fold orchestrator.
- Files: `src/python/python-analyze.ts`, `src/python/python-classifier.ts`, `.opencode/test/python-analyze.test.ts` (validation only, unchanged), `.opencode/test/python.test.ts` (validation only, unchanged), `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python.test.ts`; `cd .opencode && bun test`; custom import-graph cycle check over `src/python/*.ts` reported `NO_CYCLES`
- Follow-ups: The current test suite exercises the live source via `.opencode/tool/python-analyze.ts`, which re-exports `src/python/python-analyze.ts`. Add direct module-boundary or cycle-check automation later if Phase 9 doc refresh makes the dependency DAG part of ongoing CI enforcement.
- Commit: Not committed
- PR/Jira: None

### Phase 9 - Leave a thin orchestrator and refresh docs

**Goal:** Reduce `python-analyze.ts` to orchestration only and update documentation to match the new layout.

**Files:**

- `src/python/python-analyze.ts`
- `README.md`
- `docs/python-classification-system-design.md`
- this plan file

**Changes:**

- keep `analyzeDetailed()` and `analyze()` as the stable public surface in `src/python/python-analyze.ts`
- make `python-analyze.ts` primarily compose parse, timeline, replay, classification, and fold-down helpers
- `python-analyze.ts` re-exports `PythonEventKind` and `PythonEvent` from `python-analyze-types.ts` for backward compatibility
- refresh `README.md` and `docs/python-classification-system-design.md` to describe the new module boundaries
- update the architecture diagram to reflect the extracted modules and their dependency direction

**Validation:**

- `cd .opencode && bun test`
- verify no import cycles: `npx madge --circular src/python/` or equivalent grep-based check

**Commit message:**

- `docs: refresh python analyzer module boundaries`

#### Notes

- Status: Done (2026-03-13)
- Summary: Trimmed `src/python/python-analyze.ts` down to a clearer public orchestrator surface, restored the public type re-export seam, and refreshed `README.md` plus `docs/python-classification-system-design.md` to document the extracted analyzer module layout and copy/refresh requirements.
- Files: `src/python/python-analyze.ts`, `README.md`, `docs/python-classification-system-design.md`, `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test`; custom import-graph cycle check over `src/python/*.ts` reported `NO_CYCLES`
- Follow-ups: `python-analyze.ts` is now a thin orchestrator, but replay branches still own ordered scope mutation inline. Extract those only if a future plan needs an even narrower orchestration seam.
- Commit: Not committed
- PR/Jira: None

### Phase 10 - Extract replay handlers and helper-seed discovery

**Goal:** Move the stateful replay branches and helper-seed prepass out of `python-analyze.ts` so the public entrypoint stays orchestration-only while preserving replay order and mutation invalidation semantics.

**Files:**

- `src/python/python-analyze.ts`
- `src/python/python-replay.ts` (new)
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python-inline-permissions-basic.test.ts`
- `README.md`
- `docs/python-classification-system-design.md`
- this plan file

**Changes:**

- extract replay handlers for import, definition, rebind, and assignment entries into `src/python/python-replay.ts`
- move helper-seed discovery and mutation invalidation helpers into the replay seam so both replay passes share one implementation
- keep `analyzeDetailed()` responsible only for parse, timeline construction, two-pass replay orchestration, classification dispatch, and final event folding
- refresh docs so replay-specific guidance points at `src/python/python-replay.ts` instead of the public orchestrator

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`

**Commit message:**

- `refactor: extract python analyzer replay seam`

#### Notes

- Status: Done (2026-03-23)
- Summary: Extracted the ordered replay handlers, helper-seed discovery pass, and mutation invalidation helpers into `src/python/python-replay.ts`, leaving `src/python/python-analyze.ts` as a small public orchestrator that composes the two replay passes with classification and event folding.
- Files: `src/python/python-analyze.ts`, `src/python/python-replay.ts`, `README.md`, `docs/python-classification-system-design.md`, `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`
- Follow-ups: `src/python/python-inference-containers.ts` still holds the densest container/rebind logic; if future provenance work keeps landing there, split return-kind or iterable helpers again without moving replay ownership back into the orchestrator.
- Commit: Not committed
- PR/Jira: None

### Phase 11 - Split inference into focused helper modules

**Goal:** Break the oversized inference seam into smaller modules while preserving the public `python-inference.ts` import surface for callers.

**Files:**

- `src/python/python-inference.ts`
- `src/python/python-inference-values.ts` (new)
- `src/python/python-inference-effects.ts` (new)
- `src/python/python-inference-paths.ts` (new)
- `src/python/python-inference-containers.ts` (new)
- `src/python/python-classifier.ts`
- `src/python/python-replay.ts`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python-inline-permissions-basic.test.ts`
- `README.md`
- `docs/python-classification-system-design.md`
- this plan file

**Changes:**

- turn `src/python/python-inference.ts` into a small barrel that re-exports focused inference modules
- extract literal/argument parsing into `src/python/python-inference-values.ts`
- extract builtin-purity, response-json, and splat helpers into `src/python/python-inference-effects.ts`
- extract tracked path and iterated-path helpers into `src/python/python-inference-paths.ts`
- move the remaining container, receiver, iterable, and rebind-kind logic into `src/python/python-inference-containers.ts`
- update docs and install-sync file lists to include the new inference submodules

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`

**Commit message:**

- `refactor: split python inference helpers`

#### Notes

- Status: Done (2026-03-23)
- Summary: Replaced the monolithic inference file with a small public barrel plus focused value/effect/path/container helper modules, keeping existing callers on `src/python/python-inference.ts` while shrinking the core entry files that new analyzer work most often touched.
- Files: `src/python/python-inference.ts`, `src/python/python-inference-values.ts`, `src/python/python-inference-effects.ts`, `src/python/python-inference-paths.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `src/python/python-analyze.ts`, `README.md`, `docs/python-classification-system-design.md`, `docs/plans/73-python-analyzer-modularization.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`
- Follow-ups: `src/python/python-inference-containers.ts` is still the largest remaining behavior-heavy file at roughly the high-500-line range, so any future size-budget cleanup should split that module next without disturbing the stable barrel API.
- Commit: Not committed
- PR/Jira: None

## Rollout Gates

- no change in outward `analyzeDetailed()` or `analyze()` results across the focused analyzer suite
- no regression in comprehension rebinding, assignment invalidation, or direct-import canonicalization coverage
- no loss of guard-failure evidence, local-definition evidence, or path metadata
- no new import cycles between extracted modules (verified by cycle-detection check in Phases 8 and 9)
- docs and plan status updates land with the same change that alters module boundaries

## Acceptance Criteria

- `src/python/python-analyze.ts` becomes an orchestration layer instead of the home for every analyzer concern
- shared types, static data, bootstrap, scope, timeline, inference, and classifier logic each live in focused modules under `src/python/`
- the public analyzer contract remains stable for `src/python.ts` and `src/python-session-report.ts`
- the module dependency graph forms a strict DAG with no cycles
- focused and full test suites stay green after each commit-safe phase
- documentation accurately describes the new module boundaries and analyzer flow

## Phase Status

- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
- Phase 5: DONE
- Phase 6: DONE
- Phase 7: DONE
- Phase 8: DONE
- Phase 9: DONE
- Phase 10: DONE
- Phase 11: DONE
