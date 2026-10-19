#!/usr/bin/env python
"""Compare the packaged permission contract with a preserved baseline APK.

Reads Android's public AAPT output only; it never installs or changes an APK.
Usage: check-apk-permissions.py <candidate.apk> <baseline.apk> --aapt <aapt>
"""
import argparse
import json
import subprocess


def permissions(aapt: str, apk: str) -> set[str]:
    output = subprocess.run(
        [aapt, "dump", "permissions", apk],
        check=True, capture_output=True, text=True, encoding="utf-8",
    ).stdout
    return {
        line.strip() for line in output.splitlines()
        if line.startswith("uses-permission:") or line.startswith("permission:")
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate")
    parser.add_argument("baseline")
    parser.add_argument("--aapt", required=True)
    args = parser.parse_args()
    original = permissions(args.aapt, args.baseline)
    candidate = permissions(args.aapt, args.candidate)
    if not original or not candidate:
        raise RuntimeError("Missing packaged permission contract")
    added = sorted(candidate - original)
    removed = sorted(original - candidate)
    same = not added and not removed
    print(json.dumps({
        "result": "PASS" if same else "FAIL",
        "packagedPermissionsEqualBaseline": same,
        "added": added,
        "removed": removed,
        "permissions": sorted(candidate),
        "scope": "Packaged uses/declared permission lines, not runtime grants or playback",
    }))
    return 0 if same else 1


if __name__ == "__main__":
    raise SystemExit(main())
