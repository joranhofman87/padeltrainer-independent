#!/usr/bin/env python3
"""
Copy Storage objects from source → target (same bucket names and paths).

DEFAULT: dry-run (counts only). Does NOT delete on either side.

  export SOURCE_SUPABASE_URL="https://ppkbhdiiqdusdeatgdft.supabase.co"
  export SOURCE_SERVICE_ROLE_KEY="..."
  export TARGET_SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export TARGET_SERVICE_ROLE_KEY="..."

  python3 scripts/migration/storage_copy_buckets.py
  python3 scripts/migration/storage_copy_buckets.py --execute --confirm
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

def encode_storage_path(path: str) -> str:
    return urllib.parse.quote(path, safe="/")


from storage_common import (
    AVATAR_PATH_PREFIXES,
    MIGRATION_BUCKETS,
    PRIVATE_BUCKETS,
    SOURCE_PROJECT_REF,
    SOURCE_STORAGE_HOST,
    TARGET_PROJECT_REF,
    assert_project_url,
    iter_bucket_objects,
    iter_bucket_objects_recursive,
    list_bucket_objects,
    project_url_env,
)


def download_object(
    url: str,
    key: str,
    bucket: str,
    path: str,
    *,
    public_bucket: bool,
) -> bytes:
    enc = encode_storage_path(path)
    if public_bucket:
        api = SOURCE_STORAGE_HOST + f"/storage/v1/object/public/{bucket}/{enc}"
        req = urllib.request.Request(api, method="GET")
    else:
        api = url.rstrip("/") + f"/storage/v1/object/{bucket}/{enc}"
        headers = {"apikey": key, "Authorization": f"Bearer {key}"}
        req = urllib.request.Request(api, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.read()


def upload_object(
    url: str, key: str, bucket: str, path: str, data: bytes, *, upsert: bool
) -> None:
    api = url.rstrip("/") + f"/storage/v1/object/{bucket}/{encode_storage_path(path)}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/octet-stream",
        "x-upsert": "true" if upsert else "false",
    }
    req = urllib.request.Request(api, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=300) as resp:
        resp.read()


def object_exists(url: str, key: str, bucket: str, path: str) -> bool:
    """Supabase Storage often rejects HEAD; use a minimal GET instead."""
    api = url.rstrip("/") + f"/storage/v1/object/{bucket}/{encode_storage_path(path)}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Range": "bytes=0-0",
    }
    req = urllib.request.Request(api, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status in (200, 206)
    except urllib.error.HTTPError as e:
        if e.code in (400, 404, 416):
            return False
        raise


def main() -> int:
    parser = argparse.ArgumentParser(description="Copy storage buckets source→target")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--bucket", choices=MIGRATION_BUCKETS, help="Single bucket only")
    parser.add_argument(
        "--no-skip-existing",
        action="store_true",
        help="Upload even when path already exists on target (may error without --upsert)",
    )
    parser.add_argument("--upsert", action="store_true", help="Overwrite existing paths on target")
    args = parser.parse_args()

    src_url, src_key, src_sr = project_url_env("SOURCE")
    tgt_url, tgt_key, tgt_sr = project_url_env("TARGET")
    if not src_url or not src_key or not tgt_url or not tgt_key:
        print("ERROR: SOURCE_* and TARGET_* (or SUPABASE_*) env vars required", file=sys.stderr)
        return 1
    if not tgt_sr:
        print("ERROR: TARGET service_role key required for uploads", file=sys.stderr)
        return 1
    assert_project_url(src_url, SOURCE_PROJECT_REF, "SOURCE")
    assert_project_url(tgt_url, TARGET_PROJECT_REF, "TARGET")

    buckets = [args.bucket] if args.bucket else list(MIGRATION_BUCKETS)

    totals = {
        "source_counts": {},
        "target_before": {},
        "target_after": {},
        "copied": 0,
        "skipped": 0,
        "failed": 0,
    }

    for bucket in buckets:
        print(f"\n=== {bucket} ===", flush=True)
        if bucket in PRIVATE_BUCKETS and not src_sr:
            print(
                f"SKIP {bucket}: set SOURCE_SERVICE_ROLE_KEY for {SOURCE_PROJECT_REF}",
                file=sys.stderr,
            )
            totals["source_counts"][bucket] = 0
            totals["target_before"][bucket] = len(list_bucket_objects(tgt_url, tgt_key, bucket))
            totals["target_after"][bucket] = totals["target_before"][bucket]
            continue
        tgt_before = len(list_bucket_objects(tgt_url, tgt_key, bucket))
        totals["target_before"][bucket] = tgt_before

        if not args.execute:
            src_count = sum(1 for _ in iter_bucket_objects(src_url, src_key, bucket))
            totals["source_counts"][bucket] = src_count
            print(f"Source objects: {src_count:,}")
            print(f"Target objects (now): {tgt_before:,}")
            print(f"Would copy: {src_count:,} paths (no deletes)")
            continue

        if not args.confirm:
            print("ERROR: --execute requires --confirm", file=sys.stderr)
            return 1

        copied = skipped = failed = discovered = 0
        list_errors: list[str] = []

        def process_object(obj) -> None:
            nonlocal copied, skipped, failed, discovered
            discovered += 1
            skip_existing = not args.no_skip_existing
            if skip_existing and not args.upsert:
                try:
                    if object_exists(tgt_url, tgt_key, bucket, obj.path):
                        skipped += 1
                        return
                except Exception as e:
                    print(f"  WARN exists check {obj.path}: {e}", file=sys.stderr)
            try:
                data = download_object(
                    src_url,
                    src_key,
                    bucket,
                    obj.path,
                    public_bucket=bucket not in PRIVATE_BUCKETS,
                )
                upload_object(
                    tgt_url,
                    tgt_key,
                    bucket,
                    obj.path,
                    data,
                    upsert=args.upsert,
                )
                copied += 1
            except Exception as e:
                failed += 1
                print(f"  FAIL {obj.path}: {e}", file=sys.stderr)
            if discovered % 50 == 0:
                print(
                    f"  [{discovered:,}] copied={copied} skipped={skipped} failed={failed}",
                    flush=True,
                )
            time.sleep(0.03)

        if bucket == "avatars":
            for prefix in AVATAR_PATH_PREFIXES:
                print(f"  prefix {prefix}", flush=True)
                try:
                    for obj in iter_bucket_objects_recursive(
                        src_url, src_key, bucket, root_prefix=prefix
                    ):
                        process_object(obj)
                except Exception as e:
                    list_errors.append(f"{prefix}: {e}")
                    print(f"  LIST ERROR {prefix}: {e}", file=sys.stderr)
        else:
            try:
                for obj in list_bucket_objects(src_url, src_key, bucket):
                    process_object(obj)
            except Exception as e:
                list_errors.append(str(e))
                print(f"  LIST ERROR: {e}", file=sys.stderr)

        totals["source_counts"][bucket] = discovered
        print(f"Source objects (discovered): {discovered:,}")
        print(f"Done {bucket}: copied={copied} skipped={skipped} failed={failed}")
        if list_errors:
            print(f"  List errors: {len(list_errors)}", file=sys.stderr)
        totals["copied"] += copied
        totals["skipped"] += skipped
        totals["failed"] += failed
        totals["target_after"][bucket] = len(list_bucket_objects(tgt_url, tgt_key, bucket))

    print("\n" + "=" * 60)
    print("STORAGE COPY SUMMARY")
    print("=" * 60)
    print(f"{'bucket':<18} {'source':>8} {'target_before':>14} {'target_after':>13}")
    for bucket in buckets:
        print(
            f"{bucket:<18} "
            f"{totals['source_counts'].get(bucket, 0):8,} "
            f"{totals['target_before'].get(bucket, 0):14,} "
            f"{totals['target_after'].get(bucket, 0):13,}"
        )
    if args.execute:
        print(
            f"\nCopied: {totals['copied']:,}  Skipped: {totals['skipped']:,}  "
            f"Failed: {totals['failed']:,}"
        )

    if not args.execute:
        print("\nDry-run only. To copy:")
        print("  python3 scripts/migration/storage_copy_buckets.py --execute --confirm")
    return 1 if args.execute and totals["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
