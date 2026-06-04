#!/usr/bin/env python3
"""
Dry-run report for auth user creation from profiles.user_id + profiles.email.

Does NOT create users. Safe to run anytime.

  cd padeltrainer
  python3 scripts/migration/auth_import_dry_run.py

Optional: compare against existing users on target (read-only Admin API):

  export SUPABASE_URL="https://ficwbdrzefmblkbkomzw.supabase.co"
  export SUPABASE_SERVICE_ROLE_KEY="..."
  python3 scripts/migration/auth_import_dry_run.py --check-target
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth_common import (
    TARGET_PROJECT_REF,
    analyze_profiles,
    assert_target_project_url,
    get_creatable_users,
    load_profile_auth_rows,
)


def fetch_target_auth_users(supabase_url: str, service_role_key: str) -> dict[str, dict]:
    """Return maps: by_id, by_email from GoTrue admin list (paginated)."""
    import urllib.error
    import urllib.request

    assert_target_project_url(supabase_url)
    base = supabase_url.rstrip("/") + "/auth/v1/admin/users"
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }

    by_id: dict[str, dict] = {}
    by_email: dict[str, dict] = {}
    page = 1
    per_page = 200

    while True:
        url = f"{base}?page={page}&per_page={per_page}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            raise RuntimeError(f"Admin list users failed ({e.code}): {body}") from e

        users = payload.get("users") or []
        if not users:
            break
        for u in users:
            uid = u.get("id")
            email = (u.get("email") or "").lower()
            if uid:
                by_id[uid] = u
            if email:
                by_email[email] = u
        if len(users) < per_page:
            break
        page += 1

    return {"by_id": by_id, "by_email": by_email}


def main() -> int:
    parser = argparse.ArgumentParser(description="Auth import dry-run from profiles CSV")
    parser.add_argument(
        "--exports-dir",
        type=Path,
        default=Path("migration_exports"),
    )
    parser.add_argument(
        "--check-target",
        action="store_true",
        help="List existing auth.users on target project (read-only)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print machine-readable JSON report",
    )
    args = parser.parse_args()

    rows = load_profile_auth_rows(args.exports_dir)
    report = analyze_profiles(rows)
    out = report.to_dict()

    print(f"Target project (for import): {TARGET_PROJECT_REF}")
    print(f"Profiles export rows:        {report.profile_rows}")
    print(f"Unique user_ids:             {report.unique_user_ids}")
    print(f"Creatable auth users:        {report.creatable_users}")
    print(f"Blocked / cannot create:     {len(report.blocked)}")
    print()
    print(f"  Missing user_id:   {len(report.missing_user_id)}")
    print(f"  Missing email:     {len(report.missing_email)}")
    print(f"  Invalid email:     {len(report.invalid_email)}")
    print(f"  Invalid user_id:   {len(report.invalid_user_id)}")
    print(f"  Duplicate user_id: {len(report.duplicate_user_id)}")
    print(f"  Duplicate email:   {len(report.duplicate_email)}")

    if report.duplicate_email:
        print("\nDuplicate emails (same email, different user_id):")
        for em, uids in sorted(report.duplicate_email.items()):
            print(f"  {em} -> {uids}")

    if report.blocked:
        print("\nUsers that cannot be created from CSV alone:")
        for b in report.blocked[:20]:
            print(
                f"  [{b['reason']}] user_id={b.get('user_id')} email={b.get('email')} line={b.get('line')}"
            )
        if len(report.blocked) > 20:
            print(f"  ... and {len(report.blocked) - 20} more")

    if args.check_target:
        import os

        url = os.environ.get("SUPABASE_URL", "").strip()
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            print(
                "\nERROR: --check-target requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
                file=sys.stderr,
            )
            return 1
        target = fetch_target_auth_users(url, key)
        by_id = target["by_id"]
        by_email = target["by_email"]
        would_skip_id = would_skip_email = would_create = 0
        target_conflicts: list[dict] = []

        creatable_rows = get_creatable_users(rows, report)
        for r in creatable_rows:
            if r.user_id in by_id:
                would_skip_id += 1
                continue
            if r.email in by_email:
                existing = by_email[r.email]
                target_conflicts.append(
                    {
                        "reason": "email_taken_on_target",
                        "user_id": r.user_id,
                        "email": r.email,
                        "existing_auth_id": existing.get("id"),
                    }
                )
                would_skip_email += 1
                continue
            would_create += 1

        print("\n--- Target project check (read-only) ---")
        print(f"Existing auth.users on target: {len(by_id)}")
        print(f"Would create:                  {would_create}")
        print(f"Would skip (id exists):        {would_skip_id}")
        print(f"Would block (email taken):     {would_skip_email}")
        out["target_check"] = {
            "existing_auth_users": len(by_id),
            "would_create": would_create,
            "would_skip_id_exists": would_skip_id,
            "would_block_email_taken": would_skip_email,
            "conflicts": target_conflicts,
        }
        if target_conflicts:
            print("\nEmail conflicts on target (different auth id already):")
            for c in target_conflicts[:15]:
                print(
                    f"  {c['email']}: import user_id={c['user_id']} "
                    f"but target has {c['existing_auth_id']}"
                )

    if args.json:
        print("\n" + json.dumps(out, indent=2))

    if report.creatable_users == 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
