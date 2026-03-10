---
title: Python Analyzer Architecture Evolution
status: done
plan: 71-python-analyzer-architecture-evolution
created: 2026-03-10
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/review-workflow
  - topic/permissions
---

# Python Analyzer Architecture Evolution

## Objective

Turn the current bounded classifier into a layered effect-analysis engine by formalizing the internal IR, adding an analyzer comparison harness, preparing bounded provenance-graph evolution, and preserving the live permission contract until rollout gates are met.

## Scope

### In Scope

- `src/python/python-analyze.ts`
- `src/python/python-ir.ts`
- `src/python/python-values.ts`
- `src/python-session-report.ts`
- `src/python.ts`
- `src/python/python-rules.json`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

### Out of Scope

- full interprocedural or whole-program Python analysis
- generic method-suffix heuristics
- live LLM classification on the permission path
- widening beyond today's bounded provenance limits unless saved-session evidence justifies it

## Commit-Safe Phases

### Phase 0 - Baseline harness and rollout switches

**Goal:** Create a safety harness before structural refactors.

**Files:**

- `src/python/python-analyze.ts`
- `src/python/python-ir.ts`
- `src/python-session-report.ts`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

**Changes:**

- add `analyzerVersion` and `engineVersion` metadata to analyzer results, runtime metadata, and review/report outputs
- add the temporary analyzer rollout switches used during the staged migration (later removed once the mainline path stabilized)
- add analyzer metadata and rollout switches needed for the initial staged migration
- keep the outward permission contract stable while internal analyzer layers are refactored

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python-session-report.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `test: add python analyzer comparison harness`

#### Notes

- Status: Done (2026-03-10)
- Summary: Added analyzer/runtime/review metadata version tags, feature-flag resolution, and a saved-session analyzer comparison mode without changing outward `PythonEvent[]` behavior.
- Follow-ups: Completed; later phases no longer retain the temporary legacy comparison path.

### Phase 1 - Formalize the internal IR

**Goal:** Make the internal analyzer model explicit while keeping outward `PythonEvent[]` behavior unchanged.

**Files:**

- `src/python/python-analyze.ts`
- `src/python/python-ir.ts`
- `src/python/python-values.ts`
- `.opencode/test/python-analyze.test.ts`
- this plan file

**Changes:**

- extract shared value and IR types into dedicated modules
- keep `foldResolvedEffect()` as the bridge from internal effects to outward `PythonEvent[]`
- preserve the existing analyzer API by exposing `analyzeDetailed()` alongside `analyze()`
- keep `src/python.ts` permission planning stable apart from added analyzer metadata

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`

**Commit message:**

- `refactor: formalize python analyzer IR`

#### Notes

- Status: Done (2026-03-10)
- Summary: Extracted explicit analyzer IR and value types into `src/python/python-ir.ts` and `src/python/python-values.ts`, added `analyzeDetailed()` metadata output, and kept `analyze()` event output stable.
- Follow-ups: Phase 2 is complete and no longer depends on temporary rollout-gate tooling.

### Phase 2 - Replace ad hoc receiver tracking with a bounded dependency graph

**Goal:** Unify receiver provenance and invalidation around symbolic dependencies instead of one-off tracking branches.

**Files:**

- new `src/python/python-provenance.ts`
- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- `README.md`
- this plan file

**Changes:**

- represent tracked values as bounded graph nodes for identifiers, shallow attributes, bounded subscripts, and producer calls
- add generic invalidation on dependency rebind
- migrate current supported receiver-path families onto the graph while preserving current scope and depth limits

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `refactor: unify python provenance invalidation`

#### Notes

- Status: Done (2026-03-10)
- Summary: Extracted bounded receiver/self provenance helpers into `src/python/python-provenance.ts`, then promoted that path into the main analyzer flow after validation.
- Follow-ups: Completed; there is no remaining receiver-provenance fallback path.

### Phase 3 - Add a guarded rule DSL on top of JSON rules

**Goal:** Move more low-risk classification logic out of `python-analyze.ts` and into a strict, versioned JSON schema.

**Files:**

- `src/python/python-rules.json`
- new `src/python/python-rule-schema.ts`
- new `src/python/python-guard-eval.ts`
- `src/python/python-analyze.ts`
- `.opencode/test/python-analyze.test.ts`
- `.opencode/test/python.test.ts`
- `README.md`
- this plan file

**Changes:**

- add bounded guard primitives such as receiver-kind, producer, import-binding, literal-argument, and same-scope checks
- version the rules schema so older rules still load
- migrate low-risk families first: Path methods, builtin pure calls, JSON load/loads, direct HTTP `.request(...)`, and regex/match-result families

**Validation:**

- `cd .opencode && bun test test/python-analyze.test.ts`
- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test`

**Commit message:**

- `feat: add guarded python rule schema`

#### Notes

- Status: Done (2026-03-10)
- Summary: Added guarded-rule schema and evaluator modules, migrated low-risk guarded families for `json.loads`, Path read/write methods, shadow-sensitive builtin purity (including the remaining safe builtin family coverage), direct and tracked HTTP `.request(method, ...)` surfaces, and match-result methods, then removed the remaining legacy analyzer and compare-only fallback paths.
- Follow-ups: Extend guarded rules further only when new bounded evidence justifies more call or method families.

### Phase 4 - Upgrade the review pipeline into a rule-mining pipeline

**Goal:** Turn repeated unknown clusters into reviewable guarded-rule suggestions.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `src/python/python-rules.json`
- `docs/python-session-report-operator-guide.md`
- `README.md`
- this plan file

**Changes:**

- extend review evidence with canonical call, receiver kind, dependency signature, matched guard failures, and source-call context
- add `--suggest-rules` and `--compare-rules <file>` preview workflows
- keep automatic writes out of live rule buckets by default

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`
- `cd .opencode && bun run ../src/python-session-report.ts --help`

**Commit message:**

- `feat: add guarded rule suggestions for python review`

#### Notes

- Status: Done (2026-03-10)
- Summary: Added preview-only `--suggest-rules` and `--compare-rules <file>` workflows to `src/python-session-report.ts`, enriched the analyzer/session-report contract so review and suggestion flows carry receiver kind, dependency signatures, and guard-failure evidence, and exhausted the currently available evidence by adding bounded guarded-method preview synthesis where the evidence is unanimous and safe.
- Follow-ups: Additional rule synthesis should wait for new analyzer evidence beyond the current canonical-source/receiver-kind/guard-failure set.

### Phase 5 - Runtime and review metadata enrichment

**Goal:** Use the richer IR to improve explainability without changing approval semantics.

**Files:**

- `src/python.ts`
- `src/python-session-report.ts`
- `.opencode/test/python.test.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`

**Changes:**

- add optional metadata fields derived from the IR such as canonical source, receiver kind, rule or guard hit, and analyzer version
- keep permission patterns stable by default
- continue excluding `pure` and `emit` from default ask behavior unless explicitly enabled

**Validation:**

- `cd .opencode && bun test test/python.test.ts`
- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `feat: enrich python analyzer metadata`

#### Notes

- Status: Done (2026-03-10)
- Summary: Enriched runtime and review metadata adapters with canonical source, receiver kind, rule-hit, dependency-signature, and guard-failure context from the existing analyzer evidence model, while keeping permission patterns unchanged and preview/report flows read-only.
- Follow-ups: Surface the same enriched metadata in additional operator views only if later UX work justifies more display complexity.

### Phase 6 - Optional parser frontend seam

**Goal:** Keep the semantic engine swappable if tree-sitter fidelity becomes the bottleneck later.

**Files:**

- new `src/python/frontend/interface.ts`
- new `src/python/frontend/tree-sitter.ts`
- `src/python/python-analyze.ts`
- tests and docs as needed

**Changes:**

- introduce a `PythonAstFrontend` adapter boundary
- move tree-sitter-specific node handling behind that interface
- keep the analyzer core operating only on normalized frontend data

**Validation:**

- `cd .opencode && bun test`

**Commit message:**

- `refactor: isolate python parser frontend`

#### Notes

- Status: Done (2026-03-10)
- Summary: Extracted a minimal parser frontend seam into `src/python/frontend/interface.ts` and `src/python/frontend/tree-sitter.ts`, then switched `src/python/python-analyze.ts` to consume that frontend without changing analyzer semantics or test outputs.
- Follow-ups: Only widen the frontend contract if a non-tree-sitter parser or deeper normalized traversal layer is actually introduced later.

## Rollout Gates

- no unexpected increase in `read`, `write`, `exec`, or `unknown` events on the focused test suite
- no net increase in askable events on the saved-session comparison corpus unless intentionally approved
- recent-session queue stays flat or drops
- older backlog drops meaningfully only after guarded-rule promotions
- docs and plan status update in the same change as code

## Acceptance Criteria

- `python-analyze.ts` stops growing through one-off provenance families for each review cluster
- current supported receiver-path cases continue to work
- low-risk rule families can move into guarded JSON without changing permission semantics by default
- session review can produce patch-ready guarded-rule suggestions
- runtime permission behavior stays deterministic and explainable

## Phase Status

- Phase 0: DONE
- Phase 1: DONE
- Phase 2: DONE
- Phase 3: DONE
- Phase 4: DONE
- Phase 5: DONE
- Phase 6: DONE
