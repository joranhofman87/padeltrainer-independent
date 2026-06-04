#!/usr/bin/env python3
"""
Truncate the 8 pre-seeded tables before public CSV import.

  python3 scripts/migration/import_public_truncate_eight.py          # plan only
  python3 scripts/migration/import_public_truncate_eight.py --execute --confirm
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth_common import TARGET_PROJECT_REF
from import_common import OPTIONAL_SKIP_TABLES, assert_target_database_url

TRUNCATE_TABLES = [
    "profiles",
    "locations",
    "subscription_plans",
    "certifications",
    "specializations",
    "rating_systems",
    "review_tags",
    "banner_placements",
]


def fetch_fk_dependents(cur, table: str) -> list[str]:
    cur.execute(
        """
        SELECT DISTINCT tc.table_name AS dependent
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'public'
          AND ccu.table_schema = 'public'
          AND ccu.table_name = %s
        ORDER BY 1
        """,
        (table,),
    )
    return [r[0] for r in cur.fetchall()]


def table_count(cur, table: str) -> int:
    cur.execute(f"SELECT COUNT(*) FROM public.{table}")  # noqa: S608
    (n,) = cur.fetchone()
    return int(n)


def fk_dependent_closure(cur) -> set[str]:
    """All public tables that (transitively) reference the 8 via FK."""
    children: set[str] = set()
    frontier = list(TRUNCATE_TABLES)
    seen_parents = set(TRUNCATE_TABLES)
    while frontier:
        cur.execute(
            """
            SELECT DISTINCT tc.table_name AS child
            FROM information_schema.table_constraints tc
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = 'public'
              AND ccu.table_schema = 'public'
              AND ccu.table_name = ANY(%s)
            """,
            (frontier,),
        )
        next_frontier: list[str] = []
        for (child,) in cur.fetchall():
            children.add(child)
            if child not in seen_parents:
                seen_parents.add(child)
                next_frontier.append(child)
        frontier = next_frontier
    return children


def plan_truncate(cur) -> dict:
    """FK cluster: 8 targets + empty dependents required by PostgreSQL TRUNCATE."""
    counts_before = {t: table_count(cur, t) for t in TRUNCATE_TABLES}
    closure = fk_dependent_closure(cur)
    extra_required = sorted(closure - set(TRUNCATE_TABLES))
    optional_touched = sorted(set(extra_required) & set(OPTIONAL_SKIP_TABLES))

    nonempty_dependents: list[tuple[str, int]] = []
    for d in extra_required:
        n = table_count(cur, d)
        if n > 0:
            nonempty_dependents.append((d, n))

    return {
        "counts_before": counts_before,
        "extra_required": extra_required,
        "optional_touched": optional_touched,
        "nonempty_dependents": nonempty_dependents,
        "truncate_all": sorted(set(TRUNCATE_TABLES) | closure),
    }


def print_plan(analysis: dict) -> None:
    print("=" * 60)
    print("TRUNCATE PLAN")
    print("=" * 60)
    print(f"Target: {TARGET_PROJECT_REF}")
    print()
    print("Primary targets (8) — rows before truncate:")
    for t in TRUNCATE_TABLES:
        print(f"  public.{t}: {analysis['counts_before'][t]:,}")
    print()
    print("Excluded (will NOT truncate):")
    print("  - auth.users / auth schema")
    print("  - storage.*")
    print("  - optional queue/log/campaign tables not in FK cluster (e.g. notification_queue,")
    print("    onboarding_email_queue, admin_impersonation_logs, academy_profile_views)")
    print()
    print(
        f"FK-required additional tables ({len(analysis['extra_required'])}): "
        "all currently 0 rows; must be named in TRUNCATE because of FK constraints"
    )
    for t in analysis["extra_required"]:
        opt = " [optional category, 0 rows]" if t in analysis["optional_touched"] else ""
        print(f"  - public.{t}{opt}")
    if analysis["optional_touched"]:
        print()
        print("Optional-category tables in FK cluster (0 rows, not queue/log imports):")
        for t in analysis["optional_touched"]:
            print(f"  - public.{t}")
    print()
    if analysis["nonempty_dependents"]:
        print("BLOCKED: Nonempty FK dependents:")
        for d, n in analysis["nonempty_dependents"]:
            print(f"  public.{d}: {n:,} rows")
    else:
        print("Nonempty FK dependents outside the 8: none")
    print()
    print(f"Mode: single TRUNCATE (no CASCADE) — {len(analysis['truncate_all'])} public tables")
    print("Equivalent to CASCADE on the 8 targets only while all dependents are empty.")


def run_truncate(cur, analysis: dict) -> None:
    names = ", ".join(f'public."{t}"' for t in analysis["truncate_all"])
    sql = f"TRUNCATE TABLE {names} RESTART IDENTITY"
    cur.execute(sql)
    print(f"Executed: TRUNCATE {len(analysis['truncate_all'])} tables (8 primary + {len(analysis['extra_required'])} FK-required)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        return 1
    try:
        assert_target_database_url(db_url)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    import psycopg2  # type: ignore

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            analysis = plan_truncate(cur)
            print_plan(analysis)
            if not args.execute:
                print()
                print("No changes made. To execute:")
                print(
                    "  python3 scripts/migration/import_public_truncate_eight.py --execute --confirm"
                )
                return 0
            if not args.confirm:
                print("ERROR: --execute requires --confirm", file=sys.stderr)
                return 1
            if analysis["nonempty_dependents"]:
                print(
                    "ERROR: Refusing truncate — nonempty FK-dependent tables",
                    file=sys.stderr,
                )
                return 1
            print()
            print("--- Executing truncate ---")
            run_truncate(cur, analysis)
            conn.commit()
            print()
            print("Rows after truncate:")
            for t in TRUNCATE_TABLES:
                print(f"  public.{t}: {table_count(cur, t):,}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
