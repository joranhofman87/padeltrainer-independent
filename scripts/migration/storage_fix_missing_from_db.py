#!/usr/bin/env python3
"""
Copy missing storage files referenced by target DB URLs (old Lovable host).

Scope (default):
  - locations.logo_url → avatars/clubs/...
  - profiles.avatar_url → avatars/... (excludes invoices/)

Does NOT touch invoices.pdf_url or update database URLs.

  export DATABASE_URL="postgresql://postgres.ficwbdrzefmblkbkomzw:...@pooler.../postgres"
  export SOURCE_SUPABASE_URL="https://ppkbhdiiqdusdeatgdft.supabase.co"
  export TARGET_SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export TARGET_SERVICE_ROLE_KEY="..."

  python3 scripts/migration/storage_fix_missing_from_db.py
  python3 scripts/migration/storage_fix_missing_from_db.py --execute --confirm
  python3 scripts/migration/storage_fix_missing_from_db.py --audit-only
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage_common import (
    SOURCE_PROJECT_REF,
    SOURCE_STORAGE_HOST,
    TARGET_PROJECT_REF,
    TARGET_STORAGE_HOST,
    parse_storage_path_from_url,
    project_url_env,
)
from storage_copy_buckets import download_object, encode_storage_path, upload_object

OLD_HOST = f"{SOURCE_PROJECT_REF}.supabase.co"


@dataclass(frozen=True)
class DbRef:
    table: str
    column: str
    bucket: str
    path: str


def fetch_db_refs(database_url: str) -> tuple[list[DbRef], list[DbRef]]:
    import psycopg2  # type: ignore

    from import_common import assert_target_database_url

    assert_target_database_url(database_url)
    clubs: list[DbRef] = []
    profiles: list[DbRef] = []
    seen_clubs: set[str] = set()
    seen_prof: set[str] = set()

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT logo_url::text FROM public.locations
                WHERE logo_url IS NOT NULL AND logo_url::text LIKE %s
                """,
                (f"%{OLD_HOST}%",),
            )
            for (url,) in cur.fetchall():
                parsed = parse_storage_path_from_url(url)
                if not parsed:
                    continue
                bucket, path = parsed
                if bucket != "avatars" or not path.startswith("clubs/"):
                    continue
                if path in seen_clubs:
                    continue
                seen_clubs.add(path)
                clubs.append(DbRef("locations", "logo_url", bucket, path))

            cur.execute(
                """
                SELECT avatar_url::text FROM public.profiles
                WHERE avatar_url IS NOT NULL AND avatar_url::text LIKE %s
                """,
                (f"%{OLD_HOST}%",),
            )
            for (url,) in cur.fetchall():
                parsed = parse_storage_path_from_url(url)
                if not parsed:
                    continue
                bucket, path = parsed
                if bucket != "avatars" or path.startswith("invoices/"):
                    continue
                if path in seen_prof:
                    continue
                seen_prof.add(path)
                profiles.append(DbRef("profiles", "avatar_url", bucket, path))
    finally:
        conn.close()

    return clubs, profiles


def target_object_exists(bucket: str, path: str, tgt_key: str) -> str:
    """Return 'yes', 'no', or 'error'."""
    enc = encode_storage_path(path)
    api = f"{TARGET_STORAGE_HOST}/storage/v1/object/{bucket}/{enc}"
    headers = {
        "apikey": tgt_key,
        "Authorization": f"Bearer {tgt_key}",
        "Range": "bytes=0-0",
    }
    req = urllib.request.Request(api, headers=headers, method="GET")
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return "yes" if resp.status in (200, 206) else "no"
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 416):
                return "no"
            if e.code in (408, 429, 500, 502, 503, 504, 544) and attempt < 5:
                time.sleep(min(2**attempt, 30))
                continue
            return "error"
        except Exception:
            if attempt < 5:
                time.sleep(min(2**attempt, 30))
                continue
            return "error"
    return "error"


def _public_exists(host: str, bucket: str, path: str) -> bool:
    enc = encode_storage_path(path)
    api = f"{host}/storage/v1/object/public/{bucket}/{enc}"
    req = urllib.request.Request(api, method="GET", headers={"Range": "bytes=0-0"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status in (200, 206)
        except urllib.error.HTTPError as e:
            if e.code in (400, 404, 416):
                return False
            if e.code in (408, 429, 500, 502, 503, 504, 544) and attempt < 5:
                time.sleep(min(2**attempt, 30))
                continue
            return False
        except Exception:
            if attempt < 5:
                time.sleep(min(2**attempt, 30))
                continue
            return False
    return False


def target_public_exists(bucket: str, path: str, tgt_key: str | None = None) -> bool:
    if tgt_key:
        return target_object_exists(bucket, path, tgt_key) == "yes"
    return _public_exists(TARGET_STORAGE_HOST, bucket, path)


def source_public_exists(bucket: str, path: str) -> bool:
    return _public_exists(SOURCE_STORAGE_HOST, bucket, path)


def partition_missing(
    refs: list[DbRef], *, label: str = "", tgt_key: str = ""
) -> tuple[list[DbRef], list[DbRef], int]:
    """Return (missing_on_target, present_on_target, check_errors)."""
    missing: list[DbRef] = []
    present: list[DbRef] = []
    errors = 0
    for i, ref in enumerate(refs, start=1):
        state = target_object_exists(ref.bucket, ref.path, tgt_key) if tgt_key else (
            "yes" if target_public_exists(ref.bucket, ref.path) else "no"
        )
        if state == "yes":
            present.append(ref)
        elif state == "no":
            missing.append(ref)
        else:
            errors += 1
            missing.append(ref)
        if label and i % 500 == 0:
            print(
                f"  … {label}: checked {i:,}/{len(refs):,} "
                f"missing={len(missing):,} errors={errors}",
                flush=True,
            )
        time.sleep(0.005)
    return missing, present, errors


def print_paths(label: str, refs: list[DbRef], *, limit: int | None) -> None:
    print(f"\n{label} ({len(refs):,} path(s)):")
    show = refs if limit is None else refs[:limit]
    for ref in show:
        print(f"  {ref.bucket}/{ref.path}")
    if limit is not None and len(refs) > limit:
        print(f"  ... and {len(refs) - limit:,} more")


def copy_missing(
    src_url: str,
    src_key: str,
    tgt_url: str,
    tgt_key: str,
    missing: list[DbRef],
) -> tuple[int, int, list[str]]:
    copied = skipped = 0
    failures: list[str] = []
    for i, ref in enumerate(missing, start=1):
        if target_object_exists(ref.bucket, ref.path, tgt_key) == "yes":
            skipped += 1
            continue
        try:
            data = download_object(
                src_url,
                src_key,
                ref.bucket,
                ref.path,
                public_bucket=True,
            )
            upload_object(
                tgt_url,
                tgt_key,
                ref.bucket,
                ref.path,
                data,
                upsert=False,
            )
            copied += 1
        except Exception as e:
            failures.append(f"{ref.bucket}/{ref.path}: {e}")
            print(f"  FAIL {ref.bucket}/{ref.path}: {e}", file=sys.stderr)
        if i % 50 == 0 or i == len(missing):
            print(
                f"  [{i}/{len(missing)}] copied={copied} skipped={skipped} "
                f"failed={len(failures)}",
                flush=True,
            )
        time.sleep(0.03)
    return copied, skipped, failures


def run_audit(database_url: str, tgt_key: str) -> int:
    clubs_refs, prof_refs = fetch_db_refs(database_url)
    clubs_miss, clubs_ok, _ = partition_missing(clubs_refs, tgt_key=tgt_key)
    prof_miss, prof_ok, _ = partition_missing(prof_refs, tgt_key=tgt_key)

    print()
    print("=" * 60)
    print("POST-COPY STORAGE AUDIT (DB URLs → target public storage)")
    print("=" * 60)
    print(f"locations.logo_url → avatars/clubs/")
    print(f"  DB refs (old host):     {len(clubs_refs):,}")
    print(f"  Present on target:      {len(clubs_ok):,}")
    print(f"  Still missing:          {len(clubs_miss):,}")
    print(f"profiles.avatar_url → avatars/")
    print(f"  DB refs (old host):     {len(prof_refs):,}")
    print(f"  Present on target:      {len(prof_ok):,}")
    print(f"  Still missing:          {len(prof_miss):,}")

    if clubs_miss:
        print_paths("Missing avatars/clubs", clubs_miss, limit=30)
    if prof_miss:
        print_paths("Missing profile avatars", prof_miss, limit=None)

    return len(clubs_miss) + len(prof_miss)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Copy missing avatars referenced by target DB (old-host URLs)"
    )
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help="Re-run existence audit only (no copy)",
    )
    parser.add_argument(
        "--list-limit",
        type=int,
        default=50,
        help="Max paths to print per group in dry-run (0 = all)",
    )
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        return 1

    tgt_url, tgt_key, tgt_sr = project_url_env("TARGET")
    if not tgt_url or not tgt_key:
        print("ERROR: TARGET_* env required", file=sys.stderr)
        return 1
    if not tgt_sr:
        print("ERROR: TARGET service_role required", file=sys.stderr)
        return 1

    if args.audit_only:
        return 1 if run_audit(db_url, tgt_key) else 0

    src_url, src_key, _ = project_url_env("SOURCE")
    if not src_url or not src_key:
        print("ERROR: SOURCE_* env required", file=sys.stderr)
        return 1

    print("=" * 60)
    print("TARGETED STORAGE FIX — DRY-RUN")
    print("=" * 60)
    print("Policy: copy missing only; no deletes; no DB URL updates; skip invoices")
    print()

    clubs_refs, prof_refs = fetch_db_refs(db_url)
    print("Checking target storage (public URLs)…", flush=True)
    clubs_missing, clubs_present, clubs_err = partition_missing(
        clubs_refs, label="avatars/clubs", tgt_key=tgt_key
    )
    prof_missing, prof_present, prof_err = partition_missing(
        prof_refs, label="profile avatars", tgt_key=tgt_key
    )
    if clubs_err or prof_err:
        print(f"  (existence check errors: clubs={clubs_err}, profiles={prof_err})")

    print(f"locations.logo_url (avatars/clubs/, old host in DB)")
    print(f"  Unique DB paths:        {len(clubs_refs):,}")
    print(f"  Already on target:      {len(clubs_present):,}")
    print(f"  Missing on target:      {len(clubs_missing):,}")

    print(f"\nprofiles.avatar_url (avatars/, old host in DB)")
    print(f"  Unique DB paths:        {len(prof_refs):,}")
    print(f"  Already on target:      {len(prof_present):,}")
    print(f"  Missing on target:      {len(prof_missing):,}")

    list_limit = None if args.list_limit == 0 else args.list_limit
    if clubs_missing:
        print_paths("Missing avatars/clubs paths", clubs_missing, limit=list_limit)
    if prof_missing:
        print_paths("Missing profile avatar paths", prof_missing, limit=list_limit)

    # Source availability for missing (helps explain unrecoverable gaps)
    src_missing = 0
    for ref in clubs_missing + prof_missing:
        if not source_public_exists(ref.bucket, ref.path):
            src_missing += 1
    if clubs_missing or prof_missing:
        print(
            f"\nOf missing-on-target paths, absent on source (public): {src_missing:,}"
        )

    total_missing = len(clubs_missing) + len(prof_missing)
    if total_missing == 0:
        print("\nNothing to copy.")
        run_audit(db_url, tgt_key)
        return 0

    if not args.execute:
        print("\nDry-run only. To copy missing files:")
        print("  python3 scripts/migration/storage_fix_missing_from_db.py --execute --confirm")
        return 0

    if not args.confirm:
        print("ERROR: --execute requires --confirm", file=sys.stderr)
        return 1

    print("\n" + "=" * 60)
    print("COPYING MISSING FILES")
    print("=" * 60)

    total_copied = total_skipped = 0
    all_failures: list[str] = []

    if clubs_missing:
        print(f"\n--- avatars/clubs ({len(clubs_missing):,}) ---")
        c, s, f = copy_missing(src_url, src_key, tgt_url, tgt_key, clubs_missing)
        total_copied += c
        total_skipped += s
        all_failures.extend(f)

    if prof_missing:
        print(f"\n--- profile avatars ({len(prof_missing):,}) ---")
        c, s, f = copy_missing(src_url, src_key, tgt_url, tgt_key, prof_missing)
        total_copied += c
        total_skipped += s
        all_failures.extend(f)

    print("\n" + "=" * 60)
    print("COPY SUMMARY")
    print("=" * 60)
    print(f"  Missing before:  {total_missing:,}")
    print(f"  Copied:          {total_copied:,}")
    print(f"  Skipped (exist): {total_skipped:,}")
    print(f"  Failed:          {len(all_failures):,}")
    if all_failures:
        print("\nFailed paths:")
        for line in all_failures[:30]:
            print(f"  {line}")
        if len(all_failures) > 30:
            print(f"  ... and {len(all_failures) - 30} more")

    still_missing = run_audit(db_url, tgt_key)
    return 1 if all_failures or still_missing else 0


if __name__ == "__main__":
    sys.exit(main())
