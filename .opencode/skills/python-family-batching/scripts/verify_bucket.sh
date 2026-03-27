#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/common.sh"

tests=()
families=()
show_snapshot=0

usage() {
  printf 'Usage: %s [--test <path>] [--family <name>] [--snapshot]\n' "$0" >&2
}

while (($#)); do
  case "$1" in
    --test)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        usage
        exit 2
      fi
      tests+=("$2")
      shift 2
      ;;
    --family)
      if (($# < 2)) || [[ "$2" == --* ]]; then
        usage
        exit 2
      fi
      families+=("$2")
      shift 2
      ;;
    --snapshot)
      show_snapshot=1
      shift
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

for test_file in "${tests[@]}"; do
  (
    cd "${OPENCODE_DIR}"
    bun test "${test_file}"
  )
done

for family in "${families[@]}"; do
  run_review --review-next --family "${family}"
done

if [[ ${show_snapshot} -eq 1 ]]; then
  args=()
  for family in "${families[@]}"; do
    args+=(--family "${family}")
  done
  run_review --review-families-json | python3 "${SCRIPT_DIR}/queue_snapshot.py" "${args[@]}"
fi
