#!/usr/bin/env python3
"""Pre-execute checks for public import. Read-only."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth_common import TARGET_PROJECT_REF, load_profile_auth_rows
from import_common import (
    build_import_plan,
    assert_target_database_url,
    discover_exports,
)
from validate_exports import FK_CHECKS, load_column_set


def main() -> int:
    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("FAIL: DATABASE_URL not set", file=sys.stderr)
        return 1

    try:
        assert_target_database_url(db_url)
    except ValueError as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1

    import psycopg2  # type: ignore

    exports_dir = Path("migration_exports")
    plan = build_import_plan(exports_dir, database_url=db_url)
    exports = discover_exports(exports_dir)

    print("=" * 60)
    print("PRE-IMPORT CHECKS")
    print("=" * 60)
    print(f"Target ref: {TARGET_PROJECT_REF} (verified in DATABASE_URL)")
    print()

    conn = psycopg2.connect(db_url)
    ok = True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM auth.users")
            (auth_count,) = cur.fetchone()
            print(f"1. auth.users count: {auth_count} (expected 73)")
            if auth_count != 73:
                print("   FAIL")
                ok = False
            else:
                print("   PASS")

            nonempty: list[tuple[str, int]] = []
            for table in plan.import_order:
                try:
                    cur.execute(f"SELECT COUNT(*) FROM public.{table}")  # noqa: S608
                    (n,) = cur.fetchone()
                    if n > 0:
                        nonempty.append((table, int(n)))
                except Exception as e:
                    conn.rollback()
                    print(f"   WARN: could not query public.{table}: {e}")

            print()
            print(f"2. Target public tables empty: {len(nonempty)} non-empty of {len(plan.import_order)}")
            if nonempty:
                ok = False
                for t, n in nonempty[:20]:
                    print(f"   FAIL public.{t}: {n} rows")
                if len(nonempty) > 20:
                    print(f"   ... and {len(nonempty) - 20} more")
            else:
                print("   PASS (all planned import tables have 0 rows)")

            print()
            print(f"3. Total rows to import: {plan.total_rows:,} (expected 38,001)")
            if plan.total_rows != 38001:
                print("   FAIL")
                ok = False
            else:
                print("   PASS")

            print()
            print("4. First 10 tables in import order:")
            for i, t in enumerate(plan.import_order[:10], start=1):
                print(f"   {i:2d}. {t} ({plan.row_counts[t]:,} rows)")

            print()
            print("5. FK risks (CSV orphan check vs exports):")
            profile_rows = load_profile_auth_rows(exports_dir)
            auth_ids = {r.user_id for r in profile_rows if r.user_id}
            risks: list[str] = []
            id_cache: dict[tuple[str, str], set[str]] = {}

            def parent_ids(table: str, col: str) -> set[str]:
                key = (table, col)
                if key not in id_cache:
                    if table == "auth.users":
                        id_cache[key] = auth_ids
                    else:
                        ex = exports.get(table)
                        id_cache[key] = load_column_set(ex, col) if ex else set()
                return id_cache[key]

            for child, child_col, parent, parent_col in FK_CHECKS:
                if child not in plan.import_order:
                    continue
                ex = exports.get(child)
                if not ex or ex.row_count == 0:
                    continue
                if child_col not in ex.columns:
                    continue
                parents = parent_ids(parent, parent_col)
                bad = 0
                with ex.path.open(encoding="utf-8-sig", newline="") as f:
                    import csv

                    for row in csv.DictReader(f, delimiter=";"):
                        v = (row.get(child_col) or "").strip()
                        if v and v not in parents:
                            bad += 1
                if bad:
                    risks.append(f"{child}.{child_col} → {parent}: {bad} orphan(s)")

            if risks:
                ok = False
                for r in risks[:15]:
                    print(f"   FAIL {r}")
                if len(risks) > 15:
                    print(f"   ... and {len(risks) - 15} more")
            else:
                print("   PASS (no FK orphans detected in export CSVs)")

            print()
            print("Deferred (skipped) tables:", len(plan.deferred_tables))
            print(f"  {', '.join(plan.deferred_tables)}")
            print()
            print("Other FK / data notes (informational):")
            print("  - Old storage URLs in CSVs (migrate storage separately)")
            print("  - Mollie OAuth tokens stripped on academy/trainer_mollie_accounts import")
            print("  - 4 club_* tables have no CSV export")

    finally:
        conn.close()

    print()
    if ok:
        print("ALL CHECKS PASSED — safe to execute import")
        return 0
    print("CHECKS FAILED — aborting import")
    return 1


if __name__ == "__main__":
    sys.exit(main())
