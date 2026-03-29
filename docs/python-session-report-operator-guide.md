---
title: Python Session Report Operator Guide
status: active
created: 2026-03-06
tags:
  - type/guide
  - status/active
  - project/opencode-python-tool
  - topic/python-analyzer
  - topic/session-report
---

# Python Session Report Operator Guide

## Purpose

Use `src/python-session-report.ts` to scan saved OpenCode sessions, re-run the current Python analyzer on saved inline code snippets, review unresolved callable usage (`unknown` by default, with optional `emit` and `pure` auditing), and promote reviewed decisions into live callable rules when they are safe to do so.

This guide assumes:

- the utility is run from this repository checkout
- your real OpenCode install is global under `~/.config/opencode`
- your real saved sessions live in the default OpenCode data directory

This utility is not an OpenCode tool. Do not install it under `~/.config/opencode/tools/`.

## What It Does

- reads saved tool parts from the OpenCode SQLite database
- re-analyzes saved inline `state.input.code`
- reports unknown callables in text or JSON, excluding calls back into definitions declared in the same snippet
- builds a snippet-centric review queue (`unknown` by default, optional `emit` via `--include-emit`, optional `pure` via `--include-pure`) with taxonomy confidence signals (`read`, `write`, `emit`, `exec`, `pure`, `unknown`), again excluding inline definition call names
- stores human decisions in a sidecar review ledger with exact fingerprint history plus review identity metadata (`kind` and `sourceCall` when available)
- can promote consistently reviewed callables into `calls.read`, `calls.write`, `calls.emit`, or `calls.exec` when one outward call maps to one reviewed identity
- can merge findings into `candidates.unknown` in a rules file

## What It Does Not Do

- it does not scan `scriptPath` executions
- it does not reconstruct historical analyzer versions
- it does not auto-promote unresolved, conflicting, or non-promotable review decisions
- it does not need to be copied into your global OpenCode `tools/` directory

## Default Paths

```bash
REPO="/home/alvins/Documents/pgit/opencode-python-tool"
OPENCODE_HOME="${OPENCODE_HOME:-$HOME/.config/opencode}"
DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
RULES="$OPENCODE_HOME/tools/python/python-rules.json"
LEDGER="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/python-session-review.json"
SCORES="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/python-session-score-cache.json"
```

- `DB` is the saved OpenCode session database
- `RULES` is the global rules file used by your installed Python tool
- `LEDGER` stores human review decisions separately from the rules file
- `SCORES` caches successful `opencode run` review scores

## Prerequisites

- Bun is installed
- this repository is checked out locally
- your global OpenCode install already has `tools/python/python-rules.json`

## Run From This Repo

Always run the utility from this repository, not from the global OpenCode `tools/` directory.

```bash
REPO="/home/alvins/Documents/pgit/opencode-python-tool"
OPENCODE_HOME="${OPENCODE_HOME:-$HOME/.config/opencode}"
DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
RULES="$OPENCODE_HOME/tools/python/python-rules.json"
LEDGER="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/python-session-review.json"
SCORES="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/python-session-score-cache.json"

cd "$REPO/.opencode"
```

## Smoke Check

```bash
bun run ../src/python-session-report.ts --help
```

If that prints usage information, the utility is runnable from the repo.

## Review Score Source

When you use `--review-next`, the utility asks `opencode run` to score the pending snippet candidates across taxonomy confidences: `read`, `write`, `emit`, `exec`, `pure`, and `unknown`.

- successful score bundles are cached in `"$SCORES"`
- cached results are reused on later review passes
- if `opencode run` fails, times out, or returns invalid JSON, the utility falls back to local heuristic scores for that invocation only
- rendered candidates show `source=opencode-run`, `source=opencode-cache`, or `source=heuristic-fallback`
- if you change the scorer prompt/version or want a fresh pass, remove `"$SCORES"`

## Read-Only Reporting

### Text Report

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB"
```

### JSON Report

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --json
```

### Narrower Incremental Scan

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --since 2026-03-01T00:00:00Z --samples 5
```

## Important Note About Rules

`--analyzer-rules` controls which rules file the analyzer uses while classifying callables during the scan.

`--rules` controls which JSON file gets updated by `--update-candidates`, read by `--suggest-rules` and `--promote-reviewed`, and treated as the current baseline for `--compare-rules`.

If you want the scan and the update to both use your global rules file, pass both flags:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --rules "$RULES" --update-candidates
```

## Update Candidates Workflow

Run this when you want to merge newly discovered unknown callables into `candidates.unknown` in the global rules file.

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --rules "$RULES" --update-candidates
```

What this does:

- scans saved inline Python snippets
- groups unknown callables
- updates `candidates.unknown` in `"$RULES"`
- keeps deterministic ordering by callable name
- stores bounded example session IDs

What this does not do:

- it does not update live classifier buckets such as `calls.read`, `calls.write`, `calls.exec`, `methods.read`, `methods.write`, `pathCalls.read`, or `pathCalls.write`

## Review Loop

Recommended sequence:

1. run `--review-families` or `--review-families-json` to find the biggest family-level targets
2. decide whether the cluster looks like a `rule`, `provenance`, `manual-split`, or `blocked` case
3. only then drop into `--review-next` for selector-backed representative snippets, or use broader `--review-tui` review without selectors when you want the full queue

### Summarize pending families first

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-families
```

This prints a read-only summary of pending family clusters before you enter one-snippet-at-a-time review. It is meant for triage only and does not write decisions or promote rules.

You can pivot directly to one target with selectors:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-families --family re.Match.group
```

or:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-next --module pytest
```

Selector matching is exact. `--module` only matches trusted module roots from the family summary, and `--family` / `--module` are mutually exclusive.

Recommendation labels mean:

- `rule`: one stable family with a trusted canonical source and no alias/evidence splits
- `provenance`: the family looks real, but source or receiver evidence is part of why it is safe
- `manual-split`: aliases or evidence variants exist, so one blanket family decision would be too broad
- `blocked`: no safe family-level action is inferred yet

Module rollups only appear when the family carries a trusted canonical module root.

How to use those labels:

- `rule`: inspect a few representative snippets, then test a family-level rule draft
- `provenance`: keep receiver/source context in view while reviewing snippets and rule drafts
- `manual-split`: keep drilling into snippet variants; do not collapse the family into one rule yet
- `blocked`: treat the summary as a signal to inspect analyzer behavior or code context first

Common batchable targets already seen in this repo:

- module-backed families like `pytest.main`
- trusted stdlib helper families once canonical source is stable
- recurring library model APIs that stay on one canonical callable surface

Common provenance-heavy buckets:

- regex match or pattern methods such as `re.Match.group`
- tracked string/container methods whose safety depends on origin
- alias-heavy outward calls where several contexts share one display name

### Show the next pending snippet

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next
```

Include already-classified emit candidates only when explicitly needed:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next --include-emit
```

Include pure candidates only when explicitly needed:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next --include-pure
```

This prints:

- one snippet at a time
- each unresolved candidate in that snippet, excluding call names that resolve to definitions declared in the same snippet
- candidate fingerprints
- taxonomy confidence scores (`read`, `write`, `emit`, `exec`, `pure`, `unknown`)
- source-call context when available (for example `pathlib.Path.joinpath` under `p.joinpath`)
- short heuristic reasons

Replay rules are intentionally narrow:

- an exact fingerprint match always reuses its stored decision first
- cross-snippet reuse only happens when the later candidate resolves to the same review identity (`kind` plus `sourceCall ?? call`)
- legacy ledger rows that only stored `call` stay fingerprint-first and do not fan out across different reconstructed identities

### Decide candidates for that snippet

Use the numbered list shown by `--review-next`.

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next --decide 1=read,2=write
```

You can also target candidates by fingerprint instead of index:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next --decide abc123def4567890=ignore
```

Supported decisions:

- `read`
- `write`
- `emit`
- `exec`
- `pure`
- `ignore`
- `needs-code`

### Review queue as JSON

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-json
```

Use this when you want to inspect the queue programmatically or feed it into another OpenCode workflow. `--review-json` keeps the stored heuristic scores; `opencode run` scoring is applied by `--review-next`.

### Family summary as JSON

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-families-json
```

Use this when you want stable machine-readable family/module summaries derived from the pending queue. The JSON output mirrors the internal family cluster model and stays read-only.

## One-Key Review UI

If you want a faster operator loop, use the terminal UI instead of repeated `--review-next --decide` calls.

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-tui
```

The UI shows:

- the full syntax-highlighted code page by default
- one focused candidate at a time
- taxonomy confidence scores and score source
- a highlighted occurrence of the current candidate in the snippet
- a transient processing status line while loading/rescoring the next candidate

By default the queue focuses on unresolved callables. Add `--include-emit` if you want to audit already-classified emit callables too.

Decisions are identity-aware in the review ledger. Later appearances inherit a prior decision only when the exact fingerprint matches or the candidate resolves to the same review identity (`kind` plus `sourceCall ?? call`).

One-key controls:

- `y` accept the suggested decision (taxonomy-aware defaults: `read`, `write`, `emit`, `ignore`, or `pure`)
- `n` choose the opposite suggestion (`read` <-> `write`, `emit` -> `ignore`, `pure` -> `ignore`, `ignore` -> best `read`/`write`/`emit`/`pure`)
- `r` force `read`
- `w` force `write`
- `e` force `emit`
- `x` mark `exec`
- `i` mark `ignore`
- `c` mark `needs-code` (manual override)
- `s` skip this candidate for the current UI session
- `v` toggle between full-page and focused-window code views
- `?` show help
- `q` quit

`--review-tui` requires a real TTY. Use `--review-next` in non-interactive environments.

Skip is session-local only. If you quit and restart the TUI, skipped candidates will appear again until they are classified.

## Promote Reviewed Decisions

When a callable has a consistent reviewed decision and maps to `read`, `write`, `emit`, or `exec`, you can promote it into live call rules.

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --rules "$RULES" --promote-reviewed
```

Use a full scan for promotion. Do not combine `--promote-reviewed` with `--since`.

What this does:

- inspects the current unknown-call occurrences
- joins them with the review ledger
- promotes consistently reviewed callables into `calls.read`, `calls.write`, `calls.emit`, or `calls.exec`
- removes promoted callables from `candidates.unknown`
- keeps promoted callables out of default review runs unless you explicitly opt back into `--include-emit`

What this does not do:

- it does not promote callables that still have no reviewed decision
- it does not auto-resolve callables with conflicting prior decisions; resolve the conflict first
- it does not promote callables with conflicting decisions across contexts
- it does not promote a live call target when multiple reviewed identities collapse to the same outward `call`; split or model those cases manually
- it does not convert reviewed decisions into `methods.*` or `pathCalls.*`; those still need manual edits if that is the better rule shape

## Suggest Rules

Use this to preview copy-pasteable rule fragments from unanimous reviewed evidence without mutating the live rules file.

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --rules "$RULES" --suggest-rules
```

Current suggestions stay intentionally narrow:

- only reviewed callables are considered
- unresolved or conflicting contexts are blocked instead of suggested
- suggestions are emitted only when one callable maps to one reviewed decision, one canonical source, and one evidence signature
- when evidence proves a bounded guarded method shape today, preview output can emit `guarded.methods` fragments (currently for receiver-kind-backed cases like regex match methods)
- output is preview-only; no rules file writes happen
- do not combine preview modes with `--record-decision`; record decisions first, then rerun preview output

Family-first validation flow:

1. pick the target family or module from `--review-families`
2. inspect representative snippets with `--review-next` plus `--family` or `--module`
3. use `--suggest-rules` to see whether the reviewed family now resolves to a safe declarative fragment
4. use `--compare-rules` against a draft rules file when you want to sanity-check queue impact before promotion
5. only then use `--promote-reviewed` when the reviewed family collapses to safe single-identity outward calls

Review rendering now surfaces optional analyzer evidence when available, such as receiver kind, dependency signatures, and explicit guard-failure reasons.

## Compare Alternate Rules

Use this to A/B the current rules file against an alternate candidate rules file on the same saved-session corpus.

```bash
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --rules "$RULES" --compare-rules "$ALT_RULES"
```

This reports:

- unknown event deltas
- unique unknown-call deltas
- pending review candidate deltas
- added or removed preview suggestions

`--compare-rules` is read-only. It never updates either rules file, and it already swaps between `--rules` and `--compare-rules`, so do not add `--analyzer-rules` here.

## What To Do After `--update-candidates`

### 1. Review the new candidates

Open `"$RULES"` and inspect `candidates.unknown`.

For each candidate, decide whether it should:

- stay as a candidate for later review
- move into a live rule bucket
- be handled by new procedural logic in `src/python/python-analyze.ts`

### 2. Summarize candidate families

Before dropping into snippet review, inspect the family summary so you can separate whole-family rule candidates from provenance work:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-families
```

Use this step to decide whether the family is ready for rule drafting (`rule`), still depends on receiver/source evidence (`provenance`), must stay split (`manual-split`), or needs more modeling/code inspection first (`blocked`).

### 3. Review and classify snippet contexts

Use the review loop until each callable has a reviewed decision and any callable-level conflicts are resolved.

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-next --family re.Match.group
```

Then apply your decisions:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --review-next --family re.Match.group --decide 1=read,2=write
```

Keep snippet review scoped to the family or module you chose from the summary. The drilldown is still evidence review, not a shortcut around inspecting representative code.

### 4. Promote reviewed entries

If a callable is consistently reviewed and maps cleanly to a live call bucket, promote it with:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --rules "$RULES" --promote-reviewed
```

If promotion is not possible because contexts are unresolved, multiple review identities share one outward call, or the better fix is a method/path rule, update the JSON or TypeScript manually.

Typical destinations:

- `calls.read`
- `calls.write`
- `calls.emit`
- `calls.exec`
- `methods.read`
- `methods.write`
- `pathCalls.read`

### 5. Re-run the report

After promotion, run the report again against the same rules file:

```bash
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB"
```

The promoted callable should stop appearing in the default review queue, and it should also stop appearing as unknown.

### 6. Sync the real change back into the repo

The repository is still the canonical source of truth.

If you make a good rule change in the global file, copy the same change back into:

```bash
$REPO/src/python/python-rules.json
```

Then validate and commit it in the repo. Otherwise a future refresh can overwrite the global-only change.

### 7. Use TypeScript only when JSON is not enough

If a candidate needs richer logic than a declarative rule can express, update:

```bash
$REPO/src/python/python-analyze.ts
```

instead of trying to force the behavior into JSON.

## Validation

Run these from `"$REPO/.opencode"`:

```bash
bun run ../src/python-session-report.ts --help
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB"
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-next --include-pure
bun run ../src/python-session-report.ts --analyzer-rules "$RULES" --db "$DB" --ledger "$LEDGER" --score-cache "$SCORES" --review-tui
bun test test/python-analyze.test.ts
bun test test/python-session-report.test.ts
```

Optional global runtime smoke check:

```bash
cd "$OPENCODE_HOME"
bun -e "import('./tools/python.ts').then(() => console.log('python tool loads ok'))"
```

## Operational Cautions

- Re-running `--update-candidates` over the same DB range will add counts again. Prefer either a full-scan baseline once or incremental runs with `--since`.
- Results are based on the current analyzer and current rules file, not historical rule versions.
- Malformed saved rows are skipped and counted instead of failing the whole scan.
- `scriptPath` executions are intentionally out of scope for this workflow.
- Taxonomy confidence scores (`read`, `write`, `emit`, `exec`, `pure`, `unknown`) are heuristics only. They guide review; they do not make the final decision for you.
- `--promote-reviewed` only promotes consistently reviewed callables into `calls.read`, `calls.write`, `calls.emit`, or `calls.exec`. If one outward call string corresponds to multiple reviewed identities, promotion stays blocked until you model it more precisely.

## Recommended Operator Loop

1. Run a read-only report.
2. Run `--update-candidates` if you want to capture evidence in the rules file.
3. Run `--review-families` or `--review-families-json` to pick the best family-level target first.
4. Use `--family` or `--module` to pivot into representative snippets when you want a narrower drilldown.
5. Use `--review-next` / `--decide` for selector-backed snippet review, or `--review-tui` when you want the broader queue without selectors.
6. Apply decisions in the TUI or with `--decide`.
7. Use `--suggest-rules` or `--compare-rules` to validate the family-level draft before promotion.
8. Run `--promote-reviewed` to move consistently reviewed single-identity call targets into live call buckets.
9. Re-run the report to confirm they are no longer unknown.
10. Sync vetted rule changes back into `src/python/python-rules.json` in this repo.
11. Commit the repo change.
