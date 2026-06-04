#!/usr/bin/env python3
"""
Fallback: invoke target generate-invoice edge function per invoice.

Regenerates PDF on target storage and updates pdf_url (no source bucket copy).
Use when SOURCE_SERVICE_ROLE_KEY for old project is unavailable.

  export TARGET_SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export TARGET_SERVICE_ROLE_KEY="..."
  export MIGRATION_INVOICE_SECRET="..."  # must match ficwb edge secret

  python3 scripts/migration/storage_regenerate_invoices_via_edge.py --execute --confirm
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from storage_common import SOURCE_PROJECT_REF, TARGET_PROJECT_REF, project_url_env


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        return 1

    tgt_url, tgt_key, _ = project_url_env("TARGET")
    if not tgt_url or not tgt_key:
        print("ERROR: TARGET_* required", file=sys.stderr)
        return 1

    migration_secret = os.environ.get("MIGRATION_INVOICE_SECRET", "").strip()
    if args.execute and not migration_secret:
        print(
            "ERROR: MIGRATION_INVOICE_SECRET required (set on ficwb + export locally)",
            file=sys.stderr,
        )
        return 1

    import psycopg2  # type: ignore

    from import_common import assert_target_database_url

    assert_target_database_url(db_url)

    old_host = f"{SOURCE_PROJECT_REF}.supabase.co"
    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, invoice_number FROM public.invoices
                WHERE pdf_url IS NOT NULL AND pdf_url::text LIKE %s
                AND status IS DISTINCT FROM 'draft'
                ORDER BY invoice_number
                """
                + (" LIMIT %s" if args.limit else ""),
                (f"%{old_host}%", *([args.limit] if args.limit else ())),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    print(f"Invoices to regenerate via edge: {len(rows):,}")
    if not args.execute:
        print("Dry-run. To run:")
        print("  export MIGRATION_INVOICE_SECRET='...'  # same as ficwb function secret")
        print("  python3 scripts/migration/storage_regenerate_invoices_via_edge.py --execute --confirm")
        return 0
    if not args.confirm:
        print("ERROR: --execute requires --confirm", file=sys.stderr)
        return 1

    api = tgt_url.rstrip("/") + "/functions/v1/generate-invoice"
    ok = fail = 0
    for i, (inv_id, inv_num) in enumerate(rows, start=1):
        body = json.dumps({"invoiceId": inv_id}).encode()
        headers = {
            "Authorization": f"Bearer {tgt_key}",
            "apikey": tgt_key,
            "Content-Type": "application/json",
            "X-Migration-Secret": migration_secret,
        }
        req = urllib.request.Request(api, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                out = json.loads(resp.read().decode())
            if out.get("pdfUrl") or out.get("success"):
                ok += 1
            else:
                fail += 1
                print(f"  FAIL {inv_num}: {out}", file=sys.stderr)
        except Exception as e:
            fail += 1
            print(f"  FAIL {inv_num}: {e}", file=sys.stderr)
        if i % 10 == 0 or i == len(rows):
            print(f"  [{i}/{len(rows)}] ok={ok} fail={fail}", flush=True)
        time.sleep(0.5)

    print(f"\nDone: ok={ok} fail={fail}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
