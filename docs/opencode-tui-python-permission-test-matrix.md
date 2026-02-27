# Python Permission TUI Test Matrix and Parallel Execution Checklist

## Purpose

Provide an execution-grade checklist for implementing and validating Python
permission summary/fullscreen behavior with isolated configuration and
commit-safe boundaries.

## Parallel Matrix

| Lane | Repo | Work | Depends On | Commit-Safe Output |
|---|---|---|---|---|
| A1 | `opencode-python-tool` | Add `codeExpanded` + `codeExpandedAvailable` permission metadata + tests | none | metadata contract commit |
| B1 | `./opencode` | Add python permission view-model helper + unit tests + config schema key | none | helper-only commit |
| B2 | `./opencode` | Render python prompt summary + code body + external_directory sub-case in TUI | A1, B1 | renderer commit |
| C1 | `./opencode` | tmux isolated-env manual E2E runbook execution | B2 | QA evidence notes |
| D1 | `./opencode` | PR prep + final verification | C1 | PR-ready branch |

## Commit-Safe Checklist

### A1 - Tool Metadata Contract

- [ ] Add `metadata.codeExpanded` in `src/python.ts` ask payload (only when
      `codePreviewTruncated === true` AND `totalBytes <= 50_000`).
- [ ] Add `metadata.codeExpandedAvailable` boolean flag.
- [ ] When `codePreviewTruncated === false`, omit both fields.
- [ ] Keep existing preview/truncation fields unchanged.
- [ ] Add tests in `.opencode/test/python.test.ts` for `codeExpanded` presence/absence
      across inline, script, small, medium (truncated + ≤ 50 KB), and large (> 50 KB) modes.
- [ ] Run `.opencode` tests.
- [ ] Commit:

```text
feat: add bounded expanded-source metadata for python permission prompts
```

### B1 - TUI Helper + Config Schema + Tests

- [ ] Add helper for extracting python permission display data from both
      `request.metadata` and `input()` sources.
- [ ] Unit-test malformed and missing metadata handling.
- [ ] Verify fullscreen source precedence (`codeExpanded` -> `input().code` -> `codePreview`).
- [ ] Register `python` as named permission key in config schema.
- [ ] Commit:

```text
refactor(tui): add python permission view model helper and config schema key
```

### B2 - TUI Renderer

- [ ] Add `permission === "python"` branch in permission `info()`.
- [ ] Render summary lines (description/mode/scriptPath/args/workdir/stats).
- [ ] Render code body in scrollable panel using existing fullscreen prompt.
- [ ] Fullscreen source: `codeExpanded` -> `input().code` -> `codePreview`.
- [ ] Validate `ctrl+f` expand/minimize behavior.
- [ ] Add `external_directory` sub-case for Python-originated asks (detect via
      `metadata.mode` presence; show Python context alongside directory info).
- [ ] Rebase against upstream `dev` before modifying `permission.tsx`.
- [ ] Commit:

```text
feat(tui): render python permission summary and fullscreen code view
```

### C1 - tmux-cli Isolated Validation

- [ ] Run TUI with isolated config env.
- [ ] Trigger inline python permission request and verify full code in fullscreen.
- [ ] Trigger script-path python permission request and verify full code in fullscreen.
- [ ] Capture tmux output/evidence snippets.
- [ ] Commit optional QA note:

```text
test(tui): validate python permission fullscreen flow in isolated env
```

### D1 - PR Packaging

- [ ] Rebase/sync with `origin/dev`.
- [ ] Run final tests.
- [ ] Draft PR summary + acceptance checklist + captured evidence.

## Isolated tmux-cli Runbook (No Local Config)

> Run from outside tmux. Replace pane id with the value returned by `tmux-cli launch "zsh"`.

```bash
tmux-cli launch "zsh"

# Example pane id: remote-cli-session:1.0
tmux-cli send 'ISO=$(mktemp -d) && mkdir -p "$ISO"/{home,config,data,state,cache}' --pane=remote-cli-session:1.0
tmux-cli send 'export OPENCODE_TEST_HOME="$ISO/home"' --pane=remote-cli-session:1.0
tmux-cli send 'export XDG_CONFIG_HOME="$ISO/config" XDG_DATA_HOME="$ISO/data" XDG_STATE_HOME="$ISO/state" XDG_CACHE_HOME="$ISO/cache"' --pane=remote-cli-session:1.0
tmux-cli send 'unset OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_CONFIG_CONTENT' --pane=remote-cli-session:1.0
tmux-cli send 'cd /home/alvins/Documents/pgit/opencode-python-tool/opencode/packages/opencode' --pane=remote-cli-session:1.0
tmux-cli send 'bun run --conditions=browser ./src/index.ts /home/alvins/Documents/pgit/opencode-python-tool' --pane=remote-cli-session:1.0
```

After TUI interactions:

```bash
tmux-cli capture --pane=remote-cli-session:1.0
tmux-cli wait_idle --pane=remote-cli-session:1.0 --idle-time=2.0 --timeout=60
```

## Scenario Matrix

| Scenario | Input Mode | Expected Compact View | Expected Fullscreen View |
|---|---|---|---|
| S1 | inline code | description + mode + stats visible | full inline source visible |
| S2 | scriptPath | description + script path + stats visible | full script source visible |
| S3 | long script (≤ 50 KB) | truncation indicator on preview stats | `codeExpanded` full source visible in fullscreen |
| S4 | malformed metadata | graceful fallback text | no crash; usable prompt actions |
| S5 | inline with `args` | args list visible in summary | args visible alongside full source |
| S6 | non-default `workdir` | working directory visible in summary | workdir visible alongside full source |
| S7 | inline with `description` | description text visible in summary header | description visible in fullscreen header |
| S8 | very large script (> 50 KB) | truncation indicator; `codeExpandedAvailable: false` | `codePreview` shown (no `codeExpanded`); `input().code` fallback for inline |
| S9 | external_directory (Python) | Python context (mode/desc) + directory path visible | Python source + directory info in fullscreen |

## Exit Criteria

- [ ] All listed scenarios (S1-S9) pass.
- [ ] No regressions in permission prompt actions (`Allow once`, `Allow always`, `Reject`).
- [ ] `external_directory` asks from Python show Python-specific context.
- [ ] `python` permission key is registered in config schema.
- [ ] `bun test` passes for touched packages.
- [ ] Branch is rebased against upstream `dev` before PR submission.
- [ ] Branch is ready for PR.
