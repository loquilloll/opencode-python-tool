# Python Custom Tool — Comprehensive Phased Plan

## Objective

Build a no-fork `python` custom tool for OpenCode with bash-like permission controls,
AST-based behavior classification (read/write/exec/unknown), safe defaults, and
a comprehensive test suite. All development lives in the repository root; the `./opencode` directory is
reference-only and git-ignored.

## Constraints

- Implement only in cwd (`.opencode/`, `docs/`, root config files).
- `./opencode` is reference-only; never modify it.
- No OpenCode core modifications — this is a pure custom-tool workspace.
- Default security posture is restrictive:
  - `python:*` = `ask`
  - Dangerous exec calls = `deny`
  - `unknown:*` = `ask`
  - `external_directory` = `ask`
- Runtime: Bun (OpenCode's custom-tool loader uses Bun to compile `.ts` files).
- Tests: Bun test runner (`bun test`).

## Architecture Overview

```
src/
├── python.ts                  # main tool entrypoint (imports from src/python/)
└── python/
    ├── env.d.ts               # *.txt module declaration
    ├── python.txt             # LLM-facing tool description prompt
    └── python-analyze.ts      # tree-sitter AST analyzer: classify Python code behavior
.opencode/
├── package.json               # local deps (plugin SDK, tree-sitter)
├── bun.lock                   # lockfile
├── opencode.jsonc             # permission policy
├── tool/
│   ├── python.ts              # OpenCode entrypoint wrapper
│   └── python-analyze.ts      # analyzer wrapper
└── test/
    ├── fixtures/              # shared test helpers, mock context, temp dirs
    │   ├── context.ts         # mock ToolContext factory
    │   └── python-runtime.ts  # shared runtime test helpers/constants
    ├── python-analyze-*.test.ts # split analyzer unit tests by behavior area
    ├── python-validation.test.ts # runtime guard coverage
    ├── python-runtime-execution.test.ts # execution/workdir runtime coverage
    ├── python-external-directory.test.ts # external-directory/boundary runtime coverage
    ├── python-inline-permissions-basic.test.ts # basic inline runtime coverage
    └── python-inline-permissions-inference.test.ts # inference-heavy inline runtime coverage
```

Note: historical pre-split references below may still mention the original `.opencode/test/python.test.ts` and `.opencode/test/python-analyze.test.ts` monoliths. The current runtime and analyzer coverage lives in the split files listed above.

---

## Phase Breakdown

Each phase produces a valid, self-contained commit. Phases are ordered by dependency —
later phases build on earlier ones but each commit is independently reviewable.

---

### Phase 1 — Workspace Bootstrap

**Goal:** Establish the git repo, ignore the reference folder, create directory structure.

**Status:** DONE (already implemented, uncommitted).

**Files changed:**
- `.gitignore` — ignore `opencode/`, unignore `.opencode/` and `docs/`
- `.git/` — initialized

**Verification:**
```bash
git status --short --ignored | grep opencode/  # shows !! opencode/
git status --short | grep -v opencode/         # no reference files staged
```

**Commit:**
```
chore: initialize workspace and ignore reference repo
```

---

### Phase 2 — Tool Scaffolding and Permission Policy

**Goal:** Establish the custom-tool runtime surface, dependencies, and security policy
before any behavioral code.

**Status:** DONE (already implemented, uncommitted).

**Files changed:**
- `src/python/env.d.ts` — `*.txt` module typing
- `.opencode/package.json` — dependencies:
  - `@opencode-ai/plugin` (tool SDK)
  - `web-tree-sitter` (parser runtime)
  - `tree-sitter-python` (Python grammar WASM)
- `.opencode/bun.lock` — generated lockfile
- `.opencode/opencode.jsonc` — restrictive permission defaults

**Permission policy detail:**

| Pattern | Action | Rationale |
|---------|--------|-----------|
| `python:*` | `ask` | Default deny/ask baseline for emitted Python permission patterns; literal reads that resolve inside the worktree are auto-allowed because no `python` read pattern is emitted |
| `python:exec:eval` | `deny` | Arbitrary code execution — never auto-approve |
| `python:exec:exec` | `deny` | Same as eval |
| `python:exec:compile` | `deny` | Code object creation |
| `python:exec:__import__` | `deny` | Dynamic imports |
| `python:exec:os.system` | `deny` | Shell injection |
| `python:exec:os.popen` | `deny` | Shell injection |
| `python:exec:os.exec*` | `deny` | Process replacement |
| `python:unknown:*` | `ask` | Parse failures, unclassifiable calls — always ask |
| `external_directory` | `ask` | Access whose resolved target leaves the active worktree — always ask |

**Verification:**
```bash
cd .opencode && bun install   # lockfile resolves
ls node_modules/@opencode-ai/plugin  # SDK present
```

**Commit:**
```
chore: scaffold custom-tool workspace with deps and permission policy
```

---

### Phase 3 — AST Analyzer

**Goal:** Implement parser-driven behavior detection. This module classifies Python
source code into permission-relevant events (read/write/exec/unknown) without
executing it.

**Status:** DONE (already implemented, uncommitted). Needs hardening in later phases.

**Files changed:**
- `.opencode/tool/python-analyze.ts`

**Module API:**
```typescript
export type PythonEventKind = "read" | "write" | "exec" | "unknown"

export type PythonEvent = {
  kind: PythonEventKind
  call: string         // e.g. "open", "subprocess.run", "os.remove"
  path?: string        // resolved literal path (if determinable)
  dynamicPath?: boolean // true if path is runtime-determined
}

export async function analyze(source: string): Promise<PythonEvent[]>
```

**Classification rules (current):**

| Pattern | Kind | Call | Path |
|---------|------|------|------|
| `open(f, "r")` / `open(f)` | read | `open` | literal or dynamic |
| `open(f, "w"/"a"/"x"/"+")` | write | `open` | literal or dynamic |
| `open(f, <dynamic-mode>)` | unknown | `open-mode-dynamic` | — |
| `Path(...).read_text()` etc. | read | `Path.read_text` | from Path() arg |
| `Path(...).write_text()` etc. | write | `Path.write_text` | from Path() arg |
| `os.remove(p)`, `os.unlink(p)` | write | `os.remove` | literal or dynamic |
| `os.makedirs(p)` | write | `os.makedirs` | literal or dynamic |
| `os.rename(s, d)` | write | `os.rename` | dst arg |
| `shutil.copy(s, d)` etc. | write | `shutil.copy` | dst arg |
| `shutil.rmtree(p)` | write | `shutil.rmtree` | literal or dynamic |
| `json.load(f)` | read | `json.load` | — |
| `json.dump(d, f)` | write | `json.dump` | — |
| `yaml.safe_load(f)` | read | `yaml.safe_load` | — |
| `subprocess.run(...)` etc. | exec | `subprocess.run` | — |
| `os.system(cmd)` | exec | `os.system` | — |
| `eval(...)`, `exec(...)` | exec | `eval`/`exec` | — |
| No calls found | unknown | `no-calls-detected` | — |
| Calls found but none classified | unknown | `no-classified-call` | — |
| Parse failure | unknown | `parse-error` | — |
| Empty source | unknown | `empty-source` | — |

**Implementation details:**
- **Lazy parser init**: Single `web-tree-sitter` + `tree-sitter-python.wasm` instance,
  created on first `analyze()` call.
- **WASM resolution**: Handles `file://`, absolute, and relative URL schemes via
  `resolveWasm()`.
- **String parsing**: Handles `r""`, `u""`, `b""` prefixes; triple-quote strings;
  basic escape sequences. Rejects f-strings as dynamic.
- **Attribute chains**: Recursively resolves `a.b.c` dotted names from AST.
- **Call argument extraction**: Supports positional and keyword argument lookup by
  index or name (e.g., `open(file=..., mode=...)` or `open("f", "r")`).
- **Deduplication**: Events are deduped by `(kind, call, path, dynamicPath)` tuple.

**Verification:**
```bash
bun -e "import('./tool/python-analyze.ts').then(m => m.analyze('open(\"f\",\"r\")').then(console.log))"
# => [{ kind: "read", call: "open", path: "f" }]
```

**Commit:**
```
feat: add Python AST analyzer for permission classification
```

---

### Phase 4 — Tool Runtime with Permission Mapping

**Goal:** Implement the main tool entry point: arg validation, source loading,
permission plan generation, permission asks, process spawning, output streaming,
abort/timeout handling.

**Status:** DONE (already implemented, uncommitted). Needs hardening in later phases.

**Files changed:**
- `.opencode/tool/python.ts`
- `.opencode/tool/python.txt`

**Tool parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `code` | string | one-of | — | Inline Python source |
| `scriptPath` | string | one-of | — | Path to `.py` file |
| `args` | string[] | no | `[]` | Arguments to the Python program |
| `workdir` | string | no | project dir | Working directory |
| `timeout` | number | no | 120000ms | Execution timeout |
| `description` | string | yes | — | Human-readable purpose |

**Validation rules:**
- Exactly one of `code` or `scriptPath` must be provided (XOR).
- `timeout` must be positive if provided.
- Source must be non-empty after trimming.

**Permission flow (two-phase, mirrors bash tool):**

1. **Phase A — External directory check:**
   - If `workdir` realpath resolves outside `context.worktree` → ask `external_directory`
   - If `scriptPath` realpath resolves outside `context.worktree` → ask `external_directory`
   - If boundary resolution fails for any reason → ask `external_directory` conservatively
   - For each analyzed event with a literal path whose resolved target leaves `context.worktree` → ask `external_directory`
   - Patterns are directory globs: `<workdir>/*` for outside workdirs, otherwise `<parent-dir>/*` for file/script targets

2. **Phase B — Python operation permission:**
    - Each analyzer event produces a pattern string:
      - literal `read:/abs/path/to/file` operations are recorded in metadata but do not emit a `python` ask
      - `read:<dynamic>` (runtime path)
      - `write:/abs/path/to/file`
      - `exec:some.module_call`
      - `unknown:callable:mypkg.do_thing` (unrecognized callable fallback)
      - `unknown:parse-error`
    - `always` patterns are parent-directory globs, module wildcards, or callable-specific unknowns:
      - `read:*` (dynamic reads only)
      - `exec:some_module.*`
      - `unknown:callable:mypkg.do_thing`
      - `unknown:*` (parser/meta unknowns like `parse-error`, `empty-source`, `large-script`)
    - Asked with `permission: "python"` so config rules under `python:` apply.

**Large-script fallback:**
- If source exceeds `MAX_ANALYZE_BYTES` (100KB), skip AST analysis and emit
  `unknown:large-script` instead (safe default: asks for approval).

**Process execution:**
- Binary: `$OPENCODE_PYTHON_BIN` or `python3`.
- Inline code: `python3 -c <source> [args...]`.
- Script: `python3 <script-path> [args...]`.
- `stdio: ["ignore", "pipe", "pipe"]` — stdin closed, stdout/stderr piped.
- `detached: true` on non-Windows (for process-group killing).

**Output streaming:**
- Metadata emitted on each stdout/stderr chunk via `context.metadata()`.
- UI-facing metadata capped at 30KB (`MAX_METADATA_LENGTH`).
- Full output returned to the agent uncapped (truncation is handled by OpenCode's
  tool wrapper).

**Abort handling:**
- If `context.abort` is already signaled → kill immediately.
- Registers one-time abort listener → kill on signal.
- Kill strategy: SIGTERM to process group → wait 1s → SIGKILL to process group.
- Windows fallback: direct `proc.kill("SIGTERM")`.

**Timeout handling:**
- Timer set to `timeout + 100ms` (buffer for process exit).
- On expiry → kill process group.
- Appends `<python_metadata>` block noting timeout.

**Error handling:**
- `ENOENT` → friendly message about missing Python binary.
- Other spawn errors → re-thrown.

**Tool description prompt** (`python.txt`):
- Instructs the LLM to use `code` vs `scriptPath`, keep execution non-interactive,
  and provide a clear `description`.

**Verification:**
```bash
bun -e "import('./tool/python.ts').then(() => console.log('module loads ok'))"
```

**Commit:**
```
feat: implement python tool runtime with permission asks
```

---

### Phase 5 — Analyzer Hardening

**Goal:** Expand the analyzer's classification coverage and fix edge cases
identified from reference bash tool analysis and real-world Python patterns.

**Status:** DONE (implemented, uncommitted).

**Changes to `.opencode/tool/python-analyze.ts`:**

#### 5a. Network and HTTP library detection

Add classification for network I/O calls that should be treated as exec-like
(they reach outside the local filesystem):

| Pattern | Kind | Call |
|---------|------|------|
| `requests.get/post/put/delete/patch/head/options` | exec | `requests.<method>` |
| `urllib.request.urlopen` | exec | `urllib.request.urlopen` |
| `urllib.request.urlretrieve` | exec | `urllib.request.urlretrieve` |
| `http.client.HTTPConnection` | exec | `http.client.HTTPConnection` |
| `http.client.HTTPSConnection` | exec | `http.client.HTTPSConnection` |
| `aiohttp.ClientSession` | exec | `aiohttp.ClientSession` |
| `httpx.get/post/put/delete/patch` | exec | `httpx.<method>` |
| `httpx.Client/AsyncClient` | exec | `httpx.Client` |
| `socket.socket` | exec | `socket.socket` |
| `socket.create_connection` | exec | `socket.create_connection` |

**Implementation:** Add a `NETWORK_CALLS` set and a `NETWORK_PREFIXES` list
to the classifier. Any call matching these emits `exec` with the full dotted name.

#### 5b. Database library detection

| Pattern | Kind | Call |
|---------|------|------|
| `sqlite3.connect` | exec | `sqlite3.connect` |
| `psycopg2.connect` | exec | `psycopg2.connect` |
| `pymysql.connect` | exec | `pymysql.connect` |
| `sqlalchemy.create_engine` | exec | `sqlalchemy.create_engine` |

**Implementation:** Add to `EXEC_CALLS` or a dedicated `DB_CALLS` set.

#### 5c. Tempfile / NamedTemporaryFile detection

| Pattern | Kind | Call |
|---------|------|------|
| `tempfile.NamedTemporaryFile` | write | `tempfile.NamedTemporaryFile` |
| `tempfile.mkdtemp` | write | `tempfile.mkdtemp` |
| `tempfile.mkstemp` | write | `tempfile.mkstemp` |
| `tempfile.TemporaryDirectory` | write | `tempfile.TemporaryDirectory` |

**Implementation:** Add a `TEMPFILE_WRITE_CALLS` set.

#### 5d. Pickle / marshal (dangerous deserialization = exec)

| Pattern | Kind | Call |
|---------|------|------|
| `pickle.load` | exec | `pickle.load` |
| `pickle.loads` | exec | `pickle.loads` |
| `marshal.load` | exec | `marshal.load` |
| `marshal.loads` | exec | `marshal.loads` |

**Implementation:** Add to `EXEC_CALLS`.

#### 5e. `with` statement support

Currently the analyzer only finds top-level `call` nodes. Python's `with open(...)` is
an `as_pattern` or `with_item` wrapping a call node. Verify that `descendantsOfType("call")`
already captures these (tree-sitter should, since `call` nodes appear inside `with`
clauses). Add a test to confirm.

#### 5f. Decorator and class-level call detection

Verify that calls inside decorators (`@app.route(...)`) and class bodies are
detected. Add tests to confirm tree-sitter's `descendantsOfType("call")` recurses
into these contexts.

#### 5g. Import alias tracking (stretch — defer to later)

Not implemented in this phase. Currently, if a user writes
`import subprocess as sp; sp.run(...)`, alias resolution is still not performed.
The analyzer emits a callable-identity unknown event (`unknown:callable:sp.run`) so
the call is still permission-checkable, but it does not map to `subprocess.*` rules.
This is a known limitation documented in CONTINUITY.md.
Full alias resolution requires scope analysis and is deferred.

#### 5h. Generic callable fallback classification

Add a generic fallback for unrecognized call nodes so the analyzer does not collapse
to a single global unknown marker.

| Pattern | Kind | Call |
|---------|------|------|
| `mypkg.do_thing(...)` (unrecognized) | unknown | `callable:mypkg.do_thing` |
| `service.run_task(...)` (unrecognized) | unknown | `callable:service.run_task` |

**Implementation:**
- In analyzer: when a call name is resolved but not matched by explicit read/write/exec
  rules, emit `unknown` with `call = "callable:<resolved-name>"`.
- In runtime permission planning: use callable-specific unknown `always` patterns for
  these events (`unknown:callable:...`), while keeping parser/meta unknowns on
  `unknown:*`.

**Verification:**
```bash
cd .opencode && bun test test/python-analyze-fallbacks.test.ts
```

**Commit:**
```
feat: expand analyzer classification and add callable-fallback unknown events
```

---

### Phase 6 — Tool Runtime Hardening

**Goal:** Fix gaps between our python tool and the reference bash tool's runtime
behavior. Make the tool production-ready.

**Status:** DONE (implemented and validated).

**Changes to `.opencode/tool/python.ts`:**

#### 6a. Virtual environment detection

Automatically detect and use the project's virtual environment if one exists.
Check in order:
1. `$OPENCODE_PYTHON_BIN` (explicit override — highest priority)
2. `$VIRTUAL_ENV/bin/python3` (active venv)
3. `.venv/bin/python3` relative to `context.worktree`
4. `venv/bin/python3` relative to `context.worktree`
5. Fall back to `python3` on PATH

```typescript
async function resolvePython(worktree: string): Promise<string> {
  if (process.env.OPENCODE_PYTHON_BIN) return process.env.OPENCODE_PYTHON_BIN
  if (process.env.VIRTUAL_ENV) {
    const venvPython = path.join(process.env.VIRTUAL_ENV, "bin", "python3")
    if (await fileExists(venvPython)) return venvPython
  }
  for (const dir of [".venv", "venv"]) {
    const candidate = path.join(worktree, dir, "bin", "python3")
    if (await fileExists(candidate)) return candidate
  }
  return "python3"
}
```

#### 6b. Enhanced tool description prompt

Rewrite `python.txt` to match the bash tool's prompt quality. Include:
- Clear purpose statement and when to use this tool vs bash
- Guidance on `code` vs `scriptPath` selection
- Non-interactive execution mandate
- Output truncation behavior notice
- `args` parameter usage examples
- `workdir` usage guidance
- Permission system explanation (what the user will see)
- Security notes (what gets denied automatically)

#### 6c. Improved error messages

- When `scriptPath` file doesn't exist: catch `ENOENT` from `readFile` and throw
  a clear message with the resolved path.
- When source is only comments/whitespace: the analyzer returns `no-calls-detected`
  which is correct, but the tool should not block on this — it's safe to run.

#### 6d. Environment variable passthrough

Mirror the bash tool's plugin hook pattern. Even though we can't call
`Plugin.trigger("shell.env")` from a custom tool, we should:
- Pass through `process.env` (already done).
- Set `PYTHONDONTWRITEBYTECODE=1` to avoid `.pyc` litter.
- Set `PYTHONUNBUFFERED=1` for real-time output streaming.

#### 6e. Exit code in return value

Currently the tool returns raw output. Enhance to append exit code information
when non-zero, similar to how the bash tool does it:
```
<python_metadata>
Exit code: 1
</python_metadata>
```

This helps the LLM understand failure vs success.

**Verification:**
```bash
cd .opencode && bun test test/python.test.ts
```

**Commit:**
```
feat: harden python tool runtime with venv detection, env vars, and error handling
```

---

### Phase 7 — Test Suite: Analyzer

**Goal:** Comprehensive unit tests for the AST analyzer covering every classification
rule, edge case, and fallback.

**Status:** DONE (implemented and validated).

**Current files carrying analyzer coverage:**
- `.opencode/test/fixtures/context.ts` — mock `ToolContext` factory
- `.opencode/test/python-analyze-*.test.ts` — split analyzer tests by behavior area

**Test mock context:**
```typescript
export function createMockContext(overrides?: Partial<ToolContext>): ToolContext & {
  asks: AskInput[]
  metadatas: MetadataInput[]
} {
  const asks: AskInput[] = []
  const metadatas: MetadataInput[] = []
  return {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: "/tmp/test-project",
    worktree: "/tmp/test-project",
    abort: AbortSignal.any([]),
    async ask(input) { asks.push(input) },
    metadata(input) { metadatas.push(input) },
    ...overrides,
    asks,
    metadatas,
  }
}
```

**Test categories across the split analyzer test files:**

Current analyzer coverage is distributed across `.opencode/test/python-analyze-parity.test.ts`, `.opencode/test/python-analyze-rules-loading.test.ts`, `.opencode/test/python-analyze-paths-io.test.ts`, `.opencode/test/python-analyze-pure-core.test.ts`, `.opencode/test/python-analyze-library-pure.test.ts`, `.opencode/test/python-analyze-exec-network.test.ts`, `.opencode/test/python-analyze-integrations.test.ts`, and `.opencode/test/python-analyze-fallbacks.test.ts`.

1. **open() classification**
   - `open("f")` → read (default mode)
   - `open("f", "r")` → read
   - `open("f", "rb")` → read
   - `open("f", "w")` → write
   - `open("f", "a")` → write (append)
   - `open("f", "x")` → write (exclusive create)
   - `open("f", "r+")` → write (plus means write)
   - `open(file="f", mode="w")` → write (keyword args)
   - `open(some_var)` → read with dynamicPath
   - `open("f", mode_var)` → unknown (dynamic mode)
   - `with open("f") as fh:` → read (verify with-statement capture)

2. **Path method classification**
   - `Path("f").read_text()` → read with path "f"
   - `Path("f").read_bytes()` → read with path "f"
   - `Path("f").write_text("x")` → write with path "f"
   - `Path("f").write_bytes(b"x")` → write with path "f"
   - `Path("f").mkdir()` → write with path "f"
   - `Path("f").unlink()` → write with path "f"
   - `Path("f").touch()` → write with path "f"
   - `Path("f").rename("g")` → write with path "f"
   - `Path(some_var).read_text()` → read with dynamicPath

3. **os/shutil write classification**
   - `os.remove("f")` → write with path "f"
   - `os.unlink("f")` → write with path "f"
   - `os.makedirs("d")` → write with path "d"
   - `os.rename("a", "b")` → write with path "b" (dst)
   - `os.replace("a", "b")` → write with path "b" (dst)
   - `shutil.copy("a", "b")` → write with path "b"
   - `shutil.copytree("a", "b")` → write with path "b"
   - `shutil.move("a", "b")` → write with path "b"
   - `shutil.rmtree("d")` → write with path "d"
   - `os.remove(path=some_var)` → write with dynamicPath

4. **JSON/YAML classification**
   - `json.load(f)` → read
   - `json.dump(d, f)` → write
   - `yaml.safe_load(f)` → read
   - `yaml.dump(d, f)` → write

5. **Exec classification**
   - `subprocess.run(["ls"])` → exec
   - `subprocess.call(["ls"])` → exec
   - `subprocess.Popen(["ls"])` → exec
   - `subprocess.check_output(["ls"])` → exec
   - `os.system("ls")` → exec
   - `os.popen("ls")` → exec
   - `os.execvp("ls", ["ls"])` → exec
   - `eval("1+1")` → exec
   - `exec("print(1)")` → exec
   - `compile("x", "f", "exec")` → exec
   - `__import__("os")` → exec

6. **Network/DB classification** (from Phase 5)
   - `requests.get("url")` → exec
   - `urllib.request.urlopen("url")` → exec
   - `sqlite3.connect("db")` → exec
   - `pickle.load(f)` → exec

7. **Tempfile classification** (from Phase 5)
   - `tempfile.NamedTemporaryFile()` → write
   - `tempfile.mkdtemp()` → write

8. **Edge cases and fallbacks**
   - Empty string → unknown:empty-source
   - Whitespace only → unknown:empty-source
   - Syntax error → unknown:parse-error
   - No calls (e.g., `x = 1 + 2`) → unknown:no-calls-detected
   - Unrecognized call (e.g., `my_func()`) → unknown:callable:my_func
   - Aliased call (e.g., `import requests as rq; rq.get(...)`) → unknown:callable:rq.get
   - f-string path (`open(f"/tmp/{x}")`) → read with dynamicPath
   - Concatenated string path (`open("a" "b")`) → read with path "ab"
   - Triple-quoted string (`open("""f""")`) → read with path "f"
   - Raw string (`open(r"/tmp/f")`) → read with path "/tmp/f"
   - Multiple calls deduplication (same call twice → one event)
   - Mixed calls (`open("f","r"); os.remove("g")`) → [read, write]

9. **Decorator and nested context**
   - Call inside decorator → detected
   - Call inside class body → detected
   - Call inside nested function → detected
   - Call inside list comprehension → detected

**Verification:**
```bash
cd .opencode && bun test test/python-analyze-*.test.ts
```

**Commit:**
```
test: add comprehensive unit tests for Python AST analyzer
```

---

### Phase 8 — Test Suite: Tool Runtime

**Goal:** Integration tests for the full tool: arg validation, permission flow,
process execution, timeout, abort, output streaming.

**Status:** DONE (implemented and validated).

**Files created:**
- `.opencode/test/python.test.ts`

**Test categories:**

1. **Arg validation**
   - Neither `code` nor `scriptPath` → error
   - Both `code` and `scriptPath` → error
   - Negative timeout → error
   - Zero timeout → error
   - Empty code string → error
   - Empty script file → error

2. **Permission patterns — inline code**
   - `open("f", "r")` → no `python` ask when the resolved path stays inside the active project root
   - `subprocess.run(...)` → hard-fail before any permission ask
   - `open("f", "w"); os.remove("g")` → patterns include both write paths
   - `mypkg.do_thing()` → ask with pattern `unknown:callable:mypkg.do_thing`
   - Pure math (`1+1`) → ask with pattern `unknown:no-calls-detected`

3. **Permission patterns — script file**
   - Script whose realpath stays inside the worktree → no external_directory ask
   - Script whose realpath resolves outside the worktree → external_directory ask triggered before file load
   - Script with literal paths outside the worktree → external_directory ask for those paths

4. **External directory detection**
   - `workdir` whose realpath resolves outside the worktree → external_directory ask
   - `workdir` whose realpath stays inside the worktree → no external_directory ask
   - Code referencing `/tmp/outside.txt` → external_directory for `/tmp/*`

5. **Always patterns**
   - `open(target, "r")` → always includes `read:*`
   - `subprocess.run(...)` → no permission pattern because the runtime rejects it before asking
   - `mypkg.do_thing()` → always includes `unknown:callable:mypkg.do_thing`
   - `unknown:parse-error` → always includes `unknown:*`

6. **Process execution** (requires Python installed)
   - `print("hello")` → output contains "hello", exit code 0
   - `import sys; sys.exit(1)` → exit code 1
   - `import sys; print(sys.argv[1])` with args `["world"]` → output "world"
   - `scriptPath` pointing to a test `.py` file → correct output

7. **Timeout handling**
   - `import time; time.sleep(10)` with timeout 500ms → killed, metadata notes timeout

8. **Abort handling**
   - Pre-aborted signal → killed immediately
   - Abort during execution → killed

9. **Output streaming**
   - Verify `metadata()` called with progressive output
   - Verify output capped at `MAX_METADATA_LENGTH` in metadata

10. **ENOENT handling**
    - Invalid `OPENCODE_PYTHON_BIN` → friendly error message

11. **workdir parameter**
    - Relative workdir resolved against project dir
    - Absolute workdir used as-is

**Test helpers needed:**
- Temp directory with git init (to serve as `worktree`)
- Test `.py` script files
- Ability to set `OPENCODE_PYTHON_BIN`

**Verification:**
```bash
cd .opencode && bun test test/python.test.ts
```

**Commit:**
```
test: add integration tests for Python tool runtime
```

---

### Phase 9 — Permission Policy Hardening

**Goal:** Refine the `opencode.jsonc` permission policy based on the expanded
analyzer classifications from Phase 5 and real-world threat modeling.

**Status:** DONE (implemented and validated).

**Changes to `.opencode/opencode.jsonc`:**

Add deny rules for the newly classified dangerous patterns:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "python": {
      "*": "ask",
      // Dangerous exec patterns — deny by default
      "exec:eval": "deny",
      "exec:exec": "deny",
      "exec:compile": "deny",
      "exec:__import__": "deny",
      "exec:os.system": "deny",
      "exec:os.popen": "deny",
      "exec:os.exec*": "deny",
      // Dangerous deserialization — deny by default
      "exec:pickle.load": "deny",
      "exec:pickle.loads": "deny",
      "exec:marshal.load": "deny",
      "exec:marshal.loads": "deny",
      // Unknown behavior — always ask
      "unknown:*": "ask"
    },
    "external_directory": "ask"
  }
}
```

**Rationale for deny additions:**
- `pickle.load/loads` can execute arbitrary code during deserialization.
- `marshal.load/loads` can construct arbitrary code objects.
- These are the Python equivalent of bash's `rm -rf /` — they should never be
  auto-approved.

**Verification:**
- Review that all deny patterns correspond to analyzer event patterns.
- Confirm wildcard matching works: `exec:os.exec*` matches `exec:os.execvp`.

**Commit:**
```
feat: harden permission policy with deserialization deny rules
```

---

### Phase 10 — Documentation and Continuity

**Goal:** Finalize all documentation, ensure CONTINUITY.md reflects the full
implementation state, and prepare for handoff.

**Status:** DONE (documentation pass completed).

**Files changed:**
- `docs/python-custom-tool-plan.md` — mark all phases complete, add outcomes
- `docs/CONTINUITY.md` — full update with:
  - `[PLANS]`: final plan state
  - `[DECISIONS]`: all architectural decisions with rationale
  - `[PROGRESS]`: complete implementation timeline
  - `[DISCOVERIES]`: all findings (tree-sitter quirks, venv detection, etc.)
  - `[OUTCOMES]`: summary of what was delivered, known limitations, future work

**Known limitations to document:**
1. Generic callable fallback is intentionally coarse-grained: unrecognized calls are
   classified as `unknown:callable:<resolved-name>` and remain permission-checkable,
   but are not upgraded to canonical `read`/`write`/`exec` families automatically.
2. Import alias tracking is not implemented. Aliased calls are captured as
   callable-identity unknown events (e.g., `unknown:callable:sp.run`) but do not
   resolve to canonical module names (e.g., `subprocess.run`).
3. Dynamic attribute access (e.g., `getattr(os, "system")("cmd")`) is not detected.
4. String formatting in paths (f-strings) is marked as dynamic, not resolved.
5. Indirect calls through variables (e.g., `fn = open; fn("f")`) are not tracked.
6. `exec("import os; os.system('rm -rf /')")` — the inner code is not analyzed
   (but `exec` itself is denied by policy).
7. Network/API calls via libraries or import styles not explicitly recognized may not
   map to an `exec:*` family, but still fall back to `unknown:callable:<name>`.

**Verification:**
- Literal filesystem reads under the active worktree are auto-allowed; dynamic reads still ask.
- `opencode/` remains ignored.
- All tests pass.

**Commit:**
```
docs: finalize plan, continuity, and known-limitations documentation
```

---

### Phase 11 — OCI Module Call Coverage

**Goal:** Add first-class analyzer coverage for known `oci` Python SDK calls so
cloud operations are classified and permission-checked without relying only on
generic callable fallback.

**Status:** DONE (implemented and validated).

**Files changed:**
- `.opencode/tool/python-analyze.ts`
- `.opencode/test/python-analyze-integrations.test.ts`

**Changes to `.opencode/tool/python-analyze.ts`:**

#### 11a. OCI known-call classification

Classify common OCI SDK calls as `exec` (remote cloud/API operations):

| Pattern | Kind | Call |
|---------|------|------|
| `oci.identity.IdentityClient` | exec | `oci.identity.IdentityClient` |
| `oci.core.ComputeClient` | exec | `oci.core.ComputeClient` |
| `oci.core.VirtualNetworkClient` | exec | `oci.core.VirtualNetworkClient` |
| `oci.object_storage.ObjectStorageClient` | exec | `oci.object_storage.ObjectStorageClient` |
| `oci.database.DatabaseClient` | exec | `oci.database.DatabaseClient` |
| `oci.secrets.SecretsClient` | exec | `oci.secrets.SecretsClient` |
| `oci.key_management.KmsManagementClient` | exec | `oci.key_management.KmsManagementClient` |
| `oci.pagination.list_call_get_all_results` | exec | `oci.pagination.list_call_get_all_results` |
| `oci.pagination.list_call_get_all_results_generator` | exec | `oci.pagination.list_call_get_all_results_generator` |

**Implementation:**
- Add an `OCI_EXEC_CALLS` set for the exact known entrypoints above.
- Add `OCI_CLIENT_METHOD_PREFIXES` (for example
  `oci.object_storage.ObjectStorageClient.`) so direct chained calls such as
  `oci.object_storage.ObjectStorageClient(...).put_object(...)` classify as `exec`.

#### 11b. OCI config read classification

Treat local OCI config loading as file read behavior:

| Pattern | Kind | Call | Path |
|---------|------|------|------|
| `oci.config.from_file(...)` | read | `oci.config.from_file` | from first arg if literal |

**Implementation:**
- Add a dedicated rule that extracts the first positional/keyword config path
  (`file_location`) and emits `read` path event when resolvable, otherwise
  `read` with `dynamicPath`.

#### 11c. OCI alias limitation (deferred)

Alias resolution remains out of scope in this phase. Example:
`import oci as cloud; cloud.object_storage.ObjectStorageClient(...)` stays
callable-fallback unknown unless full alias tracking is implemented later.

**Changes to `.opencode/test/python-analyze-integrations.test.ts`:**
- Add OCI tests for:
  - known client constructors (exec)
  - `oci.config.from_file("~/.oci/config")` (read)
  - direct chained client method call classification as exec
  - alias form (`import oci as cloud`) remains callable-fallback unknown

**Verification:**
```bash
cd .opencode && bun test test/python-analyze-integrations.test.ts
```

**Commit:**
```
feat: add OCI module call classification for cloud API permissions
```

---

### Phase 12 — GHAPI Module Call Coverage

**Goal:** Add first-class analyzer coverage for known `ghapi` Python SDK call
surfaces so GitHub API activity is classified and permission-checked as remote
execution, not only through generic callable fallback.

**Status:** DONE (implemented and validated).

**Primary source:**
- `https://ghapi.fast.ai/`

**Files changed:**
- `.opencode/tool/python-analyze.ts`
- `.opencode/test/python-analyze-integrations.test.ts`

**Changes to `.opencode/tool/python-analyze.ts`:**

#### 12a. GHAPI remote-operation call classification (`exec`)

Add known `ghapi` call surfaces that perform GitHub API operations:

| Pattern | Kind | Call |
|---------|------|------|
| `ghapi.all.GhApi` | exec | `ghapi.all.GhApi` |
| `ghapi.core.GhApi` | exec | `ghapi.core.GhApi` |
| `ghapi.graphql.gh_query` | exec | `ghapi.graphql.gh_query` |
| `ghapi.page.paged` | exec | `ghapi.page.paged` |
| `ghapi.page.pages` | exec | `ghapi.page.pages` |
| `ghapi.auth.GhDeviceAuth` | exec | `ghapi.auth.GhDeviceAuth` |
| `ghapi.auth.github_auth_device` | exec | `ghapi.auth.github_auth_device` |
| `GhApi.create_gist` | exec | `GhApi.create_gist` |
| `GhApi.create_release` | exec | `GhApi.create_release` |
| `GhApi.delete_release` | exec | `GhApi.delete_release` |
| `GhApi.upload_file` | exec | `GhApi.upload_file` |
| `GhApi.enable_pages` | exec | `GhApi.enable_pages` |

**Implementation:**
- Add `GHAPI_EXEC_CALLS` for exact known entrypoints above.
- Add `GHAPI_PREFIXES` for known module prefixes (`ghapi.`) and
  `GhApi.` convenience-method prefixes.

#### 12b. GHAPI workflow helper local-write classification (`write`)

Add known file-writing helper calls from `ghapi.actions`:

| Pattern | Kind | Call |
|---------|------|------|
| `ghapi.actions.create_workflow_files` | write | `ghapi.actions.create_workflow_files` |
| `ghapi.actions.create_workflow` | write | `ghapi.actions.create_workflow` |
| `ghapi.actions.gh_create_workflow` | write | `ghapi.actions.gh_create_workflow` |

**Implementation:**
- Add `GHAPI_WRITE_CALLS` set.
- Emit `write` events without a resolved path (or dynamic path marker) for these
  helpers, because target file paths are derived internally.

#### 12c. Optional GhApi instance-variable heuristic (bounded)

To avoid an infinite hardcoded endpoint list while preserving precision:
- Track simple assignments of the form `<name> = GhApi(...)`,
  `<name> = ghapi.all.GhApi(...)`, or `<name> = ghapi.core.GhApi(...)` in the
  current module scope.
- Classify subsequent calls matching `<name>.<group>.<verb>(...)` as `exec`,
  normalizing call identity to `ghapi.<group>.<verb>` for permission patterns.

Example:
- `api = GhApi(); api.git.get_ref(...)` -> `exec:ghapi.git.get_ref`
- `client.issues.create(...)` -> `exec:ghapi.issues.create`

#### 12d. GHAPI alias limitation (deferred)

Full alias/scope resolution remains out of scope. Example:
`import ghapi.all as ga; ga.GhApi()` may remain callable-fallback unknown unless
covered by explicit direct-name matching.

**Changes to `.opencode/test/python-analyze-integrations.test.ts`:**
- Add tests for:
  - direct module calls (`ghapi.graphql.gh_query`, `ghapi.page.paged` -> `exec`)
  - convenience methods (`GhApi().create_release(...)` -> `exec`)
  - workflow helper calls (`ghapi.actions.create_workflow_files` -> `write`)
  - optional instance heuristic (`api = GhApi(); api.git.get_ref(...)` -> `exec`)
  - alias/import edge stays deferred and falls back to callable unknown where expected

**Verification:**
```bash
cd .opencode && bun test test/python-analyze-integrations.test.ts
```

**Commit:**
```
feat: add ghapi module call classification for GitHub API permissions
```

---

### Phase 13 — Atlassian Python API Module Call Coverage

**Goal:** Add first-class analyzer coverage for known `atlassian-python-api`
(`atlassian`) call surfaces so Atlassian API usage is classified and
permission-checked as remote execution instead of relying only on generic
callable fallback.

**Status:** DONE (implemented and validated).

**Primary sources:**
- `https://atlassian-python-api.readthedocs.io/`
- `https://atlassian-python-api.readthedocs.io/jira.html`
- `https://atlassian-python-api.readthedocs.io/confluence.html`
- `https://atlassian-python-api.readthedocs.io/bitbucket.html`
- `https://atlassian-python-api.readthedocs.io/service_desk.html`

**Files changed:**
- `.opencode/tool/python-analyze.ts`
- `.opencode/test/python-analyze-integrations.test.ts`

**Changes to `.opencode/tool/python-analyze.ts`:**

#### 13a. Atlassian client constructor classification (`exec`)

Add known client constructors as `exec` events:

| Pattern | Kind | Call |
|---------|------|------|
| `Jira`, `atlassian.Jira` | exec | `Jira` / `atlassian.Jira` |
| `Confluence`, `atlassian.Confluence` | exec | `Confluence` / `atlassian.Confluence` |
| `ConfluenceCloud`, `atlassian.confluence.ConfluenceCloud` | exec | `ConfluenceCloud` / `atlassian.confluence.ConfluenceCloud` |
| `ConfluenceServer`, `atlassian.confluence.ConfluenceServer` | exec | `ConfluenceServer` / `atlassian.confluence.ConfluenceServer` |
| `Bitbucket`, `atlassian.Bitbucket` | exec | `Bitbucket` / `atlassian.Bitbucket` |
| `Cloud`, `atlassian.bitbucket.Cloud` | exec | `Cloud` / `atlassian.bitbucket.Cloud` |
| `ServiceDesk`, `atlassian.ServiceDesk` | exec | `ServiceDesk` / `atlassian.ServiceDesk` |
| `Crowd`, `atlassian.Crowd` | exec | `Crowd` / `atlassian.Crowd` |
| `Xray`, `atlassian.Xray` | exec | `Xray` / `atlassian.Xray` |
| `CloudAdminOrgs`, `atlassian.CloudAdminOrgs` | exec | `CloudAdminOrgs` / `atlassian.CloudAdminOrgs` |
| `CloudAdminUsers`, `atlassian.CloudAdminUsers` | exec | `CloudAdminUsers` / `atlassian.CloudAdminUsers` |

**Implementation:**
- Add an `ATLASSIAN_EXEC_CALLS` set for the constructor/callables above.

#### 13b. Known Atlassian client method coverage (`exec`)

Add a bounded known-method surface for high-signal remote operations:

| Client | Example methods | Kind | Normalized call |
|--------|-----------------|------|-----------------|
| Jira | `jql`, `issue`, `create_issue`, `issue_create`, `issue_transition`, `issue_add_comment` | exec | `atlassian.jira.<method>` |
| Confluence* | `get_page_by_id`, `get_page_by_title`, `create_page`, `update_page`, `cql`, `attach_file` | exec | `atlassian.confluence.<method>` |
| Bitbucket / Cloud | `get_repo`, `create_repo`, `open_pull_request`, `get_pull_requests`, `get_pipelines`, `trigger_pipeline` | exec | `atlassian.bitbucket.<method>` |
| ServiceDesk | `get_service_desks`, `create_customer_request`, `get_queues`, `create_request_comment` | exec | `atlassian.servicedesk.<method>` |

**Implementation:**
- Add `ATLASSIAN_CLIENT_METHODS` as a map of client kind -> allowed method names.
- Keep the list explicit and documentation-backed; avoid broad catch-all matching.

#### 13c. Optional tracked-instance heuristic (bounded)

To reduce dependence on variable naming while avoiding full symbol resolution:
- Track assignments of the form `<name> = Jira(...)`, `<name> = Confluence(...)`,
  `<name> = Bitbucket(...)`, `<name> = ServiceDesk(...)`, plus Cloud/Server
  variants.
- For tracked names, classify `<name>.<method>(...)` as `exec` when `<method>` is
  in that client's known-method set.
- Normalize emitted call identifiers to `atlassian.<client>.<method>`.

Example:
- `jira = Jira(...); jira.jql("project = DEMO")` -> `exec:atlassian.jira.jql`
- `cf = Confluence(...); cf.create_page(...)` -> `exec:atlassian.confluence.create_page`

#### 13d. Atlassian alias/scope limitations (deferred)

Full alias and scope graph resolution remains out of scope. For example,
`import atlassian as atl; atl.Jira(...)` may still use callable-fallback unknown
unless covered by direct-name matching in this phase.

**Changes to `.opencode/test/python-analyze-integrations.test.ts`:**
- Add tests for:
  - constructor coverage (`Jira`, `Confluence`, `Bitbucket`, `ServiceDesk` -> `exec`)
  - tracked-instance method coverage with normalized call IDs
  - unknown method on tracked instance falls back to `unknown:callable:<name>`
  - alias/import edge remains deferred and falls back to callable unknown where expected

**Verification:**
```bash
cd .opencode && bun test test/python-analyze-integrations.test.ts
```

**Commit:**
```
feat: add atlassian-python-api callable classification for API permissions
```

---

### Phase 14 — Atlassian Classification Precision Hardening

**Goal:** Address review-identified precision gaps in Phase 13 so Atlassian
classification remains high-signal and avoids avoidable false positives and
false negatives in permission prompts.

**Status:** DONE (implemented and validated).

**Input:**
- `@code-reviewer` findings for Phase 13 (flow-insensitive tracking,
  broad bare-name matches, constructor-variant consistency, and regression tests).

**Files changed:**
- `.opencode/tool/python-analyze.ts`
- `.opencode/test/python-analyze-integrations.test.ts`
- relevant split runtime tests under `.opencode/test/` (only if runtime permission-plan assertions are added; today this is usually `.opencode/test/python-inline-permissions-inference.test.ts`)

**Changes to `.opencode/tool/python-analyze.ts`:**

#### 14a. Flow-aware tracked-instance classification

Replace flow-insensitive instance mapping with order-aware handling:
- Only normalize `<name>.<method>(...)` calls to `atlassian.<client>.<method>`
  after the tracked assignment is observed.
- Invalidate tracked client family when `<name>` is reassigned to a
  non-Atlassian constructor/call.
- Keep behavior bounded; no full symbol engine or cross-scope alias graph.

#### 14b. Import-aware bare constructor gating

Reduce name-collision false positives:
- Keep module-qualified `atlassian.*` constructor callables as `exec`.
- Treat bare constructors (for example `Jira`, `Cloud`) as `exec` only when
  supported Atlassian imports are observed in the module.
- Without import provenance, fall back to `unknown:callable:<name>` for bare
  constructor-like names.

#### 14c. Consistent constructor variant coverage

Harden constructor matching consistency:
- Use a single constructor-coverage map for known Atlassian client families.
- Ensure supported dotted module variants are consistently covered across
  Jira/Confluence/Bitbucket/ServiceDesk client families.
- Preserve explicit, bounded matching (no broad wildcard that upgrades unknown
  modules).

**Changes to `.opencode/test/python-analyze-integrations.test.ts`:**

Add regression guards for review findings:
- call before assignment does not normalize to `atlassian.*`
- reassignment invalidates prior tracked instance mapping
- bare-name collision case (user-defined `Jira`) does not auto-upgrade to exec
  without Atlassian import provenance
- constructor variant matrix for supported module-qualified forms

**Optional runtime tests (current split equivalents):**
- Add assertions in `.opencode/test/python-inline-permissions-inference.test.ts`
  that normalized Atlassian calls produce expected
  `python:exec:atlassian.*` permission ask patterns.

**Verification:**
```bash
cd .opencode && bun test test/python-analyze-integrations.test.ts
cd .opencode && bun test
```

**Commit:**
```
feat: harden atlassian analyzer precision and flow-sensitive classification
```

---

### Phase 15 — Permission Prompt Code Visibility

**Goal:** Ensure Python permission asks display the code that will actually be
executed so reviewers can approve with full execution context.

**Status:** DONE (implemented and validated).

**Files changed:**
- `.opencode/tool/python.ts`
- relevant split runtime tests under `.opencode/test/` (today `.opencode/test/python-inline-permissions-basic.test.ts` and `.opencode/test/python-external-directory.test.ts`)
- `.opencode/tool/python.txt` (optional wording update)

**Changes to `.opencode/tool/python.ts`:**

#### 15a. Build permission code-preview metadata

Add a bounded helper for permission payloads, for example
`buildPermissionCodePreview(source)` that returns:
- preview text shown in permission ask metadata,
- truncation flag,
- byte/line counts for transparency.

Notes:
- Preserve exact source text semantics; do not rewrite code before execution.
- For very large sources, include a deterministic truncation marker so reviewers
  know the preview is partial.

#### 15b. Include code preview in permission asks

Attach code preview metadata to `python` asks and to `external_directory` asks once source is available:
- `python` ask metadata
- `external_directory` ask metadata after source is loaded
- preflight `external_directory` approval for outside-worktree `scriptPath` may occur before source load and therefore omit preview fields

Add fields such as:
- execution mode (`inline` vs `script`)
- resolved script path (when `scriptPath` mode is used)
- preview text (for display)
- truncation + size counters

Keep existing permission pattern/always behavior unchanged.

#### 15c. Preserve runtime behavior

No changes to actual execution semantics (`python -c` vs `scriptPath`),
permission classification, timeout, or output handling.

**Changes now covered by split runtime tests:**
- Add tests in `.opencode/test/python-inline-permissions-basic.test.ts` and `.opencode/test/python-external-directory.test.ts` asserting permission asks include code preview metadata for:
  - inline `code` mode
  - `scriptPath` mode
  - large source truncation behavior
  - external-directory ask path (when triggered after source load) includes the same preview
  - preflight outside-worktree `scriptPath` approval omits preview because source is not loaded yet

**Optional docs update (`.opencode/tool/python.txt`):**
- Mention that permission prompts include code preview text before execution.

**Verification:**
```bash
cd .opencode && bun test test/python-inline-permissions-basic.test.ts
cd .opencode && bun test test/python-external-directory.test.ts
cd .opencode && bun test
```

**Commit:**
```
feat: include code preview metadata in python permission asks
```

---

### Phase 16 — Python Tool Routing + Subprocess Hard-Fail

**Goal:** Improve tool-selection guidance so models choose the custom `python`
tool over Bash heredoc patterns, and enforce a strict no-subprocess policy by
failing immediately when subprocess invocation is detected.

**Status:** DONE (implemented and validated).

**Files changed:**
- `.opencode/tool/python.txt`
- `.opencode/tool/python.ts`
- `.opencode/test/python-validation.test.ts`

**Changes to `.opencode/tool/python.txt`:**

#### 16a. Tool routing language for heredoc alternatives

Update description/instructions to explicitly state:
- This tool executes Python directly and does not use terminal shell orchestration.
- If the model is about to run Python via Bash heredoc (for example,
  `python <<'EOF'`), use this tool instead.
- Use Bash only when shell orchestration is truly required and Python execution
  is not the primary action.

Keep wording concise and operational so it strongly influences tool choice.

**Changes to `.opencode/tool/python.ts`:**

#### 16b. Immediate subprocess preflight rejection

Add a pre-execution guard after analysis and before permission asks:
- Detect direct subprocess invocation events (for example `subprocess.run`,
  `subprocess.Popen`, and other `subprocess.*` call identities surfaced by the
  analyzer).
- Throw a deterministic, user-facing error immediately when detected.
- Error guidance should instruct using the `bash` tool for terminal/process
  orchestration.

Behavior constraints:
- Rejection happens before `context.ask(...)` calls to avoid unnecessary
  permission prompts.
- Preserve all existing non-subprocess permission planning and execution logic.

#### 16c. Known limitation note (deferred)

Alias-based subprocess invocation (for example `import subprocess as sp; sp.run`)
remains dependent on existing alias-resolution limitations unless expanded in a
future phase.

**Changes now covered by `.opencode/test/python-validation.test.ts`:**
- Add runtime tests asserting immediate failure for subprocess usage in:
  - inline `code` mode
  - `scriptPath` mode
- Assert no Python permission ask occurs on subprocess rejection path.
- Assert error text includes clear reroute guidance to `bash`.

**Verification:**
```bash
cd .opencode && bun test test/python-validation.test.ts
cd .opencode && bun test
```

**Commit:**
```
feat: block subprocess execution and clarify python tool routing guidance
```

---

## Phase Summary Table

| Phase | Title | Status | Depends On | Commit Type |
|-------|-------|--------|------------|-------------|
| 1 | Workspace Bootstrap | DONE | — | `chore` |
| 2 | Tool Scaffolding + Policy | DONE | 1 | `chore` |
| 3 | AST Analyzer | DONE | 2 | `feat` |
| 4 | Tool Runtime + Permissions | DONE | 3 | `feat` |
| 5 | Analyzer Hardening | DONE | 3 | `feat` |
| 6 | Tool Runtime Hardening | DONE | 4 | `feat` |
| 7 | Test Suite: Analyzer | DONE | 5 | `test` |
| 8 | Test Suite: Tool Runtime | DONE | 6 | `test` |
| 9 | Permission Policy Hardening | DONE | 5 | `feat` |
| 10 | Documentation + Continuity | DONE | all | `docs` |
| 11 | OCI Module Call Coverage | DONE | 5 | `feat` |
| 12 | GHAPI Module Call Coverage | DONE | 5 | `feat` |
| 13 | Atlassian Python API Module Call Coverage | DONE | 5 | `feat` |
| 14 | Atlassian Classification Precision Hardening | DONE | 13 | `feat` |
| 15 | Permission Prompt Code Visibility | DONE | 4 | `feat` |
| 16 | Python Tool Routing + Subprocess Hard-Fail | DONE | 4 | `feat` |

## Commit Sequence (recommended)

```
1. chore: initialize workspace and ignore reference repo
2. chore: scaffold custom-tool workspace with deps and permission policy
3. feat: add Python AST analyzer for permission classification
4. feat: implement python tool runtime with permission asks
5. feat: expand analyzer classification and add callable-fallback unknown events
6. feat: harden python tool runtime with venv detection, env vars, and error handling
7. test: add comprehensive unit tests for Python AST analyzer
8. test: add integration tests for Python tool runtime
9. feat: harden permission policy with deserialization deny rules
10. docs: finalize plan, continuity, and known-limitations documentation
11. feat: add OCI module call classification for cloud API permissions
12. feat: add ghapi module call classification for GitHub API permissions
13. feat: add atlassian-python-api callable classification for API permissions
14. feat: harden atlassian analyzer precision and flow-sensitive classification
15. feat: include code preview metadata in python permission asks
16. feat: block subprocess execution and clarify python tool routing guidance
```

Each commit is independently reviewable and the repo is in a valid state after each one.
Tests in phases 7–8 can be run against the code from phases 3–6 without modification.
