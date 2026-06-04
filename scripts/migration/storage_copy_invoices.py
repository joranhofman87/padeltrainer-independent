#!/usr/bin/env python3
"""
Copy invoices bucket source → target (private bucket; requires source service_role).

Also supports copying only PDF paths referenced in public.invoices (faster).

  export SOURCE_SUPABASE_URL="https://ppkbhdiiqdusdeatgdft.supabase.co"
  export SOURCE_SERVICE_ROLE_KEY="..."   # must be ppkbhd project
  export TARGET_SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export TARGET_SERVICE_ROLE_KEY="..."

  python3 scripts/migration/storage_copy_invoices.py
  python3 scripts/migration/storage_copy_invoices.py --from-db-paths-only
  python3 scripts/migration/storage_copy_invoices.py --execute --confirm
  python3 scripts/migration/storage_copy_invoices.py --execute --confirm --full-bucket
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage_common import (
    SOURCE_PROJECT_REF,
    TARGET_PROJECT_REF,
    assert_project_url,
    list_bucket_objects,
    parse_storage_path_from_url,
    project_url_env,
)
from storage_copy_buckets import (
    download_object,
    encode_storage_path,
    object_exists,
    upload_object,
)


def paths_from_database(database_url: str) -> list[str]:
    import psycopg2  # type: ignore

    conn = psycopg2.connect(database_url)
    paths: set[str] = set()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pdf_url::text FROM public.invoices WHERE pdf_url IS NOT NULL"
            )
            for (url,) in cur.fetchall():
                parsed = parse_storage_path_from_url(url or "")
                if parsed and parsed[0] == "invoices" and parsed[1].endswith(".pdf"):
                    paths.add(parsed[1])
            # HTML siblings sometimes exist
            for p in list(paths):
                if p.endswith(".pdf"):
                    paths.add(p[:-4] + ".html")
    finally:
        conn.close()
    return sorted(paths)


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy invoices storage bucket")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument(
        "--from-db-paths-only",
        action="store_true",
        help="Copy only paths parsed from invoices.pdf_url (default)",
    )
    parser.add_argument(
        "--full-bucket",
        action="store_true",
        help="List and copy entire invoices bucket",
    )
    args = parser.parse_args()

    src_url, src_key, src_sr = project_url_env("SOURCE")
    tgt_url, tgt_key, tgt_sr = project_url_env("TARGET")
    if not src_url or not src_key or not tgt_url or not tgt_key:
        print("ERROR: SOURCE_* and TARGET_* required", file=sys.stderr)
        return 1
    if not src_sr:
        print(
            f"ERROR: SOURCE_SERVICE_ROLE_KEY for {SOURCE_PROJECT_REF} is required "
            "(invoices bucket is private)",
            file=sys.stderr,
        )
        return 1
    if not tgt_sr:
        print("ERROR: TARGET service_role required", file=sys.stderr)
        return 1
    assert_project_url(src_url, SOURCE_PROJECT_REF, "SOURCE")
    assert_project_url(tgt_url, TARGET_PROJECT_REF, "TARGET")

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")

    if args.full_bucket:
        print("Listing full source invoices bucket…", flush=True)
        src_objects = list_bucket_objects(src_url, src_key, "invoices")
        work = [(o.bucket, o.path) for o in src_objects]
    else:
        if not db_url:
            print("ERROR: DATABASE_URL required for --from-db-paths-only", file=sys.stderr)
            return 1
        work = [("invoices", p) for p in paths_from_database(db_url)]

    print("=" * 60)
    print("INVOICES BUCKET COPY")
    print("=" * 60)
    print(f"Mode: {'full bucket' if args.full_bucket else 'DB pdf_url paths only'}")
    print(f"Objects to process: {len(work):,}")

    to_copy: list[tuple[str, str]] = []
    for bucket, path in work:
        if path.endswith(".pdf") or path.endswith(".html"):
            to_copy.append((bucket, path))

    # Dry-run: check target skip
    would_skip = would_copy = 0
    for bucket, path in to_copy:
        if object_exists(tgt_url, tgt_key, bucket, path):
            would_skip += 1
        else:
            would_copy += 1
    print(f"Would copy:  {would_copy:,}")
    print(f"Would skip:  {would_skip:,} (already on target)")

    if not args.execute:
        if to_copy[:5]:
            print("\nSample paths:")
            for _, p in to_copy[:5]:
                print(f"  invoices/{p}")
        print("\nDry-run. To copy:")
        print("  python3 scripts/migration/storage_copy_invoices.py --execute --confirm")
        return 0

    if not args.confirm:
        print("ERROR: --execute requires --confirm", file=sys.stderr)
        return 1

    copied = skipped = failed = 0
    for i, (bucket, path) in enumerate(to_copy, start=1):
        if object_exists(tgt_url, tgt_key, bucket, path):
            skipped += 1
            continue
        try:
            data = download_object(
                src_url, src_key, bucket, path, public_bucket=False
            )
            upload_object(tgt_url, tgt_key, bucket, path, data, upsert=False)
            copied += 1
        except Exception as e:
            failed += 1
            print(f"  FAIL {path}: {e}", file=sys.stderr)
        if i % 20 == 0 or i == len(to_copy):
            print(f"  [{i}/{len(to_copy)}] copied={copied} skipped={skipped} failed={failed}")
        time.sleep(0.05)

    print("\n" + "=" * 60)
    print(f"Copied: {copied:,}  Skipped: {skipped:,}  Failed: {failed:,}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
