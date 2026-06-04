#!/usr/bin/env python3
"""
Update DB text columns: old Supabase storage host → new project host.

Does NOT update invoices.pdf_url (signed URLs; regenerate invoice PDFs post-cutover).

DEFAULT: dry-run (counts only). Does NOT modify data until --execute --confirm.

  export DATABASE_URL="postgresql://postgres.ficwbdrzefmblkbkomzw:...@pooler.../postgres"

  python3 scripts/migration/storage_update_urls.py
  python3 scripts/migration/storage_update_urls.py --execute --confirm
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage_common import (
    NEW_URL_PREFIX,
    OLD_URL_PREFIX,
    SOURCE_PROJECT_REF,
    TARGET_PROJECT_REF,
    URL_COLUMNS_NON_INVOICE,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Rewrite storage URLs in public tables")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        return 1

    from import_common import assert_target_database_url

    assert_target_database_url(db_url)

    import psycopg2  # type: ignore

    old_host = f"{SOURCE_PROJECT_REF}.supabase.co"
    new_host = f"{TARGET_PROJECT_REF}.supabase.co"

    print("=" * 60)
    print("STORAGE URL UPDATE PLAN")
    print("=" * 60)
    print(f"Target DB: {TARGET_PROJECT_REF}")
    print(f"Replace host: {old_host} → {new_host}")
    print("Excluded: invoices.pdf_url")
    print(f"URL prefix:   {OLD_URL_PREFIX}")
    print(f"           → {NEW_URL_PREFIX}")
    print()

    conn = psycopg2.connect(db_url)
    plan: list[tuple[str, str, int]] = []
    try:
        with conn.cursor() as cur:
            for table, column in URL_COLUMNS_NON_INVOICE:
                cur.execute(
                    f"""
                    SELECT COUNT(*) FROM public.{table}
                    WHERE {column} IS NOT NULL AND {column}::text LIKE %s
                    """,
                    (f"%{old_host}%",),
                )
                (n,) = cur.fetchone()
                if n:
                    plan.append((table, column, int(n)))
                    print(f"  {table}.{column}: {n:,} row(s)")

        if not plan:
            print("No rows to update.")
            return 0

        print(f"\nTotal: {sum(n for _, _, n in plan):,} row updates across {len(plan)} column(s)")

        if not args.execute:
            print("\nDry-run only. To apply:")
            print("  python3 scripts/migration/storage_update_urls.py --execute --confirm")
            return 0

        if not args.confirm:
            print("ERROR: --execute requires --confirm", file=sys.stderr)
            return 1

        print("\n--- Executing updates ---")
        with conn.cursor() as cur:
            for table, column, _ in plan:
                cur.execute(
                    f"""
                    UPDATE public.{table}
                    SET {column} = REPLACE({column}::text, %s, %s)
                    WHERE {column} IS NOT NULL AND {column}::text LIKE %s
                    """,
                    (old_host, new_host, f"%{old_host}%"),
                )
                print(f"  updated {table}.{column}: {cur.rowcount:,}")
        conn.commit()
        print("\nCommitted.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
