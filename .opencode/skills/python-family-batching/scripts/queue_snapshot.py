#!/usr/bin/env python3
import argparse
import json
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Trim review-families JSON into a stable snapshot."
    )
    parser.add_argument(
        "--family",
        action="append",
        default=[],
        help="Canonical family to keep. Repeatable.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=12,
        help="Maximum families to show when not filtering.",
    )
    parser.add_argument(
        "--include-representatives",
        action="store_true",
        help="Include representative snippet previews.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    payload = json.load(sys.stdin)
    families = payload.get("families", [])

    if args.family:
        wanted = set(args.family)
        families = [
            family for family in families if family.get("canonicalSource") in wanted
        ]
    else:
        families = families[: max(args.limit, 0)]

    trimmed = []
    for family in families:
        item = {
            "canonicalSource": family.get("canonicalSource"),
            "occurrenceCount": family.get("occurrenceCount"),
            "snippetCount": family.get("snippetCount"),
            "variantCount": family.get("variantCount"),
            "recommendation": family.get("recommendation"),
            "reasons": family.get("reasons", []),
        }
        if args.include_representatives:
            item["representatives"] = family.get("representatives", [])
        trimmed.append(item)

    out = {
        "totals": payload.get("totals", {}),
        "families": trimmed,
    }
    json.dump(out, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
