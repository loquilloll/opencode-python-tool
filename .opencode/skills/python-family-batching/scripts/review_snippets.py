#!/usr/bin/env python3
import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filter review-json down to representative snippets."
    )
    parser.add_argument(
        "--call",
        action="append",
        default=[],
        help="Candidate call or canonical source to keep. Repeatable.",
    )
    parser.add_argument(
        "--fingerprint",
        action="append",
        default=[],
        help="Snippet fingerprint to keep. Repeatable.",
    )
    return parser.parse_args()


def keep_candidate(candidate: dict, wanted_calls: set[str]) -> bool:
    if not wanted_calls:
        return True
    call = candidate.get("call")
    source = candidate.get("sourceCall")
    return call in wanted_calls or source in wanted_calls


def main() -> int:
    args = parse_args()
    wanted_calls = set(args.call)
    wanted_fingerprints = set(args.fingerprint)
    payload = json.load(sys.stdin)

    out = []
    for snippet in payload.get("snippets", []):
        fingerprint = snippet.get("snippetFingerprint")
        matched_candidates = [
            candidate
            for candidate in snippet.get("candidates", [])
            if keep_candidate(candidate, wanted_calls)
        ]
        fingerprint_match = (
            not wanted_fingerprints or fingerprint in wanted_fingerprints
        )

        if wanted_calls:
            if not matched_candidates and fingerprint not in wanted_fingerprints:
                continue
            candidates = matched_candidates or snippet.get("candidates", [])
        else:
            if not fingerprint_match:
                continue
            candidates = snippet.get("candidates", [])

        if not candidates:
            continue

        out.append(
            {
                "snippetFingerprint": fingerprint,
                "code": snippet.get("code"),
                "candidates": [
                    {
                        "call": candidate.get("call"),
                        "sourceCall": candidate.get("sourceCall"),
                        "kind": candidate.get("kind"),
                    }
                    for candidate in candidates
                ],
            }
        )

    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
