#!/usr/bin/env python3
"""
Read-only verification: auth.users on target vs profiles.user_id in CSV exports.

Does not modify any data.

  export SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export SUPABASE_SERVICE_ROLE_KEY="..."
  python3 scripts/migration/auth_verify_pre_public_import.py
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth_common import TARGET_PROJECT_REF, assert_target_project_url, load_profile_auth_rows
from auth_import_dry_run import fetch_target_auth_users


def unique_export_user_ids(rows) -> set[str]:
    return {r.user_id for r in rows if r.user_id}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify auth.users vs profiles export before public import"
    )
    parser.add_argument(
        "--exports-dir",
        type=Path,
        default=Path("migration_exports"),
    )
    args = parser.parse_args()

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        print(
            "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required",
            file=sys.stderr,
        )
        return 1

    try:
        assert_target_project_url(url)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    rows = load_profile_auth_rows(args.exports_dir)
    export_ids = unique_export_user_ids(rows)

    target = fetch_target_auth_users(url, key)
    auth_ids = set(target["by_id"].keys())

    missing_in_auth = sorted(export_ids - auth_ids)
    extra_in_auth = sorted(auth_ids - export_ids)

    print(f"Target project: {TARGET_PROJECT_REF}")
    print(f"auth.users count:              {len(auth_ids)}")
    print(f"Unique profiles.user_id count: {len(export_ids)}")

    if missing_in_auth:
        print(f"\nIn exports but missing from auth.users ({len(missing_in_auth)}):")
        for uid in missing_in_auth:
            print(f"  {uid}")

    if extra_in_auth:
        print(f"\nIn auth.users but not in profiles export ({len(extra_in_auth)}):")
        for uid in extra_in_auth:
            print(f"  {uid}")

    if not missing_in_auth and not extra_in_auth:
        print("Match: all export user_ids exist in auth.users; no extra auth users.")

    return 0 if not missing_in_auth and not extra_in_auth else 1


if __name__ == "__main__":
    sys.exit(main())
