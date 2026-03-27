---
name: python-family-batching
description: Reduce the saved-session Python analyzer review queue in this repository by clearing blocked families in safe, bounded buckets. Use when working plan 77, triaging `src/python-session-report.ts` family output, adding analyzer provenance or trust-gating fixes, validating family-specific reductions, and updating queue progress in plan/continuity notes.
---

## Rehydrate

- Read `docs/CONTINUITY.md` and `docs/plans/77-python-module-family-review-batching.md` first.
- Treat the review database as live. Use family-specific snapshots as guidance, but do not over-index on exact totals because they can move during the session.
- Use the bundled helpers under `.opencode/skills/python-family-batching/scripts/` so the review commands always run from the correct `.opencode/` working directory with the repo-local rules file.

## Snapshot Workflow

- Prefer the bundled scripts over hand-written one-offs:

- `.opencode/skills/python-family-batching/scripts/queue_snapshot.sh [--family <name>] [--limit <n>] [--include-representatives]`
  - emits a trimmed point-in-time family snapshot from the live queue
- `.opencode/skills/python-family-batching/scripts/review_snippets.sh --call <family>`
  - extracts full snippet bodies for one or more candidate calls from `--review-json`
- `.opencode/skills/python-family-batching/scripts/verify_bucket.sh --test <path> --family <name> [--snapshot]`
  - reruns focused tests, rechecks affected families, and optionally prints a trimmed snapshot

- Get one live family snapshot manually only when the scripts are not enough:

```bash
OPENCODE_PYTHON_RULES="/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" \
  bun run ../src/python-session-report.ts --review-families-json
```

- For a specific family, prefer `--review-json` filtered by candidate call or `--review-next --family "<family>"` when it returns quickly.
- Use representative snippets to decide whether the bucket is:
  - exact-call or trust-gating,
  - producer-side provenance,
  - object-identity / mutation invalidation,
  - or a larger dynamic/interprocedural design that should be deferred.

## Task Tool Workflow

- Default to using the `task` tool to schedule read-only subagents before making a non-trivial bucket change.
- For each new bucket:
  - use an `explore` subagent to locate representative snippets, file touchpoints, and the narrowest likely implementation seam
  - use a `general` subagent in parallel when you need tradeoff analysis or help choosing between competing bounded fixes
- After coding a non-trivial bucket, use a `code-reviewer` subagent for a final read-only safety pass.
- Use `agentic-reflect` at bucket closeout when the outcome changes the reusable workflow or exposes a new safety constraint.
- Keep delegation shallow: do not ask subagents to spawn more subagents, and do not parallelize dependent work.

## Bucket Order

- Prefer the smallest safe bucket first.
- Prefer producer-side or trust-gating fixes over new method-name rules.
- Clear exact-call families before dynamic text/data families.
- Leave larger dynamic-origin buckets (`e.split`, `e.startswith`, file-backed string flows, broad parsed-text flows) until small bounded options are exhausted.

## Safe Fix Patterns

- **Exact-call families**
  - Add the canonical callable to `TRUSTED_CALL_POLICIES` and `python-rules.json` only when the trust fence is exact.
  - Add shadowing, rebinding, alias, assignment, and `setattr(...)` negatives when module-member trust is involved.

- **Producer-side provenance**
  - Extend `src/python/python-inference-containers.ts`, `src/python/python-replay.ts`, or `src/python/python-scope.ts` so the receiver kind is proven before the existing pure/read rule fires.
  - Invalidate aggressively on writes, alias mutation, augmented assignment, `setattr(...)`, or widened container updates.

- **Cursor or instance tracking**
  - Tie proofs to object identity or tokens, not just names.
  - Keep alias/rebinding conservative unless identity is preserved explicitly.

- **Helper-return proofs**
  - Keep them same-scope, undecorated, single-return, and mutation-safe.
  - Do not use them to launder generic passthrough wrappers.

## Validation

- Run the smallest useful suites first, or use `.opencode/skills/python-family-batching/scripts/verify_bucket.sh` to bundle them:

```bash
bun test test/python-analyze.test.ts
bun test test/python-inline-permissions-basic.test.ts
bun test test/python-inline-permissions-inference.test.ts
```

- Recheck only the affected families after each bucket:

```bash
OPENCODE_PYTHON_RULES="/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" \
  bun run ../src/python-session-report.ts --review-next --family "<family>"
```

- Use `code-reviewer` for a final read-only safety pass on non-trivial buckets.

## Required Updates

- Append notes to `docs/plans/77-python-module-family-review-batching.md` for each cleared bucket.
- Update `docs/CONTINUITY.md` with the bucket result, the key safety constraint, and the latest snapshot note.
- Mention when live-db totals are only a point-in-time snapshot.

## Current Guardrails

- Do not widen by method name alone.
- Do not promote dynamic parsed-text or file-backed values without a bounded proof.
- Do not launder trust through aliases, captured callables, or mutated imported members.
- Do not rely on live queue totals as a stable completion metric; use family-specific verification.
