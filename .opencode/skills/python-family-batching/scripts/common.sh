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
    OPENCODE_PYTHON_RULES="${PYTHON_RULES}" bun run ../src/python-session-report.ts "$@"
  )
}
