#!/usr/bin/env python3
"""
Dry-run: list Storage object counts per bucket (source + optional target).

Does NOT copy or delete files.

  export SOURCE_SUPABASE_URL="https://ppkbhdiiqdusdeatgdft.supabase.co"
  export SOURCE_SERVICE_ROLE_KEY="..."
  export TARGET_SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export TARGET_SERVICE_ROLE_KEY="..."   # or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY

  python3 scripts/migration/storage_migration_dry_run.py

Optional DB audit on target (read-only):

  export DATABASE_URL="postgresql://postgres.ficwbdrzefmblkbkomzw:...@pooler.../postgres"
  python3 scripts/migration/storage_migration_dry_run.py --audit-db
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage_common import (
    MIGRATION_BUCKETS,
    OLD_URL_PREFIX,
    PRIVATE_BUCKETS,
    SOURCE_PROJECT_REF,
    TARGET_PROJECT_REF,
    URL_COLUMNS,
    assert_project_url,
    list_bucket_objects,
    project_url_env,
)


def audit_db_columns(database_url: str) -> None:
    import psycopg2  # type: ignore

    from import_common import assert_target_database_url

    assert_target_database_url(database_url)
    needle = SOURCE_PROJECT_REF
    print()
    print("=" * 60)
    print("DB columns referencing old storage URLs (target, read-only)")
    print("=" * 60)
    conn = psycopg2.connect(database_url)
    total_rows = 0
    try:
        with conn.cursor() as cur:
            for table, column in URL_COLUMNS:
                try:
                    cur.execute(
                        f"""
                        SELECT COUNT(*) FROM public.{table}
                        WHERE {column} IS NOT NULL
                          AND {column}::text LIKE %s
                        """,
                        (f"%{needle}%",),
                    )
                    (n,) = cur.fetchone()
                except Exception as e:
                    conn.rollback()
                    print(f"  {table}.{column}: skip ({e})")
                    continue
                if n:
                    print(f"  {table}.{column}: {n:,} row(s)")
                    total_rows += n
    finally:
        conn.close()
    print(f"\nTotal row references (sum of counts): {total_rows:,}")
    print(f"Replace: {OLD_URL_PREFIX}")
    print(f"    → https://{TARGET_PROJECT_REF}.supabase.co/storage/v1/object")


def list_buckets(
    label: str,
    url: str,
    key: str,
    project_ref: str,
    *,
    is_service_role: bool,
) -> dict[str, int]:
    assert_project_url(url, project_ref, label)
    print()
    print(f"--- {label} ({url}) ---")
    auth = "service_role" if is_service_role else "anon"
    print(f"  Auth: {auth}")
    counts: dict[str, int] = {}
    for bucket in MIGRATION_BUCKETS:
        if label == "SOURCE" and bucket in PRIVATE_BUCKETS and not is_service_role:
            counts[bucket] = -2
            print(
                f"  {bucket}: SKIP — private bucket needs SOURCE_SERVICE_ROLE_KEY "
                f"for {SOURCE_PROJECT_REF}"
            )
            continue
        try:

            def progress(b: str, n: int) -> None:
                print(f"    … {b}: {n:,} objects listed so far", flush=True)

            objects = list_bucket_objects(url, key, bucket, on_progress=progress)
            counts[bucket] = len(objects)
            total_bytes = sum(o.size or 0 for o in objects)
            print(
                f"  {bucket}: {len(objects):,} object(s)"
                + (f", ~{total_bytes / 1_048_576:.1f} MiB" if total_bytes else ""),
                flush=True,
            )
        except Exception as e:
            counts[bucket] = -1
            print(f"  {bucket}: ERROR — {e}")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description="Storage migration dry-run")
    parser.add_argument(
        "--audit-db",
        action="store_true",
        help="Count rows on target DB with old storage host in URL columns",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("STORAGE MIGRATION DRY-RUN")
    print("=" * 60)
    print(f"Source project: {SOURCE_PROJECT_REF}")
    print(f"Target project: {TARGET_PROJECT_REF}")
    print(f"Buckets: {', '.join(MIGRATION_BUCKETS)}")
    print("Policy: copy only — no deletes on source or target")

    src_url, src_key, src_sr = project_url_env("SOURCE")
    tgt_url, tgt_key, tgt_sr = project_url_env("TARGET")

    if src_url and src_key:
        list_buckets("SOURCE", src_url, src_key, SOURCE_PROJECT_REF, is_service_role=src_sr)
    else:
        print()
        print("SOURCE not configured — set SOURCE_SUPABASE_URL + SOURCE_SERVICE_ROLE_KEY")
        print("  (Lovable dashboard → old project → Settings → API → service_role)")

    if tgt_url and tgt_key:
        list_buckets(
            "TARGET (before copy)",
            tgt_url,
            tgt_key,
            TARGET_PROJECT_REF,
            is_service_role=tgt_sr,
        )
    else:
        print()
        print("TARGET storage not configured — set TARGET_* or SUPABASE_URL + SERVICE_ROLE_KEY")

    if args.audit_db:
        import os

        db = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
        if not db:
            print("\nERROR: DATABASE_URL required for --audit-db", file=sys.stderr)
            return 1
        audit_db_columns(db)

    print()
    print("Next steps (after approval):")
    print("  python3 scripts/migration/storage_copy_buckets.py --execute --confirm")
    print("  python3 scripts/migration/storage_update_urls.py --execute --confirm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
