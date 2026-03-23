---
title: Python Module and Family Review Batching
status: active
plan: 77-python-module-family-review-batching
created: 2026-03-18
tags:
  - type/plan
  - status/active
  - project/opencode-python-tool
  - topic/session-report
  - topic/review-workflow
  - topic/python-rules
---

# Python Module and Family Review Batching

## Objective

Add a module- and family-oriented review workflow on top of `src/python-session-report.ts` so operators can identify repeated unknown call clusters by canonical source, review representative snippets, and drive family-level classification work without starting from one isolated candidate at a time.

## Scope

### In Scope

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

### Out of Scope

- automatic blind promotion of an entire module into live rules without representative evidence review
- replacing the existing snippet-first review loop or TUI
- broad method-name-only rules that ignore receiver provenance
- changing live analyzer behavior or `src/python/python-rules.json` as part of the batching feature itself
- third-party library source scraping or network-backed module introspection

## Current Problem

The repo supports snippet-first review (`--review-next`, `--review-tui`) and queue export (`--review-json`), but it does not provide a first-class way to batch candidates by canonical module or callable family. In practice this leaves repeated families such as `pytest.main`, `hashlib.sha256`, regex receiver methods, or Pydantic model APIs scattered across many snippets even when one family-level decision or analyzer expansion would resolve the noise more safely.

## Desired Outcome

- operators can ask for a family/module summary before entering snippet review
- repeated candidates are grouped by stable review-identity-compatible keys such as `canonicalSource`, `sourceCall`, receiver evidence, and alias set
- the workflow labels clusters by recommended action such as `rule`, `provenance`, `manual-split`, or `blocked`
- representative snippets remain inspectable so family-level decisions stay evidence-based
- docs explain how to use the batching workflow to target whole modules instead of one-off candidates

## Design Constraints

- family grouping must never be broader than the existing review identity semantics used for replay and promotion safety
- summaries and drilldown must be read-only navigation tools; they do not change ledger replay or promotion behavior
- the same pending queue should produce stable family keys and recommendation labels across text and JSON output
- representative evidence must preserve variant coverage when aliases, receiver evidence, or unresolved contexts differ

## Commit-Safe Phases

### Phase 1 - Define stable clustering semantics

**Goal:** Build the internal cluster model and invariants first so every later view uses one stable, identity-safe grouping contract.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- this plan file

**Changes:**

- add one shared family-cluster shape derived from the existing pending review queue
- define stable grouping fields such as family key, canonical source, outward alias set, receiver/source evidence, occurrence count, snippet count, and module-root hint when safe
- add a bounded recommendation label such as `rule`, `provenance`, `manual-split`, or `blocked`
- keep local-definition exclusions and review-identity safety aligned with the existing queue logic
- add regression coverage that proves mixed aliases or incompatible evidence stay split or blocked instead of silently merged

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `refactor: add python review family clustering model`

#### Notes

- Status: Done (2026-03-18)
- Summary: Added an internal review-family clustering model in `src/python-session-report.ts` that groups pending queue items by review-identity-compatible family keys, tracks recommendation labels and representative coverage, and keeps same-snippet source/evidence variants distinct for Phase 1 safety.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`
- Follow-ups: Add a same-snippet evidence-only split regression; document or tighten the raw-occurrence vs queue-candidate fingerprint contract for lower-level `--record-decision` flows.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Expose read-only family summary views

**Goal:** Add operator-visible summary commands powered strictly by the Phase 1 model.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

**Changes:**

- add `--review-families` and `--review-families-json`
- render clusters from the Phase 1 model with counts, aliases, evidence summary, and recommendation label
- add safe module-level rollups only when the cluster carries a trustworthy module root (for example provenance-backed direct module families such as `pytest.main`)
- keep the output read-only and explicitly separate family-level triage from actual rule promotion
- document the command surface without yet adding drilldown navigation

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`
- `cd .opencode && bun run ../src/python-session-report.ts --help`

**Commit message:**

- `feat: add python family review summaries`

#### Notes

- Status: Done (2026-03-18)
- Summary: Added read-only `--review-families` and `--review-families-json` views on top of `reviewFamilies()`, including family/module summary reports, text rendering, parse/help wiring, and operator docs without changing replay or promotion behavior.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: Consider an evidence-only same-snippet split regression and clarify the low-level `--record-decision` fingerprint contract if that path becomes part of the family-summary workflow.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Add evidence drilldown and filtered queue pivots

**Goal:** Let operators inspect representative snippets for one family or module while preserving why the cluster is actionable, split, or blocked.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

**Changes:**

- add filtering such as `--family <canonical-source>` or `--module <module-root>` to show only matching queue snippets
- support representative sampling that preserves variant coverage instead of picking only the first few snippets
- carry forward recommendation labels and blocked-state explanations into drilldown output
- keep compatibility with the existing `--review-next` flow by letting the operator pivot from family summary to targeted snippet review
- preserve exact-fingerprint and review-identity semantics; this phase improves navigation, not decision safety rules

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`
- `cd .opencode && bun run ../src/python-session-report.ts --help`

**Commit message:**

- `feat: add python family review drilldown`

#### Notes

- Status: Done (2026-03-18)
- Summary: Added `--family` / `--module` selectors for family summaries and `--review-next`, plus representative-first filtered queue ordering and module-aware drilldown rendering so operators can pivot from family summaries into targeted snippet review without changing decision semantics.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `README.md`, `docs/python-session-report-operator-guide.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: Consider an evidence-only same-snippet split regression if Phase 4/5 expands selector-driven workflows further.
- Commit: Not committed
- PR/Jira: None

### Phase 4 - Document the family-first operator workflow

**Goal:** Document how to use the batching workflow to choose whole modules/families for classification and when to fall back to provenance work instead.

**Files:**

- `README.md`
- `docs/python-session-report-operator-guide.md`
- this plan file

**Changes:**

- document the recommended review sequence: export summary, pick top family, inspect representative snippets, patch rules/analyzer, then re-run the queue
- add guidance on common batchable families already seen in this repo (`pytest`, `hashlib`, stdlib modules, Pydantic model APIs) versus common provenance buckets (regex match/pattern, tracked strings, tracked containers)
- explain recommendation labels (`rule`, `provenance`, `manual-split`, `blocked`) and how to validate a family-level rules draft with compare/suggest flows before promoting changes

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `docs: add python family review workflow`

#### Notes

- Status: Done (2026-03-19)
- Summary: Tightened the README and operator guide around a family-first review sequence: summarize families, choose `rule`/`provenance`/`manual-split`/`blocked` triage, pivot with `--family` or `--module`, validate with `--suggest-rules` or `--compare-rules`, then promote only after representative snippet review agrees.
- Files: `README.md`, `docs/python-session-report-operator-guide.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

### Phase 5 - Optional follow-on classification work

**Goal:** Use the new batching workflow to drive separate analyzer/rules changes, without coupling those classifier edits to the batching feature itself.

**Files:**

- `src/python/python-rules.json`
- `src/python/*.ts` as needed
- `.opencode/test/python-analyze.test.ts`
- relevant runtime tests under `.opencode/test/`
- `docs/python-classification-reference.md`
- follow-on family/module plan files as needed

**Changes:**

- choose one family at a time from the new summaries (`pytest`, `hashlib`, Pydantic model APIs, provenance gaps, etc.)
- implement rules or provenance fixes as separate commit-safe patches
- keep each family/module expansion independently testable and reviewable

**Validation:**

- targeted analyzer/runtime tests for the chosen family

**Commit message:**

- `feat: classify <family>`

#### Notes

- Status: In progress (2026-03-19)
- Summary: Used the batching workflow to land four concrete follow-on families (`pytest.main`, `hashlib.sha256`, `collections.Counter`, and narrow `importlib` exact-call support), then pivoted to provenance cleanup. The current provenance work now covers trusted compiled regex patterns, tracked string split locals, bounded same-scope helper-parameter string seeding, trusted `dir()` / `sorted(dir(...))` string-origin flows, exact `__dict__.items()` introspection, and conservative importlib metadata module-binding parity, while keeping mutation-built exact receiver-path string lists intentionally blocked pending a narrower proof. The refreshed family summary is down to `47` pending candidates across `42` blocked families with `0` module rollups.
- Files: `src/python/python-rules.json`, `src/python/python-scope.ts`, `src/python/python-analyze.ts`, `src/python/python-classifier.ts`, `src/python/python-inference.ts`, `src/python/python-known-methods.ts`, `src/python/python-provenance.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`
- Follow-ups: Pick the next provenance bucket after helper/dir string-origin seeding (still the remaining `e.split` / `e.startswith` cases driven by deeper value-origin gaps), keep mutation-built exact receiver-path string lists conservative until a homogeneity proof exists, consider `tabulate` only if a narrow pure-family proof emerges, and keep Pydantic model APIs blocked unless future provenance support can prove `model_fields`-style metadata access without broadening validator/serializer hooks.
- Commit: Not committed
- PR/Jira: None

## Risks and Guardrails

- grouping by outward call alone is unsafe; batching must prefer canonical/source-aware identities and receiver evidence
- module roots inferred from display strings can be misleading for local variables (`pat.search`, `m.group`), so provenance-gap labeling must stay conservative
- family summaries should stay read-only until the operator has inspected representative snippets
- suggestion/promote flows must not silently turn family summaries into live rules without the existing safety checks

## Acceptance Criteria

- operators can get a stable family/module summary of the pending queue without entering one-candidate-at-a-time review
- summaries distinguish between direct module-family opportunities and likely provenance gaps
- the same pending queue yields stable family keys and recommendation labels across text summaries, JSON summaries, and drilldown filters
- operators can drill from a family summary into representative snippets without losing existing review safety semantics
- docs describe a family-first workflow for choosing classification targets and validating family-level rule changes
- batching does not change review replay or promotion safety semantics

## Phase Status

- Phase 1: DONE (2026-03-18)
- Phase 2: DONE (2026-03-18)
- Phase 3: DONE (2026-03-18)
- Phase 4: DONE (2026-03-19)
- Phase 5: IN PROGRESS (2026-03-19)
