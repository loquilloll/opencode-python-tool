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

#### Notes

- Status: In progress (2026-03-23)
- Summary: Extended Phase 5 provenance so the remaining `e.split` / `e.startswith` bucket is no longer pending in the live review queue. The new bounded path covers same-scope lambda helpers, trusted mutation-built exact receiver-path string lists, and trusted dict-subscript string-list iteration while preserving conservative escapes, alias/base mutation invalidation, and mixed-callsite blocking.
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-scope.ts`, `src/python/python-timeline.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The live queue totals dropped to `67` pending candidates across `57` blocked families with `0` module rollups, and `--review-next --family e.split` / `e.startswith` now report no pending items. A follow-up hardening pass may still tighten the root-scoped dict-value string proof used for dynamic subscript builders before moving on to `tabulate`, `text.count` / `text.endswith`, or the remaining blocked path/Pydantic families.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-23)
- Summary: Tightened the follow-on hardening pass by making helper exact-path string seeds scope-aware and preserving direct dict-subscript iteration as conservative in the main pass. Same-scope `def`/lambda helper seeding and exact receiver-path helper calls remain bounded, but one direct dict-subscript `e.split` / `e.startswith` snippet is intentionally back in the blocked queue because we did not ship a root-wide dict proof.
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-scope.ts`, `src/python/python-timeline.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The queue is now `73` pending candidates across `59` blocked families / `36` snippets because the remaining direct dict-subscript builder example stays conservative by design. If we want to remove that snippet safely later, we need a persisted exact-path proof for main-pass dict reads rather than any root-wide dict promotion.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-23)
- Summary: Added an exact-path main-pass proof for direct dict-subscript reads by persisting trusted same-syntax string-list builders into `receiverElementKinds`, then tightened the invalidation surface for escapes, shadowing, alias-root rebinding, alternate-key writes, and raw subscript-to-identifier escapes. Same-syntax reads like `inv[current] -> inv[current]` can now stay pure, while path-mismatched reads like `inv[current] -> inv['literal']` remain conservative.
- Files: `src/python/python-analyze.ts`, `src/python/python-provenance.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The original path-mismatch snippet is still blocked, so the remaining gap is value-level key canonicalization rather than exact-path persistence. The refreshed family totals rose to `103` pending candidates across `77` families / `41` snippets after these repo-local exact-path regression additions changed the scanned session snippet outputs.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Extended the exact-path main-pass proof with bounded value-level key equivalence for exact string keys, so `inv[current]` and `inv['literal']` can share direct-read provenance when the key literal is proven exactly. The invalidation rules now preserve different proven sibling keys while still clearing same-key aliases, alternate-key overwrites, and subscript-to-identifier escapes.
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-key-equivalence.ts`, `src/python/python-provenance.ts`, `src/python/python-replay.ts`, `src/python/python-scope.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The remaining blocked session-report snippet no longer needs same-syntax matching, but it still depends on exact value propagation through derived keys like `line.split(...)[1].strip()`. The next safe reduction in this bucket is exact string-value propagation for bounded pure string derivations and exact iterated literals, not broader dict-root promotion.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Tightened the value-equivalence pass so exact-key proofs survive different proven sibling-key writes but still invalidate on same-key aliases, owner-scope alias-root shadowing, and raw subscript-to-identifier escapes. The final review approved this exact-key boundary; the remaining blocked `e.split` / `e.startswith` session snippet is now specifically about derived-key exact value propagation rather than direct dict-subscript equivalence.
- Files: `src/python/python-key-equivalence.ts`, `src/python/python-provenance.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The queue still reports `44` snippets / `106` pending candidates / `79` families because the surviving `e.split` / `e.startswith` exemplar uses `current = line.split(...)[1].strip()` and other derived exact-key flows. The next safe step is bounded exact string-value propagation for iterated literal lines and pure string derivations, not more subscript-root widening.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Added a bounded exact string-value layer for pure derivations and iterated exact literal lines, then threaded it into the exact-key dict-subscript proof. Exact key equivalence now covers singleton iterated literal-line flows and exact `split`/`rsplit`/`splitlines` plus `strip`-family derivations, while mixed-line or dynamic-origin loops stay conservative without branch narrowing.
- Files: `src/python/python-analyze-types.ts`, `src/python/python-key-equivalence.ts`, `src/python/python-provenance.ts`, `src/python/python-replay.ts`, `src/python/python-scope.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The remaining blocked session-report exemplar still depends on branch-sensitive and dynamic-origin exact values from file-backed `inv_lines`, so the next safe reduction would be explicit control-flow/value narrowing for exact string sets rather than broader key-equivalence widening. Queue totals remain `44` snippets / `106` pending candidates / `79` families after this bounded derivation pass.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Added bounded `if`/`elif` startswith branch narrowing for exact string sets inside timeline replay, so exact keys can now survive mixed literal-line loops when the narrowing condition proves the active line shape. The saved-session `e.split` / `e.startswith` exemplar remains blocked only because its loop source comes from dynamic file content, not because the branch-sensitive literal case is unsupported.
- Files: `src/python/python-analyze-types.ts`, `src/python/python-key-equivalence.ts`, `src/python/python-timeline.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.split`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family e.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: This likely exhausts the safe `e.split` / `e.startswith` reductions inside plan 77 without introducing content-sensitive file reads or broader branch analysis. The remaining exemplar now points at dynamic file-backed exact values, so the next practical work in this bucket would require a larger design change around dynamic-origin data rather than another small provenance patch.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: After exhausting the safe `e.split` / `e.startswith` provenance work, moved automatically to the next blocked string receiver bucket and fixed `text.count` / `text.endswith` by extending iterated path provenance through trusted `sorted(...)` wrappers around identity generator expressions. This keeps the fix on the producer side: `for path in files` now retains `Path` provenance, so `path.read_text()` seeds `text` as a tracked string and the existing pure string-method tables classify both calls without new family-specific rules.
- Files: `src/python/python-inference-paths.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family text.count`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family text.endswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: `text.count` / `text.endswith` now show no pending review items. The refreshed queue is down to `41` snippets / `90` pending candidates / `70` families, and the next likely blocked family is `zlib.decompress` unless another provenance cluster emerges from the refreshed summary.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Replaced the growing hardcoded trusted-call OR chains with a centralized `TRUSTED_CALL_POLICIES` registry and shared `trustedCallWithPolicy()` helper, then used that refactor to land the next bounded producer-side reductions for `zlib.decompress`, bytes slice/split decode chains, and parent-derived path joins. This cleared `zlib.decompress`, `data.decode`, `raw.split.decode`, `raw.split.decode.splitlines`, `target.relative_to`, and `target.with_suffix` without widening unrelated families.
- Files: `src/python/python-known-methods.ts`, `src/python/python-scope.ts`, `src/python/python-classifier.ts`, `src/python/python-inference-containers.ts`, `src/python/python-inference-paths.ts`, `src/python/python-rules.json`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family zlib.decompress`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family data.decode`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family raw.split.decode`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family raw.split.decode.splitlines`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family target.relative_to`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family target.with_suffix`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: The queue is now down to `36` snippets / `62` pending candidates / `55` families. The remaining `e.split` / `e.startswith` and `body.decode` / `text.splitlines` exemplars are larger dynamic/interprocedural provenance gaps, so the next genuinely new small buckets are likely `RequestInformation` or `tabulate` unless another producer-side family proves smaller after re-inspection.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Cleared the next exact-call buckets after the zlib/path work by adding a guarded zero-arg direct-import rule for `kiota_abstractions.request_information.RequestInformation()`, a guarded exact-direct-import rule for `tabulate.tabulate()` with absent-or-literal `tablefmt`, and a conservative `exec` rule for trusted `mypy.api.run()` module bindings/direct imports. These reductions reused the centralized trust registry instead of adding more ad hoc classifier branches.
- Files: `src/python/python-known-methods.ts`, `src/python/python-scope.ts`, `src/python/python-replay.ts`, `src/python/python-rule-schema.ts`, `src/python/python-guard-eval.ts`, `src/python/python-rules.json`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family RequestInformation`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family tabulate`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family api.run`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: `RequestInformation`, `tabulate`, and `api.run` now show no pending review items, bringing the queue down to `31` snippets / `57` pending candidates / `52` families. The remaining top families are either the already-exhausted dynamic string/provenance cluster (`e.split`, `e.startswith`, `text.splitlines`, `body.decode`) or medium-size container/provenance work, so future reductions are less likely to be one-file exact-call patches.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Tightened the new exact-call family work so `exact-direct-import` now means exactly that: `RequestInformation()` and `tabulate()` stay limited to exact unaliased direct imports, while `importlib.import_module()` keeps the broader module-qualified-or-direct-import behavior under a distinct trust policy. This leaves the recent RequestInformation/tabulate/api.run reductions intact while keeping the trust-policy naming and behavior aligned.
- Files: `src/python/python-known-methods.ts`, `src/python/python-scope.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family RequestInformation`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family tabulate`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family api.run`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps(data['totals']))"`
- Follow-ups: With the exact-call buckets aligned and cleared, the remaining queue is dominated by medium-size provenance clusters rather than more registry/rule-only fixes. The next likely productive work is either a new container/value-provenance slice or a decision to leave the remaining dynamic/interprocedural families queued.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Landed the next bounded container/value-provenance slice by teaching the analyzer to track trusted `defaultdict(Counter)` locals as counter-valued mappings and to seed flat `.items()` destructuring with Counter values. The follow-up keeps the bucket conservative under shadowed factories, nested destructuring, widening `update(...)` / `setdefault(...)`, and direct or `setattr(...)` `default_factory` rebinding, which clears `buckets.items` and `counts.most_common` without widening the separate nested `buckets.most_common` family.
- Files: `src/python/python-analyze.ts`, `src/python/python-inference-containers.ts`, `src/python/python-inference-effects.ts`, `src/python/python-provenance.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family buckets.items`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family counts.most_common`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps({'totals': data['totals'], 'families': [f['canonicalSource'] for f in data['families'][:12]]}, indent=2))"`
- Follow-ups: `buckets.most_common` remains blocked because it depends on nested dict-field provenance (`buckets[key]['families']`) rather than flat mapping-value tracking. The next small bucket is likely `cls.__module__.startswith`, while `call.startswith` / `call.endswith` stay part of the larger JSON/tuple provenance cluster.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-24)
- Summary: Cleared the `cls.__module__.startswith` bucket with a deliberately narrow producer proof: only trusted direct imports of `msgraph.GraphServiceClient` / `msgraph.graph_service_client.GraphServiceClient` seed `for cls in GraphServiceClient.__mro__:` so existing string receiver logic can classify `cls.__module__.startswith(...)` as pure. The bucket stays bounded under root shadowing, loop-variable rebinding, wrong-module imports, non-class aliases, direct `cls.__module__ = ...`, alias `alias.__module__ = ...`, and direct or alias `setattr(..., '__module__', ...)` invalidation.
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-inference.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `src/python/python-scope.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family cls.__module__.startswith`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps({'totals': data['totals'], 'families': [f['canonicalSource'] for f in data['families'][:12]]}, indent=2))"`
- Follow-ups: The next smallest bounded bucket is no longer `cls.__module__.startswith`; remaining top work is the already-exhausted dynamic string/bytes cluster plus `buckets.most_common` and a few isolated API families. The most likely next small bucket is `CreateClusterDetails.attribute_map.get` / `CreateClusterDetails.swagger_types.get`, while `call.startswith` / `call.endswith` still look like the larger JSON/tuple provenance problem.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-25)
- Summary: Cleared the exact `CreateClusterDetails.attribute_map.get` / `CreateClusterDetails.swagger_types.get` bucket by seeding those class metadata maps as dict receivers only for the unaliased direct import of `oci.container_engine.models.CreateClusterDetails`, then letting existing dict-method purity classify `.get(...)` as pure. The bucket stays conservative for module-qualified or aliased imports, wrong-module imports, root shadowing, direct or alias attribute assignment, and direct or alias `setattr(...)` invalidation.
- Files: `src/python/python-analyze.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family CreateClusterDetails.attribute_map.get`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family CreateClusterDetails.swagger_types.get`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps({'totals': data['totals'], 'families': [f['canonicalSource'] for f in data['families'][:12]]}, indent=2))"`
- Follow-ups: With the OCI metadata bucket cleared, the queue is down to `29` snippets / `51` pending candidates / `46` families. The remaining top work is still dominated by the exhausted dynamic string/bytes cluster plus `buckets.most_common`; the next likely small isolated bucket is the `cur.fetchone` / `cur.get` / `cur.pop` cluster rather than `call.startswith` / `call.endswith`.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-25)
- Summary: Cleared the `cur.get` / `cur.pop` half of the cursor cluster by teaching conditional-expression container inference to merge only already-compatible container kinds, which lets `cur = json.loads(...) if cond else {}` reuse the existing bounded JSON/dict receiver behavior. The bucket stays conservative for customized `json.loads(...)` calls and incompatible ternary branches, so it does not widen unrelated conditional expressions.
- Files: `src/python/python-inference-containers.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family cur.get`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family cur.pop`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps({'totals': data['totals'], 'families': [f['canonicalSource'] for f in data['families'][:12]]}, indent=2))"`
- Follow-ups: The remaining member of this local cluster is `cur.fetchone`, which is a separate sqlite cursor read-classification problem rather than more JSON/dict provenance. The refreshed queue is now `28` snippets / `49` pending candidates / `44` families; after `cur.fetchone`, the next likely isolated bucket is probably `difflib.unified_diff` rather than the larger `call.startswith` / `call.endswith` cluster.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-25)
- Summary: Cleared the `cur.fetchone` bucket with narrow sqlite-specific receiver tracking: assignments from `sqlite3.connect(...)` seed exact sqlite connection instances, zero-arg `.cursor()` on those connections seeds exact sqlite cursor instances, `.execute(...)` and `.close()` classify as exec on those tracked cursors, and `.fetchone()` classifies as read only after the same live cursor has already executed a query. The implementation stays conservative for alias/rebinding mixes by tying execute state to the tracked cursor object rather than letting later name rebinding launder the proof.
- Files: `src/python/python-analyze-types.ts`, `src/python/python-scope.ts`, `src/python/python-replay.ts`, `src/python/python-classifier.ts`, `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family cur.fetchone`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps({'totals': data['totals'], 'families': [f['canonicalSource'] for f in data['families'][:12]]}, indent=2))"`
- Follow-ups: The cursor cluster is now exhausted. The refreshed queue remains at `28` snippets / `49` pending candidates / `43` families, and the next likely isolated bucket is `difflib.unified_diff` rather than the larger `call.startswith` / `call.endswith` or dynamic string/bytes clusters.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-25)
- Summary: Cleared the `difflib.unified_diff` bucket as a narrow trusted-call family: plain `import difflib; difflib.unified_diff(...)` and exact unaliased direct imports now classify as pure via `module-qualified-or-exact-direct-import` trust gating, while aliased module roots, aliased leaf imports, captured callables, and member mutation through either `difflib` or `alias = difflib` stay conservative. The follow-up hardens replay invalidation so assignment or `setattr(...)` on `unified_diff` clears every still-trusted name resolving to `difflib` before later calls are classified.
- Files: `src/python/python-known-methods.ts`, `src/python/python-rules.json`, `src/python/python-replay.ts`, `src/python/python-analyze.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --review-next --family difflib.unified_diff`; `cd .opencode && bun run ../src/python-session-report.ts --review-families-json | python3 -c "import json,sys; data=json.load(sys.stdin); print(json.dumps({'totals': data['totals'], 'families': [f['canonicalSource'] for f in data['families'][:12]]}, indent=2))"`
- Follow-ups: With `difflib.unified_diff` drained, the queue is `27` snippets / `48` pending candidates / `42` families. The largest remaining work is still the dynamic string/bytes cluster plus `buckets.most_common`; the next likely isolated bucket is `elements` or the small string-local `item.lower` / `f.lower` family rather than `call.startswith` / `call.endswith`.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Added a workspace-scoped OpenCode skill at `.opencode/skills/python-family-batching/` plus supporting scripts that package the live review workflow we have been following in plan 77. The new helpers standardize point-in-time family snapshots, representative snippet extraction, and focused bucket verification while explicitly treating the review DB as live and totals as unstable.
- Files: `.opencode/skills/python-family-batching/SKILL.md`, `.opencode/skills/python-family-batching/scripts/common.sh`, `.opencode/skills/python-family-batching/scripts/queue_snapshot.py`, `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh`, `.opencode/skills/python-family-batching/scripts/review_snippets.py`, `.opencode/skills/python-family-batching/scripts/review_snippets.sh`, `.opencode/skills/python-family-batching/scripts/verify_bucket.sh`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `python3 -m py_compile .opencode/skills/python-family-batching/scripts/queue_snapshot.py .opencode/skills/python-family-batching/scripts/review_snippets.py`; `bash -n .opencode/skills/python-family-batching/scripts/common.sh`; `bash -n .opencode/skills/python-family-batching/scripts/queue_snapshot.sh`; `bash -n .opencode/skills/python-family-batching/scripts/review_snippets.sh`; `bash -n .opencode/skills/python-family-batching/scripts/verify_bucket.sh`; `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --family item.lower --include-representatives`; `.opencode/skills/python-family-batching/scripts/review_snippets.sh --call item.lower`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family item.lower --snapshot`
- Follow-ups: If this skill becomes the default workflow for draining plan 77, the next useful addition is a helper for bounded datetime/helper-return family snapshots or script-level canned report filters for common isolated buckets.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Updated `.opencode/opencode.jsonc` so the workspace explicitly allows running the new `python-family-batching` skill scripts through bash permission rules, both by workspace-relative path and by the repo's absolute path. This keeps the skill operational without relying on permissive defaults.
- Files: `.opencode/opencode.jsonc`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: Read back `.opencode/opencode.jsonc` after patching to verify the new bash allow patterns for `.opencode/skills/python-family-batching/scripts/*` and `/home/alvins/Documents/pgit/opencode-python-tool/.opencode/skills/python-family-batching/scripts/*`
- Follow-ups: If the skill later adds helper binaries outside this folder, extend the explicit bash allow list rather than widening bash permissions globally.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Tightened the workspace skill guidance so `python-family-batching` now explicitly encourages the `task` tool for scheduling `explore` and `general` subagents, running them in parallel when the work is independent, and using `code-reviewer` / `agentic-reflect` at bucket closeout. This makes the written workflow match the orchestration pattern we have been using in plan 77.
- Files: `.opencode/skills/python-family-batching/SKILL.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: Read back `.opencode/skills/python-family-batching/SKILL.md` after patching to verify the new `Task Tool Workflow` section and the explicit `task`/subagent guidance.
- Follow-ups: If we add more helper scripts later, consider a small example subsection that pairs each script with the recommended `task`-tool delegation pattern.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Broadened the workspace bash permission rules for the `python-family-batching` skill so script execution is allowed by path-specific wildcard patterns, including generic `*python-family-batching/scripts/*` coverage plus explicit `.py`/`.sh` helper invocations. This should make the skill usable immediately after an OpenCode restart without prompting for each script command.
- Files: `.opencode/opencode.jsonc`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: Read back `.opencode/opencode.jsonc` after patching to confirm the new bash allow rules for `*python-family-batching/scripts/*`, `python3 *python-family-batching/scripts/*.py*`, and `bash *python-family-batching/scripts/*.sh*`
- Follow-ups: Restart OpenCode to pick up the updated permission config, then re-run one of the skill script commands to confirm prompts are gone.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Cleared the `Github` bucket as a narrow exact-call family: exact unaliased direct imports of `github.Github` now classify as `exec`, while module-qualified calls, aliased imports, captured callables, and shadowed locals stay conservative. Inline permissions still surface the direct-import constructor as an `exec` ask, which matches the repo's current policy that remote client construction is operationally significant rather than pure.
- Files: `src/python/python-known-methods.ts`, `src/python/python-rules.json`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family Github --snapshot`
- Follow-ups: With `Github` drained, the next best remaining buckets are still provenance-heavy (`total_seconds`, `ts.isoformat`, `item.lower`) plus a few isolated exact-call/model families such as `obj.model_dump`. If we want another small exact-call win before tackling more provenance work, `obj.model_dump` is likely next.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Cleared the `label.strip` bucket by extending exact-string-key dict handling just far enough for `for label, obj in samples.items(): label.strip()` on literal string-key mappings, without widening generic `.items()` key trust. The follow-up hardens invalidation across mixed-key literals, splat-built dicts, direct subscript mutation, `update(...)`, `setdefault(...)`, `dict.update(...)`, and bound mutator aliases before later `.items()` destructuring is trusted.
- Files: `src/python/python-key-equivalence.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family label.strip --snapshot`
- Follow-ups: The queue is now down to `37` snippets / `71` pending candidates / `48` families in the latest live snapshot. Remaining work is still dominated by provenance-heavy string/datetime buckets plus isolated exact-call/model families like `obj.model_dump`; `label.strip` no longer blocks choosing among those next paths.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Cleared the `obj.model_dump` bucket with a dedicated tracked-instance seam instead of a broad Pydantic rule: exact unaliased direct imports of `OrganizationMembershipListOptions` now seed trusted local instances only from `.model_validate(...)`, and direct local `.model_dump(...)` on those instances classifies as pure while `model_validate(...)` itself remains conservative. The hardening pass closes direct/setattr class mutation, alias-mediated factory mutation, class-level `model_dump`, and instance-level `model_dump` rebinding without widening generic model APIs.
- Files: `src/python/python-analyze-types.ts`, `src/python/python-scope.ts`, `src/python/python-replay.ts`, `src/python/python-classifier.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family obj.model_dump --snapshot`
- Follow-ups: With `obj.model_dump` drained, the queue is `37` snippets / `70` pending candidates / `47` families in the latest live snapshot. The remaining large work is still the datetime/helper cluster (`total_seconds`, `ts.isoformat`, `a.isoformat`, `found.isoformat`) plus the older dynamic string/bytes buckets, so the next safest step is likely another tiny provenance bucket or a deliberate bounded datetime-helper design.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Cleared the `old_path.exists` / `old_path.rename` bucket by extending iterated Path provenance just far enough for explicit tuple/list Path-pair destructuring like `for old_path, new_path in renames:`. The follow-up keeps that proof bounded to flat identifier destructuring and hardens invalidation for subscript mutation plus alias-linked tuple reuse, so generic tuple iteration and non-flat destructuring stay conservative.
- Files: `src/python/python-analyze-types.ts`, `src/python/python-scope.ts`, `src/python/python-inference.ts`, `src/python/python-inference-paths.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family old_path.exists --family old_path.rename --snapshot`
- Follow-ups: With the explicit Path-pair loop drained, the queue is `37` snippets / `68` pending candidates / `45` families in the latest live snapshot. The remaining backlog is now even more dominated by the bounded-but-broader datetime/helper cluster and the long-standing dynamic string/bytes families.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Cleared the `m.group.endswith` / `m.group.replace` bucket by teaching bounded regex match receivers that single-selector `group(...)` / `__getitem__()` returns a string, which lets existing string purity classify downstream `.endswith()` and `.replace()` chains. The change keeps shadowed `re`, multi-selector `group(1, 2)`, and arbitrary `obj.group(...)` receivers conservative, so this stays a producer-return fix rather than a broad string-method widening.
- Files: `src/python/python-inference-containers.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family m.group.endswith --family m.group.replace --snapshot`
- Follow-ups: The latest live snapshot after draining this bucket is `37` snippets / `64` pending candidates / `43` families. The remaining top work is now even more concentrated in the helper-return datetime cluster (`total_seconds`, `ts.isoformat`, `a.isoformat`, `found.isoformat`) plus the older dynamic string/bytes families (`e.split`, `e.startswith`, `raw.split`, `text.splitlines`).
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-26)
- Summary: Added an iterative helper-provenance pass for bounded datetime families: direct helper calls can now reuse unanimous helper-param seeds plus homogeneous datetime-like helper returns, and tracked identifier containers now participate in helper-param arithmetic inference. The follow-up hardens the seam so optional fallthrough, mixed seeds, helper alias escapes, and shadowed raw `datetime.*` roots stay conservative; the live queue dropped to `36` snippets / `56` pending candidates / `40` families, but the remaining datetime blockers still need tuple-slot or exact-key provenance (`ts.isoformat`, `a.isoformat`, `found.isoformat`, and most `total_seconds`).
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `src/python/python-scope.ts`, `.opencode/test/python-analyze.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-analyze.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family ts.isoformat --family a.isoformat --family total_seconds --family found.isoformat --snapshot`; `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 20 --include-representatives`
- Follow-ups: Extend this helper path only if we can keep it bounded for tuple/list slot provenance (`ts.isoformat` / `a.isoformat`) or exact-key helper-param value tracking (`found.isoformat` / `total_seconds`); otherwise pivot to the next smaller blocked bucket such as `item.lower` or the pending bytes helper families.
- Commit: Not committed
- PR/Jira: None

#### Notes

- Status: In progress (2026-03-27)
- Summary: Restored the full Bun suite by fixing a stale session-report test assumption rather than changing batching behavior: the `hashlib.sha256` family-cluster test now opts into `includePure: true`, which matches the current contract that `scan()` excludes pure events unless explicitly requested. `reviewFamilies()` and the analyzer/runtime code stay unchanged.
- Files: `.opencode/test/python-session-report.test.ts`, `docs/plans/77-python-module-family-review-batching.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts -t "counts merged snippet occurrences separately from snippet count in family clusters"`; `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test`
- Follow-ups: Keep pure-family session-report expectations explicit about `includePure` in future tests. With the stale test fixed, plan 78 Phase 2 can resume against a fully green `cd .opencode && bun test` baseline.
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
