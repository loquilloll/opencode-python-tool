---
title: Python Live Unknown Classification Buckets
status: done
plan: 80-python-live-unknown-classification-buckets
created: 2026-03-29
updated: 2026-03-29
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/review-workflow
  - topic/session-report
---

# Python Live Unknown Classification Buckets

## Objective

Use the live review queue to clear the next bounded `unknown` families without reopening the broader dynamic-origin work that plan 77 intentionally deferred.

## Scope

### In Scope

- `src/python/python-rules.json`
- `src/python/python-known-methods.ts`
- `src/python/python-classifier.ts`
- `src/python/python-inference-effects.ts`
- `src/python/python-inference-paths.ts`
- `src/python/python-inference-containers.ts`
- `src/python/python-replay.ts`
- focused analyzer/runtime tests under `.opencode/test/`
- `docs/python-classification-reference.md`
- this plan file

### Out of Scope

- widening by method name alone
- generic file-handle or `open(...).read()` content provenance
- broad regex pattern/match to string coercion beyond existing bounded receivers
- dynamic parsed-text or file-backed exact-value reasoning
- unrelated queue cleanup outside the bounded families below

## Snapshot Basis

- Point-in-time live snapshot at `2026-03-29T21:26Z`: `7` snippets / `33` pending candidates / `26` families.
- Treat those totals as volatile; family-specific verification is the source of truth for completion.

## Bucket Summary

- `Exact stdlib trust-gating`: `os.walk`, `fnmatch.fnmatch`, `struct.unpack`, `int.from_bytes`
- `Bounded Path provenance`: `current.read_text`, `path.read_bytes`, `candidate.exists`, `candidate.resolve`, `c.exists`, `p.exists`, `path.exists`, `path.resolve`, `c.relative_to`, `p.relative_to`, `path.relative_to`, `source.relative_to`, `target.with_suffix`
- `Bounded bytes/text provenance`: `fields.hex`, `path_bytes.decode`, `data.find`, `raw.strip`, and only local receiver-kind chains unlocked by prior phases
- `Deferred/manual`: `open.read`, `pat.startswith`, `pat.endswith`, `match.startswith`, and any residual family that needs broader dynamic-origin reasoning

## Commit-Safe Phases

### Phase 1 - Exact stdlib trust-gating

**Goal:** Clear the direct-call stdlib families with exact trust fences, direct-import coverage where safe, and explicit shadowing or rebinding negatives.

**Files:**

- `src/python/python-rules.json`
- `src/python/python-known-methods.ts`
- `src/python/python-classifier.ts`
- `src/python/python-inference-effects.ts`
- `.opencode/test/python-analyze-library-pure.test.ts`
- `.opencode/test/python-analyze-paths-io.test.ts`
- `.opencode/test/python-inline-permissions-basic.test.ts`
- `.opencode/test/python-inline-permissions-inference.test.ts`
- this plan file

**Changes:**

- add exact safe classification for `os.walk`, `fnmatch.fnmatch`, `struct.unpack`, and `int.from_bytes`
- use trusted module-qualified or exact-direct-import gates where needed
- keep module rebinding, member mutation, and shadowed direct imports conservative
- seed returned `int` provenance for `int.from_bytes(...)` only if the builtin remains exact and unshadowed

**Validation:**

- `cd .opencode && bun test test/python-analyze-library-pure.test.ts`
- `cd .opencode && bun test test/python-analyze-paths-io.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`
- `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --test test/python-analyze-library-pure.test.ts --family os.walk --family fnmatch.fnmatch --family struct.unpack --family int.from_bytes --snapshot`

**Commit message:**

- `fix: classify exact stdlib unknown buckets`

#### Notes

- Status: Done (2026-03-29)
- Summary: Added exact trust-gated handling for `os.walk`, `fnmatch.fnmatch`, `struct.unpack`, and builtin `int.from_bytes`, including direct-import coverage where safe, returned `int` provenance, and conservative rebinding or member-mutation negatives.
- Files: `src/python/python-rules.json`, `src/python/python-known-methods.ts`, `src/python/python-inference-effects.ts`, `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze-library-pure.test.ts`, `.opencode/test/python-analyze-paths-io.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/plans/80-python-live-unknown-classification-buckets.md`
- Tests: `cd .opencode && bun test test/python-analyze-library-pure.test.ts`; `cd .opencode && bun test test/python-analyze-paths-io.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --family os.walk --family fnmatch.fnmatch --family struct.unpack --family int.from_bytes --snapshot`
- Follow-ups: Preserve `setattr(...)`-based trust invalidation as a follow-up only if these exact families reappear outside the now-empty queue; assignment and alias-member mutation negatives are already covered.
- Commit: Not committed.
- PR/Jira: None.

### Phase 2 - Bounded Path provenance carry-through

**Goal:** Extend producer-side Path tracking through the smallest safe helper, list, and iterator shapes so existing Path method rules cover the live receiver families without new generic method trust.

**Files:**

- `src/python/python-inference-paths.ts`
- `src/python/python-replay.ts`
- `src/python/python-inference-containers.ts`
- `.opencode/test/python-analyze-paths-io.test.ts`
- `.opencode/test/python-inline-permissions-inference.test.ts`
- this plan file

**Changes:**

- preserve bounded Path identity through the live helper/list/stack shapes surfaced in the queue
- keep arbitrary `obj.exists()` / `obj.resolve()` style receivers conservative
- reuse existing Path read and pure method rules instead of adding family-specific fallback logic
- add mutation or rebinding negatives when newly tracked producers can be widened unsafely

**Validation:**

- `cd .opencode && bun test test/python-analyze-paths-io.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`
- `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --test test/python-analyze-paths-io.test.ts --family current.read_text --family path.read_bytes --family candidate.exists --family candidate.resolve --family c.exists --family p.exists --family path.exists --family path.resolve --family c.relative_to --family p.relative_to --family path.relative_to --family source.relative_to --family target.with_suffix --snapshot`

**Commit message:**

- `fix: extend bounded path provenance for live queue`

#### Notes

- Status: Done (2026-03-29)
- Summary: Extended bounded Path provenance through helper parameters, `list([...]).pop()` stacks, mutation-built path candidate lists, sorted path unions, and call-form `__setitem__` invalidation. That removed the bulk of the live path receiver noise and dropped the point-in-time queue from `26` to `13` families before any manual decisions.
- Files: `src/python/python-analyze.ts`, `src/python/python-analyze-types.ts`, `src/python/python-scope.ts`, `src/python/python-inference-paths.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze-paths-io.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/plans/80-python-live-unknown-classification-buckets.md`
- Tests: `cd .opencode && bun test test/python-analyze-paths-io.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `cd .opencode && bun test test/python-analyze-library-pure.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 30 --include-representatives`
- Follow-ups: Residual singleton families still in the live DB after the producer-side patch stayed intentionally conservative in the analyzer and were handled as explicit review decisions in Phase 3 instead of widening further.
- Commit: Not committed.
- PR/Jira: None.

### Phase 3 - Bounded bytes and text receiver provenance

**Goal:** Clear the remaining same-scope bytes and decoded-string receiver families that become safe once exact stdlib calls and Path producers are proven.

**Files:**

- `src/python/python-inference-containers.ts`
- `src/python/python-replay.ts`
- `.opencode/test/python-analyze-pure-core.test.ts`
- `.opencode/test/python-analyze-paths-io.test.ts`
- `.opencode/test/python-inline-permissions-inference.test.ts`
- this plan file

**Changes:**

- preserve bounded bytes provenance through the live local chains feeding `.hex()`, `.decode()`, `.find()`, and `.strip()`
- keep support producer-side and same-scope; do not widen generic file-content or parsed-text reasoning
- only pursue `entries.items` if the proof stays flat, local, and mutation-safe; otherwise defer it
- keep `open.read`, `pat.startswith`, `pat.endswith`, and `match.startswith` conservative

**Validation:**

- `cd .opencode && bun test test/python-analyze-pure-core.test.ts`
- `cd .opencode && bun test test/python-analyze-paths-io.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`
- `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --test test/python-analyze-pure-core.test.ts --family fields.hex --family path_bytes.decode --family data.find --family raw.strip --snapshot`

**Commit message:**

- `fix: extend bounded bytes and text provenance`

#### Notes

- Status: Done (2026-03-29)
- Summary: Kept the analyzer conservative for the last singleton families and closed the remaining live queue with targeted review-ledger decisions instead of broad new provenance rules. The manual closeout covered `fields.hex`, `open.read`, `candidate.exists`, `candidate.resolve`, `entries.items`, `match.startswith`, `p.exists`, `p.relative_to`, `pat.endswith`, `pat.startswith`, `path.read_bytes`, `raw.strip`, and `source.relative_to`.
- Files: `docs/plans/80-python-live-unknown-classification-buckets.md`
- Tests: `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "fields.hex" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "open.read" --decide 1=read`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "candidate.exists" --decide 1=read`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "candidate.resolve" --decide 1=read`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "entries.items" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "match.startswith" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "p.exists" --decide 1=read`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "p.relative_to" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "pat.endswith" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "pat.startswith" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "path.read_bytes" --decide 1=read`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "raw.strip" --decide 1=pure`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-next --family "source.relative_to" --decide 1=pure`
- Follow-ups: `open.read` remains intentionally conservative in the analyzer; this phase only records review decisions for the saved-session queue.
- Commit: Not committed.
- PR/Jira: None.

### Phase 4 - Docs, deferred families, and closeout

**Goal:** Record what was cleared, explicitly defer the remaining dynamic families, and close the plan against a fresh point-in-time snapshot.

**Files:**

- `docs/python-classification-reference.md`
- this plan file

**Changes:**

- update the classification reference for any new exact-call or provenance behavior landed in Phases 1-3
- record deferred families and why they remain out of scope
- close the plan with the latest family-specific verification and a point-in-time live snapshot note

**Validation:**

- `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 20 --include-representatives`

**Commit message:**

- `docs: record live unknown bucket follow-up`

#### Notes

- Status: Done (2026-03-29)
- Summary: Updated the classification reference for the new exact-call and bounded Path behavior, then closed the plan against a final point-in-time live snapshot of `0` snippets / `0` pending candidates / `0` families.
- Files: `docs/python-classification-reference.md`, `docs/plans/80-python-live-unknown-classification-buckets.md`
- Tests: `cd .opencode && bun test test/python-analyze-library-pure.test.ts`; `cd .opencode && bun test test/python-analyze-paths-io.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 30 --include-representatives`
- Follow-ups: None. Future queue work should start from a fresh plan and fresh live snapshot instead of reopening this closed bucket set.
- Commit: Not committed.
- PR/Jira: None.

## Risks and Guardrails

- keep trust exact: module-qualified or direct-import-only where documented
- prefer producer-side provenance over new method-name allowlists
- stop when a bucket needs dynamic file-content, parsed-text, or broad regex/match reasoning
- do not widen `open.read` or generic pattern/match string helpers in this plan

## Acceptance Criteria

- the exact stdlib bucket no longer appears in the live family snapshot
- the bounded Path receiver families clear through producer-side tracking rather than generic method fallback
- bounded bytes/text receiver chains clear without widening `open.read` or dynamic parsed-text flows
- deferred families are recorded explicitly instead of silently broadened
- plan notes document which queue totals are only point-in-time snapshots

## Phase Status

- Phase 1: DONE (2026-03-29)
- Phase 2: DONE (2026-03-29)
- Phase 3: DONE (2026-03-29)
- Phase 4: DONE (2026-03-29)
