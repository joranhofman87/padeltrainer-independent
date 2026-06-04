#!/usr/bin/env python3
"""
Dry-run plan for public-table CSV import (no writes).

  cd padeltrainer
  python3 scripts/migration/import_public_dry_run.py

Optional FK order from live schema (read-only):

  DATABASE_URL="postgresql://postgres.ficwbdrzefmblkbkomzw:...@...:5432/postgres" \\
    python3 scripts/migration/import_public_dry_run.py

Include deferred analytics/log/queue tables:

  python3 scripts/migration/import_public_dry_run.py --include-optional
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_common import (
    OPTIONAL_SKIP_TABLES,
    build_import_plan,
    discover_exports,
    format_duration,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Public table import dry-run plan")
    parser.add_argument("--exports-dir", type=Path, default=Path("migration_exports"))
    parser.add_argument(
        "--include-optional",
        action="store_true",
        help="Include analytics/log/queue tables in import set",
    )
    parser.add_argument("--json", action="store_true", help="Print JSON plan")
    args = parser.parse_args()

    if not args.exports_dir.is_dir():
        print(f"ERROR: {args.exports_dir} not found", file=sys.stderr)
        return 1

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    plan = build_import_plan(
        args.exports_dir,
        include_optional=args.include_optional,
        database_url=db_url,
    )
    exports = discover_exports(args.exports_dir)

    print("=" * 60)
    print("PUBLIC TABLE IMPORT PLAN (dry-run)")
    print("=" * 60)
    print(f"Target project:     {plan.target_project_ref}")
    print(f"Exports directory:  {plan.exports_dir.resolve()}")
    print(f"Auth schema:        SKIP (auth.users already migrated)")
    print(f"FK order source:    {plan.fk_source} ({plan.fk_edges_used} in-plan FK edges)")
    print()
    print("Safety (execute phase):")
    print("  - Direct PostgreSQL COPY/INSERT only (no Edge Functions)")
    print("  - SET session_replication_role = replica (disables user triggers)")
    print("  - No Resend / auth email APIs")
    print("  - Optional/queue tables skipped unless --include-optional")
    print()
    print(f"Tables to import:   {len(plan.import_tables)}")
    print(f"Rows to import:     {plan.total_rows:,}")
    print(
        f"Estimated duration: {format_duration(plan.estimated_seconds)} "
        f"(~{plan.total_rows:,} rows @ 250 rows/s)"
    )
    print()
    print(f"Deferred (optional): {len(plan.deferred_tables)}")
    if plan.deferred_tables:
        print(f"  {', '.join(plan.deferred_tables)}")
    print()
    print(f"Missing exports (no CSV): {len(plan.missing_exports)}")
    print(f"  {', '.join(plan.missing_exports)}")
    print()
    print("Import order (FK-respecting):")
    print(f"{'#':>3}  {'table':<35} {'rows':>8}")
    print("-" * 50)
    for i, table in enumerate(plan.import_order, start=1):
        print(f"{i:3d}  {table:<35} {plan.row_counts[table]:>8,}")

    empty = [t for t in plan.import_tables if plan.row_counts[t] == 0]
    if empty:
        print()
        print(f"Empty exports still imported (schema defaults): {len(empty)}")
        print(f"  {', '.join(empty)}")

    dupes = [e for e in exports.values() if e.duplicate_files]
    if dupes:
        print()
        print("Duplicate export files (largest file used):")
        for ex in dupes[:5]:
            print(f"  {ex.name}: ignored {ex.duplicate_files}")
        if len(dupes) > 5:
            print(f"  ... and {len(dupes) - 5} more")

    if plan.warnings:
        print()
        print("Warnings:")
        for w in plan.warnings:
            print(f"  - {w}")

    print()
    print("Optional skip set (default off):")
    print(f"  {', '.join(sorted(OPTIONAL_SKIP_TABLES))}")
    print()
    print("After you approve, run execute (does NOT run in dry-run):")
    print(
        "  DATABASE_URL='postgresql://postgres.ficwbdrzefmblkbkomzw:...@pooler.../postgres' \\"
    )
    print(
        "  python3 scripts/migration/import_public_execute.py --execute --confirm"
    )

    if args.json:
        payload = {
            "target_project_ref": plan.target_project_ref,
            "import_tables": plan.import_tables,
            "deferred_tables": plan.deferred_tables,
            "missing_exports": plan.missing_exports,
            "row_counts": plan.row_counts,
            "import_order": plan.import_order,
            "total_rows": plan.total_rows,
            "estimated_seconds": plan.estimated_seconds,
            "fk_source": plan.fk_source,
            "warnings": plan.warnings,
        }
        print("\n" + json.dumps(payload, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main())
