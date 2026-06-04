#!/usr/bin/env python3
"""
Dry-run validator for Lovable migration_exports/ CSV files.

Does NOT connect to Supabase or import data.
Run from repo root:

  python3 scripts/migration/validate_exports.py
  python3 scripts/migration/validate_exports.py --exports-dir migration_exports
  python3 scripts/migration/validate_exports.py --strict

Optional target DB row-count check (read-only, no writes):

  DATABASE_URL="postgresql://..." python3 scripts/migration/validate_exports.py --check-target
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

# Views and non-table exports — never import
SKIP_TABLE_PATTERNS = re.compile(
    r"(_owner|_safe|_public|_mollie_status)$|^query-results$"
)

# Real tables in production with no CSV export (see plan)
MISSING_EXPORT_TABLES = frozenset(
    {
        "club_managers",
        "club_mollie_accounts",
        "club_players",
        "club_profile_views",
    }
)

# Columns that must exist in CSV header (NOT NULL in app / common schema)
REQUIRED_COLUMNS: dict[str, list[str]] = {
    "profiles": ["id", "user_id", "full_name", "email"],
    "trainer_profiles": ["id", "user_id"],
    "academy_profiles": ["id", "name", "slug", "country"],
    "club_profiles": ["id", "location_id"],
    "locations": ["id", "name", "city", "country", "slug"],
    "user_roles": ["id", "user_id", "role"],
    "bookings": ["id", "slot_id", "status"],
    "availability_slots": ["id", "trainer_id", "start_time", "end_time"],
    "cycles": ["id", "owner_type", "owner_id", "name"],
}

# Sensitive — warn if non-empty in export
SENSITIVE_COLUMNS = frozenset(
    {
        "access_token",
        "refresh_token",
        "token_expires_at",
    }
)

# Import phases (topological). auth.users is prerequisite, not in CSV.
IMPORT_PHASES: list[tuple[str, list[str]]] = [
    (
        "Phase 0 — Auth (separate export required)",
        ["auth.users", "auth.identities"],
    ),
    (
        "Phase 1 — Reference / lookup",
        [
            "rating_systems",
            "certifications",
            "specializations",
            "subscription_plans",
            "content_topics",
            "review_tags",
            "banner_placements",
            "onboarding_email_templates",
        ],
    ),
    (
        "Phase 2 — Geography",
        ["locations", "location_translations"],
    ),
    (
        "Phase 3 — Identity",
        ["profiles", "user_roles", "trainer_profiles", "trainer_onboarding"],
    ),
    (
        "Phase 4 — Organizations",
        [
            "club_profiles",
            "academy_profiles",
            "academy_managers",
            "academy_trainers",
            "academy_locations",
            "trainer_locations",
            "extra_cost_presets",
        ],
    ),
    (
        "Phase 5 — Mollie / payments config",
        [
            "trainer_mollie_accounts",
            "academy_mollie_accounts",
            # club_mollie_accounts — missing export
        ],
    ),
    (
        "Phase 6 — Catalog / content",
        ["articles", "slug_redirects", "internal_links"],
    ),
    (
        "Phase 7 — Scheduling core",
        ["cycles", "availability_slots", "guest_players", "bookings"],
    ),
    (
        "Phase 8 — Intake / proposals",
        [
            "intake_requests",
            "proposed_assignments",
            "player_links",
            "waiting_list_entries",
        ],
    ),
    (
        "Phase 9 — Money documents",
        ["invoices", "payment_audit_log", "subscription_payments"],
    ),
    (
        "Phase 10 — Engagement",
        [
            "reviews",
            "review_tag_selections",
            "session_reports",
            "slot_priority_claims",
            "trainer_followers",
            "academy_followers",
            "club_followers",
            "academy_profile_views",
            "trainer_profile_views",
            "notifications",
            "notification_preferences",
            "notification_queue",
            "onboarding_email_queue",
            "onboarding_email_logs",
        ],
    ),
    (
        "Phase 11 — Optional / admin / low priority",
        [
            "admin_impersonation_logs",
            "rate_limits",
            "mollie_oauth_states",
            "user_calendar_connections",
            "calendar_events",
            "user_discounts",
            "email_campaign_templates",
            "email_campaigns",
            "email_campaign_recipients",
            "player_rating_history",
            "player_locations",
            "profile_videos",
            "academy_player_tags",
            "academy_player_metadata",
            "academy_trainer_invitations",
            "club_trainer_invitations",
            "court_reviews",
            "challenge_suggestions",
            "location_requests",
            "partner_banners",
            "banner_placement_assignments",
            "banner_events",
            "club_tournaments",
            "dismissed_slot_warnings",
            "sources",
            "trainer_working_hours",
        ],
    ),
]

# FK checks: child_table -> [(child_col, parent_table, parent_col)]
FK_CHECKS: list[tuple[str, str, str, str]] = [
    ("profiles", "user_id", "auth.users", "id"),
    ("user_roles", "user_id", "auth.users", "id"),
    ("trainer_profiles", "user_id", "auth.users", "id"),
    ("trainer_onboarding", "user_id", "auth.users", "id"),
    ("club_profiles", "location_id", "locations", "id"),
    ("academy_locations", "academy_profile_id", "academy_profiles", "id"),
    ("academy_locations", "location_id", "locations", "id"),
    ("academy_managers", "academy_profile_id", "academy_profiles", "id"),
    ("academy_trainers", "academy_profile_id", "academy_profiles", "id"),
    ("academy_trainers", "trainer_profile_id", "trainer_profiles", "id"),
    ("trainer_locations", "trainer_id", "trainer_profiles", "id"),
    ("trainer_locations", "location_id", "locations", "id"),
    ("availability_slots", "trainer_id", "trainer_profiles", "id"),
    ("availability_slots", "location_id", "locations", "id"),
    ("bookings", "slot_id", "availability_slots", "id"),
    ("bookings", "player_id", "profiles", "id"),
    ("bookings", "guest_player_id", "guest_players", "id"),
    ("guest_players", "trainer_id", "trainer_profiles", "id"),
    ("guest_players", "linked_profile_id", "profiles", "id"),
    ("intake_requests", "cycle_id", "cycles", "id"),
    ("intake_requests", "player_id", "profiles", "id"),
    ("intake_requests", "location_id", "locations", "id"),
    ("proposed_assignments", "intake_request_id", "intake_requests", "id"),
    ("proposed_assignments", "slot_id", "availability_slots", "id"),
    ("proposed_assignments", "trainer_id", "trainer_profiles", "id"),
    ("invoices", "trainer_id", "trainer_profiles", "id"),
    ("invoices", "player_id", "profiles", "id"),
    ("invoices", "academy_profile_id", "academy_profiles", "id"),
    ("location_translations", "location_id", "locations", "id"),
    ("trainer_mollie_accounts", "trainer_id", "trainer_profiles", "id"),
    ("academy_mollie_accounts", "academy_profile_id", "academy_profiles", "id"),
    ("session_reports", "slot_id", "availability_slots", "id"),
    ("session_reports", "reporter_id", "profiles", "id"),
    ("slot_priority_claims", "slot_id", "availability_slots", "id"),
    ("slot_priority_claims", "player_id", "profiles", "id"),
    ("slot_priority_claims", "booking_id", "bookings", "id"),
    ("academy_followers", "academy_profile_id", "academy_profiles", "id"),
    ("academy_followers", "player_id", "profiles", "id"),
    ("trainer_followers", "trainer_id", "trainer_profiles", "id"),
    ("trainer_followers", "player_id", "profiles", "id"),
]


@dataclass
class TableExport:
    name: str
    path: Path
    columns: list[str]
    row_count: int
    duplicate_files: list[str] = field(default_factory=list)


@dataclass
class Finding:
    level: str  # ERROR | WARN | INFO
    message: str


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Validate migration CSV exports (dry run)")
    p.add_argument(
        "--exports-dir",
        type=Path,
        default=Path("migration_exports"),
        help="Directory containing *-export-*.csv files",
    )
    p.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors",
    )
    p.add_argument(
        "--check-target",
        action="store_true",
        help="Read-only: report row counts on target DB (requires DATABASE_URL)",
    )
    return p.parse_args()


def discover_exports(exports_dir: Path) -> dict[str, TableExport]:
    by_table: dict[str, list[Path]] = defaultdict(list)
    for path in sorted(exports_dir.glob("*-export-*.csv")):
        m = re.match(r"(.+)-export-", path.name)
        if not m:
            continue
        table = m.group(1)
        if SKIP_TABLE_PATTERNS.search(table):
            continue
        by_table[table].append(path)

    result: dict[str, TableExport] = {}
    for table, paths in by_table.items():
        paths = sorted(paths, key=lambda p: p.stat().st_size, reverse=True)
        primary = paths[0]
        columns, row_count = read_csv_meta(primary)
        result[table] = TableExport(
            name=table,
            path=primary,
            columns=columns,
            row_count=row_count,
            duplicate_files=[p.name for p in paths[1:]],
        )
    return result


def read_csv_meta(path: Path) -> tuple[list[str], int]:
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f, delimiter=";")
        try:
            header = next(reader)
        except StopIteration:
            return [], 0
        rows = sum(1 for _ in reader)
    return header, rows


def load_column_set(
    export: TableExport, column: str, *, nullable: bool = True
) -> set[str]:
    values: set[str] = set()
    with export.path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        if column not in (reader.fieldnames or []):
            return values
        for row in reader:
            v = (row.get(column) or "").strip()
            if v or not nullable:
                values.add(v)
    return values


def check_sensitive(export: TableExport) -> list[Finding]:
    findings: list[Finding] = []
    cols = set(export.columns)
    hit = cols & SENSITIVE_COLUMNS
    if not hit:
        return findings
    with export.path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            for c in hit:
                if (row.get(c) or "").strip():
                    findings.append(
                        Finding(
                            "WARN",
                            f"{export.name}: non-empty sensitive column '{c}' — "
                            "recommend excluding from import or re-auth after cutover",
                        )
                    )
                    return findings
    return findings


def check_old_storage_urls(exports_dir: Path, exports: dict[str, TableExport]) -> list[Finding]:
    findings: list[Finding] = []
    needle = "ppkbhdiiqdusdeatgdft.supabase.co"
    for ex in exports.values():
        chunk = ex.path.read_text(encoding="utf-8", errors="ignore")[:300_000]
        if needle in chunk:
            findings.append(
                Finding(
                    "WARN",
                    f"{ex.name}: contains old project storage URLs ({needle}) — "
                    "storage objects must be migrated separately; update URLs or remap buckets",
                )
            )
    return findings


def check_required_columns(exports: dict[str, TableExport]) -> list[Finding]:
    findings: list[Finding] = []
    for table, required in REQUIRED_COLUMNS.items():
        ex = exports.get(table)
        if not ex:
            findings.append(Finding("ERROR", f"Missing export for required table '{table}'"))
            continue
        missing = [c for c in required if c not in ex.columns]
        if missing:
            findings.append(
                Finding(
                    "ERROR",
                    f"{table}: CSV missing required columns {missing}",
                )
            )
    return findings


def check_fk(
    exports: dict[str, TableExport],
    auth_user_ids: set[str] | None,
) -> list[Finding]:
    findings: list[Finding] = []
    id_cache: dict[tuple[str, str], set[str]] = {}

    def parent_ids(table: str, col: str) -> set[str]:
        key = (table, col)
        if key not in id_cache:
            if table == "auth.users":
                id_cache[key] = auth_user_ids or set()
            else:
                ex = exports.get(table)
                id_cache[key] = load_column_set(ex, col) if ex else set()
        return id_cache[key]

    for child, child_col, parent, parent_col in FK_CHECKS:
        ex = exports.get(child)
        if not ex or ex.row_count == 0:
            continue
        if child_col not in ex.columns:
            findings.append(
                Finding("WARN", f"{child}: FK column '{child_col}' not in CSV — skip FK check")
            )
            continue
        parents = parent_ids(parent, parent_col)
        if parent == "auth.users" and not parents:
            findings.append(
                Finding(
                    "ERROR",
                    f"{child}.{child_col} → auth.users: no auth export loaded "
                    "(place auth.users.csv in exports dir or use --auth-users)",
                )
            )
            continue
        bad = 0
        samples: list[str] = []
        with ex.path.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                v = (row.get(child_col) or "").strip()
                if not v:
                    continue
                if v not in parents:
                    bad += 1
                    if len(samples) < 3:
                        samples.append(v)
        if bad:
            findings.append(
                Finding(
                    "ERROR",
                    f"{child}.{child_col} → {parent}.{parent_col}: {bad} orphan(s)"
                    + (f" e.g. {samples}" if samples else ""),
                )
            )
    return findings


def load_auth_user_ids(exports_dir: Path) -> set[str] | None:
    candidates = [
        exports_dir / "auth.users.csv",
        exports_dir / "auth_users.csv",
        exports_dir / "auth-users-export.csv",
    ]
    for path in candidates:
        if not path.exists():
            continue
        ids: set[str] = set()
        with path.open(encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f, delimiter=";" if ";" in path.read_text()[:200] else ",")
            col = "id" if "id" in (reader.fieldnames or []) else "user_id"
            for row in reader:
                v = (row.get(col) or "").strip()
                if v:
                    ids.add(v)
        return ids
    # Infer from profiles as fallback (validation only — import still needs real auth.users)
    profiles = exports_dir.glob("profiles-export-*.csv")
    paths = list(profiles)
    if not paths:
        return None
    path = max(paths, key=lambda p: p.stat().st_size)
    ids = set()
    with path.open(encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            v = (row.get("user_id") or "").strip()
            if v:
                ids.add(v)
    return ids


def check_target_db(exports: dict[str, TableExport]) -> list[Finding]:
    import os

    url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not url:
        return [
            Finding(
                "WARN",
                "--check-target set but DATABASE_URL not defined",
            )
        ]
    try:
        import psycopg2  # type: ignore
    except ImportError:
        return [
            Finding(
                "WARN",
                "--check-target requires psycopg2 (pip install psycopg2-binary)",
            )
        ]
    findings: list[Finding] = []
    conn = psycopg2.connect(url)
    try:
        with conn.cursor() as cur:
            for table in sorted(exports.keys())[:20]:
                try:
                    cur.execute(f"SELECT COUNT(*) FROM public.{table}")  # noqa: S608
                    (count,) = cur.fetchone()
                    if count and count > 0:
                        findings.append(
                            Finding(
                                "WARN",
                                f"Target public.{table} already has {count} rows — "
                                "import plan requires explicit approval before overwrite/upsert",
                            )
                        )
                except Exception as e:
                    conn.rollback()
                    findings.append(
                        Finding("INFO", f"Target public.{table}: not queryable ({e})")
                    )
    finally:
        conn.close()
    return findings


def main() -> int:
    args = parse_args()
    exports_dir: Path = args.exports_dir
    if not exports_dir.is_dir():
        print(f"ERROR: exports dir not found: {exports_dir}", file=sys.stderr)
        return 1

    exports = discover_exports(exports_dir)
    findings: list[Finding] = []

    findings.append(
        Finding("INFO", f"Discovered {len(exports)} base-table export(s) in {exports_dir}")
    )

    for table in MISSING_EXPORT_TABLES:
        findings.append(
            Finding(
                "WARN",
                f"No CSV export for public.{table} — target will be empty unless exported separately",
            )
        )

    if not (exports_dir / "auth.users.csv").exists() and not (
        exports_dir / "auth_users.csv"
    ).exists():
        findings.append(
            Finding(
                "ERROR",
                "auth.users export missing — required before profiles/user_roles. "
                "Export from Supabase Auth (Dashboard or pg_dump auth schema). "
                "Dry-run uses profiles.user_id as FK proxy only.",
            )
        )

    for ex in exports.values():
        if ex.duplicate_files:
            findings.append(
                Finding(
                    "WARN",
                    f"{ex.name}: duplicate export files; using {ex.path.name}, "
                    f"ignoring {ex.duplicate_files}",
                )
            )
        if ex.row_count == 0:
            findings.append(Finding("INFO", f"{ex.name}: empty export (0 rows)"))

    auth_ids = load_auth_user_ids(exports_dir)
    if auth_ids:
        profiles_ex = exports.get("profiles")
        if profiles_ex:
            profile_users = load_column_set(profiles_ex, "user_id")
            orphan_profiles = profile_users - auth_ids
            if orphan_profiles and (exports_dir / "auth.users.csv").exists():
                findings.append(
                    Finding(
                        "ERROR",
                        f"profiles.user_id: {len(orphan_profiles)} not in auth.users export",
                    )
                )

    findings.extend(check_required_columns(exports))
    for ex in exports.values():
        findings.extend(check_sensitive(ex))
    findings.extend(check_old_storage_urls(exports_dir, exports))
    findings.extend(check_fk(exports, auth_ids))

    if args.check_target:
        findings.extend(check_target_db(exports))

    # Summary stats
    if exports.get("profiles") and exports.get("academy_profiles"):
        p = exports["profiles"].row_count
        a = exports["academy_profiles"].row_count
        findings.append(Finding("INFO", f"profiles rows: {p}; academy_profiles rows: {a}"))

    print("\n=== IMPORT PHASE ORDER (reference) ===\n")
    for title, tables in IMPORT_PHASES:
        print(title)
        for t in tables:
            ex = exports.get(t)
            suffix = f" ({ex.row_count} rows)" if ex else " (no CSV)"
            print(f"  - {t}{suffix}")
        print()

    print("=== VALIDATION RESULTS ===\n")
    counts = defaultdict(int)
    for f in findings:
        counts[f.level] += 1
        print(f"[{f.level}] {f.message}")

    print(
        f"\nSummary: {counts['ERROR']} error(s), {counts['WARN']} warning(s), {counts['INFO']} info\n"
    )

    if counts["ERROR"]:
        return 1
    if args.strict and counts["WARN"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
