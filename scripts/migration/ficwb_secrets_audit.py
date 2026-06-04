#!/usr/bin/env python3
"""
List ficwb Edge Function secret NAMES (exist/missing audit). Never prints values.

Requires Supabase personal access token (sbp_...):
  export SUPABASE_ACCESS_TOKEN="sbp_..."
  python3 scripts/migration/ficwb_secrets_audit.py

Optional: compare only secrets required by deployed functions (default).
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_REF = "ficwbdrzefmblkbkomzw"
FUNCTIONS_DIR = Path(__file__).resolve().parents[2] / "supabase" / "functions"

AUTO_SECRETS = {
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_URL",
}

CATEGORIES: dict[str, list[str]] = {
    "Resend": ["RESEND_API_KEY"],
    "Mollie": ["MOLLIE_API_KEY", "MOLLIE_CLIENT_ID", "MOLLIE_CLIENT_SECRET"],
    "Stripe": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
    "Google Calendar": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    "Reditus": ["REDITUS_PRODUCT_ID", "REDITUS_PRODUCT_SECRET", "REDITUS_WEBHOOK_SECRET"],
    "Lovable AI": ["LOVABLE_API_KEY"],
    "Firecrawl": ["FIRECRAWL_API_KEY"],
    "Slack": ["SLACK_WEBHOOK_URL"],
    "Public app URLs": ["PUBLIC_APP_URL", "APP_URL"],
    "Migration invoice secret": ["MIGRATION_INVOICE_SECRET"],
}

IMPACT: dict[str, str] = {
    "RESEND_API_KEY": "Critical",
    "MOLLIE_API_KEY": "Critical",
    "MOLLIE_CLIENT_ID": "Critical",
    "MOLLIE_CLIENT_SECRET": "Critical",
    "STRIPE_SECRET_KEY": "High",
    "STRIPE_WEBHOOK_SECRET": "Medium",
    "GOOGLE_CLIENT_ID": "High",
    "GOOGLE_CLIENT_SECRET": "High",
    "REDITUS_PRODUCT_ID": "Low",
    "REDITUS_PRODUCT_SECRET": "Low",
    "REDITUS_WEBHOOK_SECRET": "Low",
    "LOVABLE_API_KEY": "Medium",
    "FIRECRAWL_API_KEY": "Medium",
    "SLACK_WEBHOOK_URL": "Low",
    "PUBLIC_APP_URL": "High",
    "APP_URL": "High",
    "MIGRATION_INVOICE_SECRET": "Medium",
}


def fetch_deployed_slugs() -> list[str]:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token.startswith("sbp_"):
        return []

    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/functions"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"WARN: could not list functions via API ({e.code})", file=sys.stderr)
        return []

    return sorted({item.get("slug") or item.get("name") for item in data if item})


def list_remote_secret_names() -> set[str]:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token.startswith("sbp_"):
        raise SystemExit(
            "ERROR: Set SUPABASE_ACCESS_TOKEN to a valid personal access token (sbp_...).\n"
            "Create at: https://supabase.com/dashboard/account/tokens"
        )

    url = f"https://api.supabase.com/v1/projects/{PROJECT_REF}/secrets"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())

    names: set[str] = set()
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                names.add(item)
            elif isinstance(item, dict) and item.get("name"):
                names.add(item["name"])
    return names


def secrets_for_deployed_functions(deployed: set[str]) -> set[str]:
    pat = re.compile(r'Deno\.env\.get\(["\']([A-Z0-9_]+)["\']\)')
    needed: set[str] = set()
    for slug in deployed:
        idx = FUNCTIONS_DIR / slug / "index.ts"
        if not idx.exists():
            continue
        for key in pat.findall(idx.read_text()):
            if key not in AUTO_SECRETS:
                needed.add(key)
    return needed


def main() -> None:
    remote = list_remote_secret_names()

    deployed_arg = os.environ.get("DEPLOYED_SLUGS_FILE")
    if deployed_arg:
        deployed = {line.strip() for line in Path(deployed_arg).read_text().splitlines() if line.strip()}
    else:
        deployed = set(fetch_deployed_slugs())
        if not deployed:
            # Fallback: slugs from last CLI list in repo doc / hardcoded snapshot
            deployed = {
                "admin-reset-password", "auto-create-invoice", "bulk-cleanup-users",
                "bulk-update-vat", "cancel-stripe-subscription", "check-mollie-connect-status",
                "check-stripe-subscription", "create-academy-trainer", "create-admin-trainer",
                "create-club-trainer", "create-invoice-payment", "create-manual-player",
                "create-mollie-payment", "create-stripe-checkout", "customer-portal",
                "delete-user", "enrich-clubs", "fetch-location-logos", "finalize-proposals",
                "forward-invoice", "generate-blog-article", "generate-blog-cover",
                "generate-invoice", "generate-proposals", "get-admin-stats",
                "get-booking-invoice", "get-public-invoice", "get-public-rating",
                "google-calendar-auth", "health-check", "impersonate-user",
                "import-pipeline-data", "llms-full-txt", "mollie-callback",
                "mollie-connect-academy", "mollie-connect-trainer", "mollie-webhook",
                "notify-followers", "reditus-referral-token", "render-page",
                "request-account-deletion", "scrape-academies", "send-auth-email",
                "send-campaign-emails", "send-email", "send-invoice-email",
                "send-priority-claim-invitation", "send-schedule-notifications",
                "signup-user", "sitemap", "slack-notify", "split-invoice",
                "submit-guest-intake", "sync-calendar-event", "sync-invoice-to-bookings",
                "toggle-player-role", "translate-blog-article", "trigger-welcome-emails",
                "update-public-invoice-details", "update-user", "verify-mollie-payment",
            }

    needed_by_code = secrets_for_deployed_functions(deployed)
    audit_keys = {k for keys in CATEGORIES.values() for k in keys}

    print(f"project={PROJECT_REF}")
    print(f"deployed_functions={len(deployed)}")
    print(f"remote_secret_count={len(remote)}")
    print()

    for category, keys in CATEGORIES.items():
        print(f"## {category}")
        for key in keys:
            on_project = key in remote
            used = key in needed_by_code
            status = "exists" if on_project else "missing"
            deploy_note = " (used by deployed functions)" if used else " (not required by current deploy set)"
            print(f"  {key}: {status}{deploy_note}")
        print()

    missing = [k for k in sorted(audit_keys) if k not in remote]
    missing_used = [k for k in missing if k in needed_by_code]

    print("## By impact (missing only, used by deployed functions)")
    for level in ("Critical", "High", "Medium", "Low"):
        items = [k for k in missing_used if IMPACT.get(k) == level]
        if items:
            print(f"### {level}")
            for k in items:
                print(f"  - {k}")

    print()
    print("## Copy immediately (missing + Critical/High + deployed)")
    immediate = [
        k for k in missing_used
        if IMPACT.get(k) in ("Critical", "High")
    ]
    for k in immediate:
        print(f"  - {k}")


if __name__ == "__main__":
    main()
