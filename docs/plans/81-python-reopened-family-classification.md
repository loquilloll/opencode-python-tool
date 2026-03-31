---
title: Python Reopened Family Classification
status: done
plan: 81-python-reopened-family-classification
created: 2026-03-30
updated: 2026-03-31
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/review-workflow
  - topic/session-report
---

# Python Reopened Family Classification

## Objective

Classify the current reopened saved-session unknown families with the smallest safe mix of bounded analyzer work and explicit review-ledger decisions, without widening dynamic parsed-text, generic file-handle, or third-party instance behavior beyond proven local shapes.

## Scope

### In Scope

- `src/python/python-analyze.ts`
- `src/python/python-key-equivalence.ts`
- `src/python/python-replay.ts`
- `src/python/python-inference-containers.ts`
- `src/python/python-inference-paths.ts`
- `src/python/python-provenance.ts`
- focused analyzer/runtime tests under `.opencode/test/`
- `docs/python-classification-reference.md`
- this plan file

### Out of Scope

- widening by method name alone
- generic file-backed text, parsed-text, or file-handle content provenance
- broad third-party instance typing for OCI, openpyxl, zipfile, or repo-local wrappers
- reopening plan 80 instead of treating this as a fresh queue state

## Snapshot Basis

- Point-in-time live snapshot at `2026-03-30T20:24Z`: `18` snippets / `50` pending candidates / `34` families.
- Treat totals as volatile; family-specific verification is the source of truth for completion.

## Bucket Summary

- `Bounded local string provenance`: builtin `str(...)` chains plus any same-scope local string receivers already proven by existing producer-side evidence
- `Bounded Path carry-through`: `cand.exists`, `cand.is_file`, and related candidate-builder list flows
- `OCI policy-object string attrs`: `statement.lower`, `stmt.lower`, `stmt.lower.strip`, `p.name.lower`, and related OCI response-field string chains if a later bounded seam proves safe
- `Exact residual receiver buckets`: only small exact/repeated families that remain after the provenance passes
- `Ledger closeout`: OCI, openpyxl, zipfile, repo-local GitHub helpers, file-handle reads, and other singleton/custom-instance tails

## Commit-Safe Phases

### Phase 1 - Bounded string provenance

**Goal:** Clear the bounded local string families by extending same-scope receiver proofs instead of adding new method-name rules.

**Files:**

- `src/python/python-inference-containers.ts`
- `.opencode/test/python-analyze-pure-core.test.ts`
- `.opencode/test/python-inline-permissions-basic.test.ts`
- `docs/python-classification-reference.md`
- this plan file

**Changes:**

- prove string-backed receivers only when the source is already a bounded local producer, such as builtin `str(...)` results and already-tracked same-scope strings
- keep OCI/object-attribute families out of this phase unless a future bounded SDK-specific seam is identified
- preserve shadowing, parameter-shadowing, alias, and rebinding invalidation so `obj.lower()` / `obj.startswith()` do not widen generically

**Validation:**

- `cd .opencode && bun test test/python-analyze-pure-core.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`
- `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "str.startswith"`
- `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "statement.lower"`

**Commit message:**

- `fix: extend bounded string provenance for review families`

#### Notes

- Status: Done (2026-03-30)
- Summary: Landed the bounded exact-builtin `str(...)` receiver slice so chained and assigned string methods now classify when `str` is unshadowed, which cleared the reopened `str.startswith` family. Re-scoped the remaining originally listed Phase 1 families (`statement.lower`, `stmt.lower`, `stmt.lower.strip`, `p.name.lower`) out of this phase because the live representatives are OCI response-object attribute chains rather than same-scope local string producers.
- Files: `src/python/python-inference-containers.ts`, `.opencode/test/python-analyze-pure-core.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/81-python-reopened-family-classification.md`
- Tests: `cd .opencode && bun test test/python-analyze-pure-core.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "str.startswith"`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "statement.lower"`
- Follow-ups: Treat OCI policy-object string attrs as a later optional bounded SDK seam only if a narrow response-field model emerges; otherwise close `statement.lower`, `stmt.lower`, `stmt.lower.strip`, and `p.name.lower` in Phase 4's review-ledger tail. Do not widen generic attribute-string provenance just to clear them.
- Commit: Not committed.
- PR/Jira: None.

### Phase 2 - Bounded Path carry-through

**Goal:** Extend producer-side Path tracking for repeated path candidate families without broadening arbitrary receiver methods.

**Files:**

- `src/python/python-inference-paths.ts`
- `src/python/python-replay.ts`
- `src/python/python-provenance.ts`
- `.opencode/test/python-analyze-paths-io.test.ts`
- `.opencode/test/python-inline-permissions-inference.test.ts`
- this plan file

**Changes:**

- carry Path identity through the smallest safe candidate-builder and loop shapes feeding `cand.exists` / `cand.is_file`
- keep `obj.exists()` / `obj.is_file()` conservative when the receiver is not already provable as Path-backed

**Validation:**

- `cd .opencode && bun test test/python-analyze-paths-io.test.ts`
- `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`
- `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --test test/python-analyze-paths-io.test.ts --family cand.exists --family cand.is_file --snapshot`

**Commit message:**

- `fix: extend bounded path provenance for review families`

#### Notes

- Status: Done (2026-03-30)
- Summary: Extended bounded Path carry-through so conditional Path-candidate lists and empty-list `append(...)` / `+= [...]` builders now keep `cand.exists` and `cand.is_file` Path-backed without widening arbitrary receivers. The focused family check now shows no pending `cand.exists` / `cand.is_file` review items.
- Files: `src/python/python-inference-paths.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze-paths-io.test.ts`, `.opencode/test/python-inline-permissions-inference.test.ts`, `docs/python-classification-reference.md`, `docs/plans/81-python-reopened-family-classification.md`
- Tests: `cd .opencode && bun test test/python-analyze-paths-io.test.ts`; `cd .opencode && bun test test/python-inline-permissions-inference.test.ts`; `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --test test/python-analyze-paths-io.test.ts --family cand.exists --family cand.is_file --snapshot`
- Follow-ups: Phase 3 remains optional. If no narrow OCI seam emerges, the remaining OCI string families should go straight to Phase 4 ledger closeout instead of broadening Path or attribute provenance.
- Commit: Not committed.
- PR/Jira: None.

### Phase 3 - Optional OCI-specific bounded residuals

**Goal:** Only if a narrow SDK-specific seam proves safe after Phase 2, classify the repeated OCI response-object string families without introducing generic third-party attribute trust.

**Files:**

- likely `src/python/python-rules.json`
- likely `src/python/python-classifier.ts`
- likely `src/python/python-replay.ts`
- likely focused tests under `.opencode/test/`
- this plan file

**Changes:**

- classify OCI response-field families such as `statement.lower`, `stmt.lower`, `stmt.lower.strip`, and `p.name.lower` only if they can be tied to one narrow response-model seam (for example a bounded `list_policies` item model)
- stop instead of widening if the family still depends on broad custom-instance typing, generic `.name` / `.statements` attribute trust, or method-name-only trust

**Validation:**

- focused suite(s) for the exact family under change
- `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 20 --include-representatives`

**Commit message:**

- `fix: classify bounded oci residual string families`

#### Notes

- Status: Done (2026-03-31)
- Summary: Landed a bounded OCI `list_policies(...).data` seam that clears `statement.lower`, `stmt.lower`, and `stmt.lower.strip` when the producer is a trusted `oci.identity.IdentityClient` policy listing. Intentionally stopped short of `p.name.lower` because the remaining `sorted(..., key=lambda p: p.name.lower())` family would need broader lambda/object-field propagation than this phase allows.
- Files: `src/python/python-analyze-types.ts`, `src/python/python-analyze.ts`, `src/python/python-scope.ts`, `src/python/python-replay.ts`, `.opencode/test/python-analyze-pure-core.test.ts`, `.opencode/test/python-inline-permissions-basic.test.ts`, `docs/python-classification-reference.md`, `docs/plans/81-python-reopened-family-classification.md`
- Tests: `cd .opencode && bun test test/python-analyze-pure-core.test.ts`; `cd .opencode && bun test test/python-inline-permissions-basic.test.ts`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "statement.lower"`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "stmt.lower"`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "stmt.lower.strip"`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json --family "p.name.lower"`
- Follow-ups: `p.name.lower` remains for Phase 4 unless a later lambda/key-callback seam can be proven without generic third-party attribute trust. Do not broaden this phase beyond the exact trusted policy-loop shape.
- Commit: Not committed.
- PR/Jira: None.

### Phase 4 - Review-ledger closeout

**Goal:** Drain the remaining singleton and third-party/custom-instance families through representative review decisions rather than broad analyzer changes.

**Files:**

- this plan file

**Changes:**

- use `--review-next --family "<family>"` for representative snippets and apply explicit ledger decisions
- keep OCI, openpyxl, zipfile, repo-local wrapper APIs, and other singleton tails out of analyzer scope unless they later recur with one stable exact shape
- if Phase 3 does not land a bounded OCI seam, close `statement.lower`, `stmt.lower`, `stmt.lower.strip`, and `p.name.lower` here as ledger-only OCI policy-object families

**Validation:**

- `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json`
- `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 20 --include-representatives`

**Commit message:**

- `docs: record reopened family ledger closeout`

#### Notes

- Status: Done (2026-03-31)
- Summary: Closed the remaining singleton and custom-instance queue tail in the review ledger instead of widening the analyzer. The ledger closeout covered OCI fetch tails (`identity.get_tenancy`, `network.get_vcn`, `network.get_vcn.data.*.lower`, `p.name.lower`), openpyxl/zipfile/file-helper families, and repo-local GitHub wrapper families.
- Files: `docs/plans/81-python-reopened-family-classification.md`
- Tests: `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json`; `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 40 --include-representatives`; family spot-checks for `statement.lower`, `stmt.lower`, `stmt.lower.strip`, and `p.name.lower` via `--review-families-json --family ...`
- Follow-ups: Phase 5 can now close the plan and record the zero-queue snapshot as a point-in-time result. If any of the ledger-only tails recur with stable exact shapes later, consider a fresh plan rather than reopening this one.
- Commit: Not committed.
- PR/Jira: None.

### Phase 5 - Docs and closeout

**Goal:** Record analyzer-fixed vs ledger-closed families and close the plan against a fresh live snapshot.

**Files:**

- `docs/python-classification-reference.md`
- this plan file

**Changes:**

- update classifier reference docs for any analyzer behavior added in Phases 1-3
- document which families stayed ledger-only
- close the plan with the latest point-in-time live snapshot

**Validation:**

- `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 20 --include-representatives`

**Commit message:**

- `docs: close reopened family classification plan`

#### Notes

- Status: Done (2026-03-31)
- Summary: Closed the plan against a fresh zero-queue snapshot and recorded which families were analyzer-fixed vs ledger-closed. Analyzer-fixed families were `str.startswith`, `cand.exists`, `cand.is_file`, `statement.lower`, `stmt.lower`, and `stmt.lower.strip`; ledger-only closeout covered `p.name.lower`, OCI fetch tails, openpyxl/zipfile/file-helper families, and repo-local GitHub wrapper families.
- Files: `docs/plans/81-python-reopened-family-classification.md`
- Tests: `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh --limit 20 --include-representatives`; `bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --review-families-json`
- Follow-ups: None. If any of the ledger-only families recur with one stable exact shape later, start a fresh plan instead of reopening this one.
- Commit: Not committed.
- PR/Jira: None.

## Risks and Guardrails

- prefer producer-side provenance over new method-name rules
- stop when proof depends on file-backed text, parsed text, or broad third-party instance modeling
- keep exact trust fences exact: direct/module-qualified where documented, mutation-safe where required
- classify tails in the review ledger rather than overfitting analyzer rules to one-off snippets

## Acceptance Criteria

- repeated string families clear through bounded local provenance rather than generic method trust
- repeated Path candidate families clear through bounded producer-side tracking rather than arbitrary receiver widening
- residual repeated exact families are either narrowly classified or explicitly deferred
- singleton/custom-instance tails are closed in the review ledger instead of silently broadened
- plan notes document that queue totals are point-in-time snapshots only

## Phase Status

- Phase 1: DONE (2026-03-30)
- Phase 2: DONE (2026-03-30)
- Phase 3: DONE (2026-03-31)
- Phase 4: DONE (2026-03-31)
- Phase 5: DONE (2026-03-31)
