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

Use `src/python-session-report.ts` to scan saved OpenCode sessions, re-run the current Python analyzer on saved inline code snippets, and review unknown callable usage.

This guide assumes:

- the utility is run from this repository checkout
- your real OpenCode install is global under `~/.config/opencode`
- your real saved sessions live in the default OpenCode data directory

This utility is not an OpenCode tool. Do not install it under `~/.config/opencode/tools/`.

## What It Does

- reads saved tool parts from the OpenCode SQLite database
- re-analyzes saved inline `state.input.code`
- reports unknown callables in text or JSON
- can merge findings into `candidates.unknown` in a rules file

## What It Does Not Do

- it does not scan `scriptPath` executions
- it does not reconstruct historical analyzer versions
- it does not auto-promote candidates into live rule buckets
- it does not need to be copied into your global OpenCode `tools/` directory

## Default Paths

```bash
REPO="/home/alvins/Documents/pgit/opencode-python-tool"
OPENCODE_HOME="${OPENCODE_HOME:-$HOME/.config/opencode}"
DB="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode.db"
RULES="$OPENCODE_HOME/tools/python/python-rules.json"
```

- `DB` is the saved OpenCode session database
- `RULES` is the global rules file used by your installed Python tool

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

## What To Do After `--update-candidates`

### 1. Review the new candidates

Open `"$RULES"` and inspect `candidates.unknown`.

For each candidate, decide whether it should:

- stay as a candidate for later review
- move into a live rule bucket
- be handled by new procedural logic in `src/python/python-analyze.ts`

### 2. Promote reviewed entries manually

If a candidate is a straightforward declarative pattern, move it from `candidates.unknown` into the correct live bucket in the same JSON file.

Typical destinations:

- `calls.read`
- `calls.write`
- `calls.exec`
- `methods.read`
- `methods.write`
- `pathCalls.read`
- `pathCalls.write`

### 3. Re-run the report

After promotion, run the report again against the same rules file:

```bash
OPENCODE_PYTHON_RULES="$RULES" \
bun run ../src/python-session-report.ts --db "$DB"
```

The promoted callable should stop appearing as unknown.

### 4. Sync the real change back into the repo

The repository is still the canonical source of truth.

If you make a good rule change in the global file, copy the same change back into:

```bash
$REPO/src/python/python-rules.json
```

Then validate and commit it in the repo. Otherwise a future refresh can overwrite the global-only change.

### 5. Use TypeScript only when JSON is not enough

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

## Recommended Operator Loop

1. Run a read-only report.
2. Review unknown callables.
3. Run `--update-candidates` if you want to capture evidence in the rules file.
4. Manually promote reviewed candidates into live buckets.
5. Re-run the report to confirm they are no longer unknown.
6. Sync vetted rule changes back into `src/python/python-rules.json` in this repo.
7. Commit the repo change.
