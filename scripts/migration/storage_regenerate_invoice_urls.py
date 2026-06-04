#!/usr/bin/env python3
"""
After invoices bucket is on target: create fresh signed pdf_url values.

Parses storage path from existing pdf_url (old or new host), signs on TARGET,
updates public.invoices.pdf_url. Does not regenerate PDF content.

  export DATABASE_URL="postgresql://postgres.ficwbdrzefmblkbkomzw:...@pooler.../postgres"
  export TARGET_SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export TARGET_SERVICE_ROLE_KEY="..."

  python3 scripts/migration/storage_regenerate_invoice_urls.py
  python3 scripts/migration/storage_regenerate_invoice_urls.py --execute --confirm
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage_common import (
    SOURCE_PROJECT_REF,
    TARGET_PROJECT_REF,
    TARGET_STORAGE_HOST,
    parse_storage_path_from_url,
    project_url_env,
)
from storage_copy_buckets import encode_storage_path

# Match generate-invoice (1 hour); forward-invoice uses 24h — use 7 days for migration buffer
DEFAULT_EXPIRES_IN = 7 * 24 * 3600


def create_signed_url(
    tgt_key: str, bucket: str, path: str, *, expires_in: int
) -> str:
    enc = encode_storage_path(path)
    api = f"{TARGET_STORAGE_HOST}/storage/v1/object/sign/{bucket}/{enc}"
    body = json.dumps({"expiresIn": expires_in}).encode()
    headers = {
        "apikey": tgt_key,
        "Authorization": f"Bearer {tgt_key}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(api, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read().decode())
    signed = data.get("signedURL") or data.get("signedUrl") or ""
    if not signed:
        raise ValueError(f"No signed URL in response: {data!r}")
    if signed.startswith("http"):
        return signed
    return f"{TARGET_STORAGE_HOST}/storage/v1{signed}" if signed.startswith("/") else signed


def target_file_exists(tgt_key: str, bucket: str, path: str) -> bool:
    enc = encode_storage_path(path)
    api = f"{TARGET_STORAGE_HOST}/storage/v1/object/{bucket}/{enc}"
    headers = {
        "apikey": tgt_key,
        "Authorization": f"Bearer {tgt_key}",
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


def invoice_storage_path(
    pdf_url: str | None,
    invoice_number: str,
    trainer_user_id: str | None,
    academy_profile_id: str | None,
) -> str | None:
    if pdf_url:
        parsed = parse_storage_path_from_url(pdf_url)
        if parsed and parsed[0] == "invoices":
            return parsed[1]
    folder = trainer_user_id or academy_profile_id
    if folder and invoice_number:
        return f"{folder}/{invoice_number}.pdf"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Regenerate invoice pdf_url signed URLs")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument(
        "--expires-in",
        type=int,
        default=DEFAULT_EXPIRES_IN,
        help=f"Signed URL TTL seconds (default {DEFAULT_EXPIRES_IN})",
    )
    parser.add_argument(
        "--all-with-pdf",
        action="store_true",
        help="All rows with pdf_url (default: only old-host pdf_url)",
    )
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        return 1

    from import_common import assert_target_database_url

    assert_target_database_url(db_url)

    tgt_url, tgt_key, tgt_sr = project_url_env("TARGET")
    if not tgt_url or not tgt_key or not tgt_sr:
        print("ERROR: TARGET service_role required", file=sys.stderr)
        return 1

    import psycopg2  # type: ignore

    old_host = f"{SOURCE_PROJECT_REF}.supabase.co"
    conn = psycopg2.connect(db_url)
    rows: list[tuple] = []
    try:
        with conn.cursor() as cur:
            if args.all_with_pdf:
                cur.execute(
                    """
                    SELECT i.id, i.invoice_number, i.pdf_url, tp.user_id, i.academy_profile_id
                    FROM public.invoices i
                    LEFT JOIN public.trainer_profiles tp ON tp.id = i.trainer_id
                    WHERE i.pdf_url IS NOT NULL
                    ORDER BY i.invoice_number
                    """
                )
            else:
                cur.execute(
                    """
                    SELECT i.id, i.invoice_number, i.pdf_url, tp.user_id, i.academy_profile_id
                    FROM public.invoices i
                    LEFT JOIN public.trainer_profiles tp ON tp.id = i.trainer_id
                    WHERE i.pdf_url IS NOT NULL AND i.pdf_url::text LIKE %s
                    ORDER BY i.invoice_number
                    """,
                    (f"%{old_host}%",),
                )
            rows = cur.fetchall()
    finally:
        conn.close()

    print("=" * 60)
    print("INVOICE PDF_URL REGENERATION")
    print("=" * 60)
    print(f"Target: {TARGET_PROJECT_REF}")
    print(f"Rows to process: {len(rows):,}")
    print(f"Signed URL TTL: {args.expires_in:,}s")
    print()

    missing_file = 0
    no_path = 0
    plan: list[tuple[str, str, str]] = []  # id, path, old_url

    for inv_id, inv_num, pdf_url, user_id, academy_id in rows:
        path = invoice_storage_path(pdf_url, inv_num, user_id, academy_id)
        if not path:
            no_path += 1
            print(f"  SKIP {inv_num}: cannot derive storage path", file=sys.stderr)
            continue
        if not target_file_exists(tgt_key, "invoices", path):
            missing_file += 1
            print(f"  MISSING on target: {path} ({inv_num})", file=sys.stderr)
            continue
        plan.append((str(inv_id), path, pdf_url or ""))

    print(f"Can sign & update: {len(plan):,}")
    print(f"No path:           {no_path:,}")
    print(f"Missing on target: {missing_file:,}")

    if not plan:
        print("\nNothing to update.")
        return 1 if missing_file else 0

    if not args.execute:
        print("\nDry-run. Sample paths:")
        for inv_id, path, _ in plan[:10]:
            print(f"  {path}")
        if len(plan) > 10:
            print(f"  ... and {len(plan) - 10} more")
        print("\nTo apply:")
        print("  python3 scripts/migration/storage_regenerate_invoice_urls.py --execute --confirm")
        return 0

    if not args.confirm:
        print("ERROR: --execute requires --confirm", file=sys.stderr)
        return 1

    updated = failed = 0
    conn = psycopg2.connect(db_url)
    try:
        for i, (inv_id, path, _) in enumerate(plan, start=1):
            try:
                signed = create_signed_url(
                    tgt_key, "invoices", path, expires_in=args.expires_in
                )
                if TARGET_PROJECT_REF not in signed:
                    raise ValueError(f"signed URL missing target host: {signed[:80]}")
                with conn.cursor() as cur:
                    cur.execute(
                        "UPDATE public.invoices SET pdf_url = %s WHERE id = %s",
                        (signed, inv_id),
                    )
                updated += 1
            except Exception as e:
                failed += 1
                print(f"  FAIL {path}: {e}", file=sys.stderr)
            if i % 20 == 0 or i == len(plan):
                print(f"  [{i}/{len(plan)}] updated={updated} failed={failed}", flush=True)
            time.sleep(0.05)
        conn.commit()
        print(f"\nCommitted {updated:,} update(s), {failed:,} failed.")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    # Verify
    with psycopg2.connect(db_url) as conn2:
        with conn2.cursor() as cur:
            cur.execute(
                """
                SELECT COUNT(*) FROM public.invoices
                WHERE pdf_url IS NOT NULL AND pdf_url::text LIKE %s
                """,
                (f"%{old_host}%",),
            )
            (old_left,) = cur.fetchone()
            cur.execute(
                """
                SELECT COUNT(*) FROM public.invoices
                WHERE pdf_url IS NOT NULL AND pdf_url::text LIKE %s
                """,
                (f"%{TARGET_PROJECT_REF}%",),
            )
            (new_host,) = cur.fetchone()
    print(f"Remaining old-host pdf_url: {old_left:,}")
    print(f"pdf_url on target host:     {new_host:,}")
    return 1 if failed or old_left else 0


if __name__ == "__main__":
    sys.exit(main())
