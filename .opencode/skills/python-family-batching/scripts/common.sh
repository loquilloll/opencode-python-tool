#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd -- "${SKILL_DIR}/../../.." && pwd)"
OPENCODE_DIR="${REPO_ROOT}/.opencode"
PYTHON_RULES="${REPO_ROOT}/src/python/python-rules.json"

run_review() {
  (
    cd "${OPENCODE_DIR}"
    bun run ../src/python-session-report.ts --analyzer-rules "${PYTHON_RULES}" "$@"
  )
}

run_analyzer_probe() {
  local source="$1"
  local mode="$2"
  (
    cd "${REPO_ROOT}"
    OPENCODE_PYTHON_RULES="${PYTHON_RULES}" \
      ANALYZER_PROBE_SOURCE="${source}" \
      ANALYZER_PROBE_MODE="${mode}" \
      bun -e 'import { analyze, analyzeDetailed } from "./src/python/python-analyze"; const source = process.env.ANALYZER_PROBE_SOURCE ?? ""; const mode = process.env.ANALYZER_PROBE_MODE ?? "events"; const output = mode === "detailed" ? await analyzeDetailed(source) : await analyze(source); console.log(JSON.stringify(output, null, 2));'
  )
}
