---
title: Python HITL Candidate Review Plan
status: done
plan: 46-python-hitl-candidate-review
created: 2026-03-06
tags:
  - type/plan
  - status/done
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/session-report
  - topic/hitl-review
---

# Python HITL Candidate Review Plan

## Objective

Add a human-in-the-loop review workflow on top of `src/python-session-report.ts` so OpenCode can iterate through unknown callable candidates, show the saved Python snippet plus candidate confidence signals, persist the operator's final decision in a sidecar review ledger, and automatically apply prior decisions to later appearances of the same callable in the same snippet context.

## Scope

### In Scope

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- new review-ledger sidecar schema and default path
- new review-queue JSON export with snippet-centric grouping
- confidence scoring for `read` and `write`
- plan and operator-guide updates for the new workflow

### Out of Scope

- automatic promotion from reviewed decisions into live rules
- stock OpenCode core or TUI changes
- historical `scriptPath` reconstruction
- exact historical analyzer replay
- non-JSON storage backends such as SQLite tables

## Design Direction

### Separate discovery from review state

Keep `src/python/python-rules.json` focused on classification rules and `candidates.unknown` evidence.

Store human review decisions in a separate sidecar ledger so:

- live rules stay clean and reviewable
- operator state does not pollute the canonical rules file
- already-reviewed candidates can be merged into later review queues without reclassification work

### Snippet-centric review queue

The review workflow should present a saved Python snippet and all unresolved unknown candidates found in that snippet.

Each candidate should include:

- normalized callable name
- stable candidate fingerprint
- `readConfidence`
- `writeConfidence`
- short heuristic reasons
- current decision from the review ledger, if one exists

### Deduplicate by callable plus snippet context

The review key should be based on the callable name plus a normalized snippet fingerprint.

That allows:

- later appearances of the same callable in the same snippet context to inherit a prior decision
- the same callable in a different snippet context to remain reviewable when needed

## Commit-Safe Phases

### Phase 1 - Review ledger and unresolved queue foundations

**Goal:** Add the review-ledger schema, snippet/candidate fingerprints, confidence scoring, and a JSON queue export that merges prior decisions.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `docs/plans/46-python-hitl-candidate-review.md`

**Changes:**

- Add a default review-ledger path and validation helpers.
- Extend the scan/report pipeline with per-occurrence snippet context and stable candidate fingerprints.
- Add snippet-centric review JSON output with merged prior decisions.
- Add a basic decision-recording command path for the ledger.
- Add explainable heuristic `read` and `write` confidence scores.

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `feat: add python candidate review queue foundations`

#### Notes

- Status: Done (2026-03-06)
- Summary: Added review-ledger foundations to `src/python-session-report.ts`, including snippet/candidate fingerprints, snippet-centric review JSON export, explainable read/write confidence scoring, and a decision-recording path that reuses prior decisions for repeated snippet contexts.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/46-python-hitl-candidate-review.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`; `cd .opencode && bun -e "import('../src/python-session-report.ts').then(async (m) => { const tmp = '/tmp/python-review-ledger-' + Date.now() + '.json'; await m.recordDecision({ ledger: tmp, fingerprint: 'deadbeefcafebabe', decision: 'read', call: 'rq.get' }); const data = await Bun.file(tmp).json(); if (data.decisions?.[0]?.decision !== 'read') throw new Error('decision not saved'); console.log('ledger write ok') })"`
- Follow-ups: Phase 2 should add an operator-facing next-item review loop on top of `--review-json` and ledger decisions instead of requiring direct fingerprint recording.
- Commit: Not committed
- PR/Jira: None

### Phase 2 - Operator review loop

**Goal:** Add an operator-friendly loop that iterates pending review items one at a time and persists decisions.

**Files:**

- `src/python-session-report.ts`
- `.opencode/test/python-session-report.test.ts`
- `docs/plans/46-python-hitl-candidate-review.md`

**Changes:**

- Add an explicit review mode that surfaces the next pending snippet and its candidates.
- Persist final decisions such as `read`, `write`, `exec`, `ignore`, and `needs-code`.
- Keep queue state idempotent when previously reviewed items reappear.

**Validation:**

- `cd .opencode && bun test test/python-session-report.test.ts`

**Commit message:**

- `feat: add python hitl review loop`

#### Notes

- Status: Done (2026-03-06)
- Summary: Added a practical next-item review loop on top of the snippet-centric queue with `--review-next`, human-readable snippet/candidate rendering, and batch decision application via `--decide` so one snippet can be reviewed in a single pass.
- Files: `src/python-session-report.ts`, `.opencode/test/python-session-report.test.ts`, `docs/plans/46-python-hitl-candidate-review.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: Phase 3 should document the end-to-end review loop and add explicit promotion helpers or guidance for moving reviewed decisions into live rule buckets.
- Commit: Not committed
- PR/Jira: None

### Phase 3 - Promotion helpers and docs

**Goal:** Make it easy to turn reviewed decisions into durable live rules.

**Files:**

- `src/python-session-report.ts`
- `docs/python-session-report-operator-guide.md`
- `README.md`

**Changes:**

- Add explicit guidance or helper commands for promoting reviewed candidates into live rule buckets.
- Document the repo-to-global workflow and the review-ledger lifecycle.

**Validation:**

- `cd .opencode && bun test`
- smoke checks for report/review commands

**Commit message:**

- `docs: add python hitl review workflow`

#### Notes

- Status: Done (2026-03-06)
- Summary: Added promotion helpers and end-to-end operator documentation for the review-ledger workflow, including `--promote-reviewed` for consistent call-level promotions into `calls.read`, `calls.write`, or `calls.exec`, plus updated repo-to-global guidance in the operator guide and README.
- Files: `src/python-session-report.ts`, `docs/python-session-report-operator-guide.md`, `README.md`, `docs/plans/46-python-hitl-candidate-review.md`
- Tests: `cd .opencode && bun test test/python-session-report.test.ts`; `cd .opencode && bun test test/python-analyze.test.ts test/python-session-report.test.ts`; `cd .opencode && bun test`; `cd .opencode && bun run ../src/python-session-report.ts --help`
- Follow-ups: None
- Commit: Not committed
- PR/Jira: None

## Acceptance Criteria

- The utility can export a snippet-centric queue of unresolved unknown candidates.
- Each queued candidate includes stable dedup keys plus `read` and `write` confidence scores.
- Prior human decisions are persisted in a sidecar review ledger and applied to later appearances of the same callable in the same snippet context.
- The rules file remains focused on classifier data instead of transient review workflow state.

## Risks and Mitigations

- **Risk:** Review decisions are too broad and incorrectly suppress distinct contexts.
  - **Mitigation:** Key decisions by callable plus snippet fingerprint, not callable name alone.
- **Risk:** Confidence scores look authoritative when they are only heuristics.
  - **Mitigation:** Keep scores explainable, bounded, and accompanied by short reasons.
- **Risk:** Repeated scans over the same DB range inflate evidence counts.
  - **Mitigation:** Keep evidence aggregation separate from review decisions and clearly document incremental-run expectations.

## Phase Status

- Phase 1: DONE (2026-03-06)
- Phase 2: DONE (2026-03-06)
- Phase 3: DONE (2026-03-06)
