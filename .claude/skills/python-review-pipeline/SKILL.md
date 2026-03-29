---
name: python-review-pipeline
description: Review and classify Python analyzer session-report candidates until the queue is empty, without pausing for user input. Use when working through `src/python-session-report.ts --review-next`, when a user asks to classify a candidate or a callable family (for example `Mock`, `ast`, `pathlib`, SDK clients), or when recurring queue noise should be fixed in the analyzer instead of decided one-by-one.
---

# Python Review Pipeline

Drive the saved-session review queue to completion. Treat a named callable as a family-level classification task, not a one-off button press.

## Core Rules

- Start by reading continuity, then use the repo-local rules file through `--analyzer-rules /home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json` when running `src/python-session-report.ts`.
- Always inspect the full snippet before deciding. Resolve the canonical callable/module/family first.
- If the user asks to classify a callable family such as `Mock`, `ast`, or `Path`, classify the constructor/function and the bounded method surface that should follow from it.
- Prefer analyzer/rules fixes over repeated manual decisions when the same family is likely to recur.
- Keep classification receiver-sensitive. Never classify by method name alone.
- Do not ask the user to confirm individual candidate decisions. Drive the queue forward autonomously until there is nothing left to review.
- Do not commit unless the user asks.

## Queue Loop

1. Run:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "/home/alvins/Documents/pgit/opencode-python-tool/src/python/python-rules.json" --db "${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db" --ledger "${XDG_STATE_HOME:-$HOME/.local/state}/opencode/python-session-review.json" --score-cache "${XDG_STATE_HOME:-$HOME/.local/state}/opencode/python-session-score-cache.json" --review-next
```

2. If there is no next candidate, stop and report that the queue is empty.
3. Inspect the candidate and full code yourself, then continue immediately with the next safe decision.
4. For each unresolved candidate in the snippet, decide whether to:
   - record a direct review decision now,
   - broaden to a callable family / module / receiver-type rule,
   - or patch the analyzer so the candidate disappears from the queue.
5. Apply the decision or patch, rerun targeted tests if code changed, then rerun `--review-next`.
6. Repeat until there are no more candidates.

Never stop mid-queue just to ask what to do next. Only stop when the queue is empty, you hit a genuinely ambiguous case that cannot be resolved from code/docs/source inspection, or a requested action would be destructive beyond normal review/rule edits.

## Family Procedure

When the user names a callable, interpret that as a bounded family review.

1. Resolve what the callable actually is in the snippet:
   - module function (`ast.parse`)
   - constructor/factory (`Mock(...)`, `TFEClient(...)`)
   - tracked receiver method (`mock.assert_called_once_with()`, `path.read_text()`)
2. Classify the constructor/function itself.
3. Decide whether the return value should seed tracked provenance for later method calls.
4. Classify the bounded method surface on that tracked receiver family.
5. Keep unrelated receivers conservative:
   - `mock.assert_called_once_with(...)` on tracked `Mock` may be classified
   - `obj.assert_called_once_with(...)` on an unknown receiver must stay unknown

## Decision Heuristics

- `pure`: in-memory transforms, value construction, validation, AST/string/regex helpers, test doubles, local container mutation with no external effect.
- `read`: filesystem reads, source inspection, metadata lookup tied to external state, existence checks.
- `write`: filesystem mutation, renames, copies, directory creation, external state mutation.
- `emit`: printing, logging, warnings.
- `exec`: process execution, network client/session construction or teardown, remote API operations, capability setup/cleanup.
- `ignore`: only when the user explicitly wants review noise suppressed instead of classified.

## Analyzer Expansion Order

Use the narrowest durable fix that removes recurring review noise.

1. Declarative rules first:
   - `src/python/python-rules.json` for explicit `calls.*` or guarded rules.
2. Canonical import binding next:
   - `src/python/python-scope.ts` for direct-import resolution like `from ast import parse`.
3. Provenance/tracking next:
   - `src/python/python-inference.ts`
   - `src/python/python-provenance.ts`
   - `src/python/python-classifier.ts`
4. Tests and docs every time behavior changes:
   - `.opencode/test/python-analyze.test.ts`
   - relevant split runtime tests under `.opencode/test/` (`python-validation.test.ts`, `python-runtime-execution.test.ts`, `python-external-directory.test.ts`, `python-inline-permissions-basic.test.ts`, `python-inline-permissions-inference.test.ts`)
   - `docs/python-classification-reference.md`

## Evidence Standard

- Prefer repo behavior first.
- For third-party libraries, use official source or docs when constructor/teardown side effects are unclear.
- When a classification is uncertain, inspect the library surface before deciding.
- Record conclusions that change future work in continuity.

## Validation

When code changes, run the smallest useful test set first, then full tests if the change is shared:

```bash
bun test test/python-analyze.test.ts
bun test \
  test/python-validation.test.ts \
  test/python-runtime-execution.test.ts \
  test/python-external-directory.test.ts \
  test/python-inline-permissions-basic.test.ts \
  test/python-inline-permissions-inference.test.ts
bun test
```

## Output Style

- Explain what you classified and why.
- If you broadened to a family, say which constructor/functions and methods are now covered.
- If you patched the analyzer, point to the files changed and the tests run.
- Keep processing in the same run; do not ask for permission between candidates.
- End only when you have reached the next unresolved blocker worth surfacing or the queue is empty.
