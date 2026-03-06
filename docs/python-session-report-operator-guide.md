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

Use `src/python-session-report.ts` to scan saved OpenCode sessions, re-run the current Python analyzer on saved inline code snippets, review unknown callable usage, and promote reviewed decisions into live callable rules when they are safe to do so.

This guide assumes:

- the utility is run from this repository checkout
- your real OpenCode install is global under `~/.config/opencode`
- your real saved sessions live in the default OpenCode data directory

This utility is not an OpenCode tool. Do not install it under `~/.config/opencode/tools/`.

## What It Does

- reads saved tool parts from the OpenCode SQLite database
- re-analyzes saved inline `state.input.code`
- reports unknown callables in text or JSON
- builds a snippet-centric review queue with read/write confidence signals
- stores human decisions in a sidecar review ledger
- can promote consistently reviewed callables into `calls.read`, `calls.write`, or `calls.exec`
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
```

- `DB` is the saved OpenCode session database
- `RULES` is the global rules file used by your installed Python tool
- `LEDGER` stores human review decisions separately from the rules file

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

cd "$REPO/.opencode"
```

## Smoke Check

```bash
bun run ../src/python-session-report.ts --help
```

If that prints usage information, the utility is runnable from the repo.

## Read-Only Reporting

### Text Report

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB"
```

### JSON Report

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --json
```

### Narrower Incremental Scan

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --since 2026-03-01T00:00:00Z --samples 5
```

## Important Note About Rules

`OPENCODE_PYTHON_RULES` controls which rules file the analyzer uses while classifying callables during the scan.

`--rules` controls which JSON file gets updated when `--update-candidates` is used.

If you want the scan and the update to both use your global rules file, set both:

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --rules "$RULES" --update-candidates
```

## Update Candidates Workflow

Run this when you want to merge newly discovered unknown callables into `candidates.unknown` in the global rules file.

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --rules "$RULES" --update-candidates
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

### Show the next pending snippet

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-next
```

This prints:

- one snippet at a time
- each unresolved candidate in that snippet
- candidate fingerprints
- `read` and `write` confidence scores
- short heuristic reasons

### Decide candidates for that snippet

Use the numbered list shown by `--review-next`.

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-next --decide 1=read,2=write
```

You can also target candidates by fingerprint instead of index:

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-next --decide abc123def4567890=ignore
```

Supported decisions:

- `read`
- `write`
- `exec`
- `ignore`
- `needs-code`

### Review queue as JSON

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-json
```

Use this when you want to inspect the queue programmatically or feed it into another OpenCode workflow.

## Promote Reviewed Decisions

When a callable has been reviewed across all currently known snippet contexts and all review decisions agree on `read`, `write`, or `exec`, you can promote it into live call rules.

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --rules "$RULES" --promote-reviewed
```

Use a full scan for promotion. Do not combine `--promote-reviewed` with `--since`.

What this does:

- inspects the current unknown-call occurrences
- joins them with the review ledger
- promotes consistently reviewed callables into `calls.read`, `calls.write`, or `calls.exec`
- removes promoted callables from `candidates.unknown`

What this does not do:

- it does not promote callables with unresolved snippet contexts
- it does not promote callables with conflicting decisions across contexts
- it does not convert reviewed decisions into `methods.*` or `pathCalls.*`; those still need manual edits if that is the better rule shape

## What To Do After `--update-candidates`

### 1. Review the new candidates

Open `"$RULES"` and inspect `candidates.unknown`.

For each candidate, decide whether it should:

- stay as a candidate for later review
- move into a live rule bucket
- be handled by new procedural logic in `src/python/python-analyze.ts`

### 2. Review and classify snippet contexts

Use the review loop until the relevant snippet contexts for a callable are decided.

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-next
```

Then apply your decisions:

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-next --decide 1=read,2=write
```

### 3. Promote reviewed entries

If a callable is consistently reviewed and maps cleanly to a live call bucket, promote it with:

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --rules "$RULES" --promote-reviewed
```

If promotion is not possible because contexts are unresolved, conflicting, or better expressed as method/path rules, update the JSON or TypeScript manually.

Typical destinations:

- `calls.read`
- `calls.write`
- `calls.exec`
- `methods.read`
- `methods.write`
- `pathCalls.read`

### 4. Re-run the report

After promotion, run the report again against the same rules file:

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB"
```

The promoted callable should stop appearing as unknown.

### 5. Sync the real change back into the repo

The repository is still the canonical source of truth.

If you make a good rule change in the global file, copy the same change back into:

```bash
$REPO/src/python/python-rules.json
```

Then validate and commit it in the repo. Otherwise a future refresh can overwrite the global-only change.

### 6. Use TypeScript only when JSON is not enough

If a candidate needs richer logic than a declarative rule can express, update:

```bash
$REPO/src/python/python-analyze.ts
```

instead of trying to force the behavior into JSON.

## Validation

Run these from `"$REPO/.opencode"`:

```bash
bun run ../src/python-session-report.ts --help
OPENCODE_PYTHON_RULES="$RULES" bun run ../src/python-session-report.ts --db "$DB"
OPENCODE_PYTHON_RULES="$RULES" bun run ../src/python-session-report.ts --db "$DB" --ledger "$LEDGER" --review-next
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
- `read` and `write` confidence scores are heuristics only. They guide review; they do not make the final decision for you.
- `--promote-reviewed` only promotes consistently reviewed callables into `calls.read`, `calls.write`, or `calls.exec`. More nuanced rule shapes still need manual edits.

## Recommended Operator Loop

1. Run a read-only report.
2. Run `--update-candidates` if you want to capture evidence in the rules file.
3. Use `--review-next` to classify one snippet at a time.
4. Apply decisions with `--decide`.
5. Run `--promote-reviewed` to move consistently reviewed callables into live call buckets.
6. Re-run the report to confirm they are no longer unknown.
7. Sync vetted rule changes back into `src/python/python-rules.json` in this repo.
8. Commit the repo change.
