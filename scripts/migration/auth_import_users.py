#!/usr/bin/env python3
"""
Create auth.users on the NEW Supabase project from profiles CSV.

Uses Supabase Auth Admin API (service role). Does NOT send emails.
Preserves auth.users.id = profiles.user_id. Sets random temporary passwords.

DEFAULT: dry-run only (no API writes).

To create users after explicit approval:

  export SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export SUPABASE_SERVICE_ROLE_KEY="<service_role_secret>"

  python3 scripts/migration/auth_import_users.py --execute --confirm

Credentials are written to migration_exports/.auth_import_credentials.json
(gitignored). Distribute via password reset flow; do not commit that file.

Do NOT import public.profiles until auth users exist.
"""

from __future__ import annotations

import argparse
import json
import secrets
import string
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth_common import (
    TARGET_PROJECT_REF,
    ProfileAuthRow,
    analyze_profiles,
    assert_target_project_url,
    get_creatable_users,
    load_profile_auth_rows,
)

CREDENTIALS_PATH = Path("migration_exports/.auth_import_credentials.json")
PASSWORD_ALPHABET = string.ascii_letters + string.digits + "!@#$%^&*"


def generate_password(length: int = 24) -> str:
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(length))


def admin_create_user(
    supabase_url: str,
    service_role_key: str,
    row: ProfileAuthRow,
    password: str,
) -> dict:
    assert_target_project_url(supabase_url)
    url = supabase_url.rstrip("/") + "/auth/v1/admin/users"
    body = {
        "id": row.user_id,
        "email": row.email,
        "password": password,
        "email_confirm": True,
        "user_metadata": {
            "full_name": row.full_name,
            "preferred_language": row.preferred_language,
            "migrated_from": "lovable_profiles_export",
        },
    }
    data = json.dumps(body).encode("utf-8")
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {err_body}") from e


def admin_get_user_by_id(supabase_url: str, service_role_key: str, user_id: str) -> dict | None:
    assert_target_project_url(supabase_url)
    url = supabase_url.rstrip("/") + f"/auth/v1/admin/users/{user_id}"
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def run_dry_run_summary(report, creatable: list) -> None:
    print(f"Target project:     {TARGET_PROJECT_REF}")
    print(f"Mode:               DRY-RUN (no users created)")
    print(f"Profile rows:       {report.profile_rows}")
    print(f"Unique user_ids:    {report.unique_user_ids}")
    print(f"Would create:       {len(creatable)}")
    print(f"Blocked:            {len(report.blocked)}")
    if report.blocked:
        print("\nBlocked users:")
        for b in report.blocked:
            print(
                f"  - {b['reason']}: user_id={b.get('user_id')} email={b.get('email')}"
            )


def run_execute(
    supabase_url: str,
    service_role_key: str,
    creatable: list[ProfileAuthRow],
    *,
    delay_ms: int,
) -> int:
    created: list[dict] = []
    skipped: list[dict] = []
    failed: list[dict] = []

    for i, row in enumerate(creatable, start=1):
        existing = admin_get_user_by_id(supabase_url, service_role_key, row.user_id)
        if existing:
            skipped.append(
                {
                    "user_id": row.user_id,
                    "email": row.email,
                    "reason": "auth_user_id_already_exists",
                }
            )
            print(f"[{i}/{len(creatable)}] SKIP id exists {row.user_id} {row.email}")
            continue

        password = generate_password()
        try:
            admin_create_user(supabase_url, service_role_key, row, password)
            created.append(
                {
                    "user_id": row.user_id,
                    "email": row.email,
                    "temporary_password": password,
                    "profile_id": row.profile_id,
                }
            )
            print(f"[{i}/{len(creatable)}] OK {row.user_id} {row.email}")
        except RuntimeError as e:
            failed.append(
                {
                    "user_id": row.user_id,
                    "email": row.email,
                    "error": str(e),
                }
            )
            print(f"[{i}/{len(creatable)}] FAIL {row.email}: {e}", file=sys.stderr)

        if delay_ms > 0:
            time.sleep(delay_ms / 1000.0)

    CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    summary = {
        "target_project_ref": TARGET_PROJECT_REF,
        "created_count": len(created),
        "skipped_count": len(skipped),
        "failed_count": len(failed),
        "created": created,
        "skipped": skipped,
        "failed": failed,
        "note": "Users must reset password at login. OAuth identities are NOT migrated.",
    }
    CREDENTIALS_PATH.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    print("\n--- Import finished ---")
    print(f"Created: {len(created)}")
    print(f"Skipped: {len(skipped)}")
    print(f"Failed:  {len(failed)}")
    print(f"Credentials file: {CREDENTIALS_PATH} (gitignored — do not commit)")
    return 0 if not failed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Import auth.users from profiles export")
    parser.add_argument("--exports-dir", type=Path, default=Path("migration_exports"))
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually call Admin API (default is dry-run)",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required with --execute to prevent accidental runs",
    )
    parser.add_argument(
        "--delay-ms",
        type=int,
        default=150,
        help="Delay between create calls when executing (default 150ms)",
    )
    args = parser.parse_args()

    rows = load_profile_auth_rows(args.exports_dir)
    report = analyze_profiles(rows)
    creatable = get_creatable_users(rows, report)

    if not args.execute:
        run_dry_run_summary(report, creatable)
        print("\nNo users were created. To run for real:")
        print(
            f"  SUPABASE_URL=https://{TARGET_PROJECT_REF}.supabase.co \\"
        )
        print(
            "  SUPABASE_SERVICE_ROLE_KEY=... \\"
        )
        print(
            "  python3 scripts/migration/auth_import_users.py --execute --confirm"
        )
        return 0 if creatable else 1

    if not args.confirm:
        print("ERROR: --execute requires --confirm", file=sys.stderr)
        return 1

    import os

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        print(
            "ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required for --execute",
            file=sys.stderr,
        )
        return 1

    try:
        assert_target_project_url(url)
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print(f"Target project: {TARGET_PROJECT_REF}")
    print(f"Mode: EXECUTE — creating {len(creatable)} auth user(s)")
    print("Emails will NOT be sent (Admin API create, not invite).")
    return run_execute(url, key, creatable, delay_ms=args.delay_ms)


if __name__ == "__main__":
    sys.exit(main())
