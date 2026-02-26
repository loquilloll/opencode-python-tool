# opencode-python-tool

Custom OpenCode `python` tool with static AST classification, permission-aware
execution, and defensive runtime behavior for headless/non-interactive agent
workflows.

## Overview

This repository is an implementation source for a custom OpenCode `python` tool.
It is designed for cases where Python execution is the primary action and you
want stronger permission controls than ad-hoc shell execution.

Use this project when you need:

- pre-execution static analysis of Python source,
- explicit permission asks (`python` + `external_directory`) before execution,
- guardrails for high-risk execution paths,
- repeatable tests around analyzer and runtime behavior.

## Repository File Map

Core implementation lives in `.opencode/`:

- `.opencode/tool/python.ts`: runtime entry point (arg validation, source load,
  analyzer call, permission asks, subprocess guard, process execution,
  timeout/abort handling, metadata streaming).
- `.opencode/tool/python-analyze.ts`: Tree-sitter analyzer that classifies
  Python calls into `read | write | exec | unknown` events with optional path
  extraction.
- `.opencode/tool/python.txt`: tool prompt that guides model usage (`code` vs
  `scriptPath`, non-interactive constraints, safety behavior).
- `.opencode/opencode.jsonc`: restrictive default permission policy for this
  tool.

Supporting files:

- `.opencode/test/python-analyze.test.ts`: analyzer unit coverage.
- `.opencode/test/python.test.ts`: runtime/integration coverage.
- `.opencode/test/fixtures/context.ts`: mock OpenCode `ToolContext` fixture.
- `.opencode/package.json`: local dependencies for plugin SDK and parser stack.

## Requirements

- OpenCode custom tools enabled in your target project.
- Bun available to install deps and run tests.
- Python 3 available at runtime (`python3`), or set `OPENCODE_PYTHON_BIN`.
- Node-compatible environment for OpenCode plugin runtime.

## Setup (This Repository)

Install dependencies:

```bash
cd .opencode
bun install
```

Optional quick load check:

```bash
cd .opencode
bun -e "import('./tool/python.ts').then(() => console.log('module loads ok'))"
```

## Installation Into Another Project

### Option 1: Tool-only install (minimal)

Copy only runtime/analyzer/prompt and dependency+permission config:

```bash
# from this repo root, replace <target-repo> with destination path
mkdir -p "<target-repo>/.opencode/tool"
cp ".opencode/tool/python.ts" "<target-repo>/.opencode/tool/python.ts"
cp ".opencode/tool/python-analyze.ts" "<target-repo>/.opencode/tool/python-analyze.ts"
cp ".opencode/tool/python.txt" "<target-repo>/.opencode/tool/python.txt"
cp ".opencode/env.d.ts" "<target-repo>/.opencode/env.d.ts"
```

Then in `<target-repo>/.opencode/package.json`, ensure these dependencies exist:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.2.15",
    "tree-sitter-python": "0.25.0",
    "web-tree-sitter": "0.25.10"
  }
}
```

Install deps in the destination:

```bash
cd "<target-repo>/.opencode"
bun install
```

### Option 2: Install with tests (recommended for maintainers)

In addition to Option 1, copy test files:

```bash
mkdir -p "<target-repo>/.opencode/test/fixtures"
cp ".opencode/test/python-analyze.test.ts" "<target-repo>/.opencode/test/python-analyze.test.ts"
cp ".opencode/test/python.test.ts" "<target-repo>/.opencode/test/python.test.ts"
cp ".opencode/test/fixtures/context.ts" "<target-repo>/.opencode/test/fixtures/context.ts"
```

## Recommended Permission Configuration

Add these rules under `permission.python` in your OpenCode config:

```jsonc
{
  "python": {
    "*": "ask",
    "exec:eval": "deny",
    "exec:exec": "deny",
    "exec:compile": "deny",
    "exec:__import__": "deny",
    "exec:os.system": "deny",
    "exec:os.popen": "deny",
    "exec:os.exec*": "deny",
    "exec:pickle.load": "deny",
    "exec:pickle.loads": "deny",
    "exec:marshal.load": "deny",
    "exec:marshal.loads": "deny",
    "unknown:*": "ask"
  },
  "external_directory": "ask"
}
```

Operational guidance:

- keep `python:*` as `ask` to force explicit review,
- keep dangerous dynamic/process/deserialization patterns on `deny`,
- keep `unknown:*` as `ask` to avoid auto-approving unanalyzed behavior,
- keep `external_directory` as `ask` to prevent silent cross-worktree access.

## Security Rationale (Keep Denies by Default)

The default deny statements are there to block high-risk execution paths that
are difficult to review safely in an automated flow.

- `eval`, `exec`, `compile`, and `__import__` enable dynamic code execution or
  dynamic module loading that can bypass normal intent review.
- `os.system`, `os.popen`, and `os.exec*` can spawn or replace processes,
  execute shell commands, and bypass the tool's non-terminal safety boundary.
- `pickle.load/loads` and `marshal.load/loads` can deserialize untrusted data
  into executable behavior, which is a known arbitrary code execution risk.

If these are not denied, a prompt or script can escalate from "run Python" to
"run arbitrary commands or payloads" with much weaker review guarantees.

Concrete risk examples if denies are removed:

- a seemingly harmless script can pull a payload string from disk/network and
  run it via `exec`, bypassing static call-level intent checks,
- shell-capable calls can chain from Python into broader system operations that
  should instead be reviewed through the `bash` tool boundary,
- unsafe deserialization can execute attacker-controlled object constructors at
  load time.

Least-privilege recommendations:

- start from deny + ask defaults and only relax one pattern at a time,
- scope approvals narrowly (specific calls/paths), avoid global wildcards,
- require explicit human review for new `exec:*` patterns,
- periodically re-audit policy exceptions after incident/near-miss events.

## Runtime Behavior

### Source modes

- `code`: execute inline Python via `python -c <source>`.
- `scriptPath`: read script content first (for analysis/preview), then execute
  file path directly.
- exactly one of `code` or `scriptPath` must be provided.

### Permission asks and code preview metadata

Before execution, runtime analyzes source and asks permissions with metadata:

- asks `external_directory` when `workdir`, `scriptPath`, or literal file paths
  resolve outside worktree,
- asks `python` with event-derived patterns (`read:*`, `write:*`, `exec:*`,
  `unknown:*`),
- includes bounded executable-source preview in ask metadata with truncation,
  byte counters, and line counters.

Current preview limits in runtime:

- max preview bytes: `4000`,
- max preview lines: `120`,
- truncation marker: `...<python_permission_preview_truncated>`.

### Subprocess hard-fail behavior

Direct `subprocess.*` invocation is rejected before any permission ask. Runtime
returns an error that reroutes terminal/process orchestration to the `bash`
tool.

This keeps the `python` tool focused on Python execution and avoids blending it
with shell orchestration behavior.

## Testing and Verification

Run from `.opencode/`:

```bash
# analyzer-focused tests
bun test test/python-analyze.test.ts

# runtime-focused tests
bun test test/python.test.ts

# full suite
bun test
```

Optional smoke check:

```bash
bun -e "import('./tool/python.ts').then(() => console.log('module loads ok'))"
```

## Known Limitations and Tradeoffs

- import alias resolution is intentionally bounded; some alias forms remain
  `unknown:callable:<...>` instead of normalized known calls,
- subprocess hard-fail is based on direct `subprocess.*` call identity from the
  analyzer; alias-based subprocess forms may not be normalized,
- very large sources are not fully analyzed (`unknown:large-script` fallback),
- static analysis is call-pattern based and not a full data-flow sandbox,
- metadata preview is intentionally truncated for safety/usability and does not
  include full source in ask payload for large scripts.

## Update / Upgrade Workflow (Sync Into Other Projects)

When this repo changes and you need to refresh another project:

1. Pull latest changes in this repository.
2. Re-copy core files:
   - `.opencode/tool/python.ts`
   - `.opencode/tool/python-analyze.ts`
   - `.opencode/tool/python.txt`
   - `.opencode/env.d.ts`
3. Reconcile destination `.opencode/package.json` dependency versions.
4. Run `bun install` in destination `.opencode/`.
5. (If tests are installed) run `bun test` in destination `.opencode/`.
6. Re-validate permission policy contains recommended denies + asks.

For low-drift maintenance, keep this repository as the canonical source and
avoid editing copied files independently in downstream projects.
