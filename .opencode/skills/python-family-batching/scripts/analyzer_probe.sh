#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

usage() {
  cat <<'EOF'
Usage: analyzer_probe.sh [--code <python>] [--code-file <path>] [--detailed]

Runs the repo-local Python analyzer against an inline snippet and prints JSON.

Options:
  --code <python>       Inline Python snippet to analyze.
  --code-file <path>    Read the snippet from a file. Use - for stdin.
  --detailed           Emit analyzeDetailed() output instead of the plain events array.
  --help               Show this help text.
EOF
}

CODE=""
CODE_FILE=""
MODE="events"

while (($# > 0)); do
  case "$1" in
    --code)
      if (($# < 2)); then
        usage >&2
        exit 1
      fi
      CODE="$2"
      shift 2
      ;;
    --code-file)
      if (($# < 2)); then
        usage >&2
        exit 1
      fi
      CODE_FILE="$2"
      shift 2
      ;;
    --detailed)
      MODE="detailed"
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -n "${CODE}" && -n "${CODE_FILE}" ]]; then
  usage >&2
  exit 1
fi

if [[ -n "${CODE_FILE}" ]]; then
  if [[ "${CODE_FILE}" == "-" ]]; then
    CODE="$(cat)"
  else
    CODE="$(<"${CODE_FILE}")"
  fi
elif [[ -z "${CODE}" ]]; then
  if [[ -t 0 ]]; then
    usage >&2
    exit 1
  fi
  CODE="$(cat)"
fi

run_analyzer_probe "${CODE}" "${MODE}"
