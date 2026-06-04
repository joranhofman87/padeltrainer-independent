#!/usr/bin/env python3
"""Run ficwb data integrity audit checks and print JSON summary."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SQL_FILE = Path(__file__).with_name("ficwb_data_integrity_audit.sql")


def run_sql(sql: str) -> list[dict]:
    proc = subprocess.run(
        ["npx", "--yes", "supabase@2.104.0", "db", "query", "--linked", "-o", "json", sql],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout or "query failed")[:2000])
    text = proc.stdout.strip()
    start = text.find("{")
    if start < 0:
        raise RuntimeError(f"No JSON in output: {text[:500]}")
    payload = json.loads(text[start:])
    return payload.get("rows") or []


def main() -> int:
    content = SQL_FILE.read_text()
    blocks = [b.strip() for b in content.split(";") if b.strip() and not b.strip().startswith("--")]
    results: list[dict] = []
    for block in blocks:
        if "check_id" not in block:
            continue
        rows = run_sql(block)
        if rows:
            results.append(rows[0])
    print(json.dumps(results, indent=2))
    nonzero = [r for r in results if int(r.get("cnt") or 0) > 0]
    print(f"\n# checks with issues: {len(nonzero)} / {len(results)}", file=sys.stderr)
    for r in sorted(nonzero, key=lambda x: -int(x["cnt"])):
        print(f"  {r['check_id']}: {r['cnt']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
