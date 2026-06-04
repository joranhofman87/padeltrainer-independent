#!/usr/bin/env python3
"""Read-only ficwb audit for Lisa Test accounts via `supabase db query --linked`."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

EMAILS = [
    "lisa-test-player@test.com",
    "lisa-test-trainer@test.com",
    "lisa-test-admin@test.com",
    "lisa-test-club@test.com",
    "lisa-test-academy@test.com",
]

ROOT = Path(__file__).resolve().parents[2]


def run_sql(sql: str) -> list[dict]:
    proc = subprocess.run(
        ["npx", "supabase", "db", "query", "--linked", "-o", "json", sql],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout or "query failed")
    # CLI may prefix npm warnings; find JSON object
    text = proc.stdout.strip()
    start = text.find("{")
    if start < 0:
        raise RuntimeError(f"No JSON in output: {text[:500]}")
    payload = json.loads(text[start:])
    return payload.get("rows") or []


def main() -> int:
    email_list = ", ".join(f"'{e}'" for e in EMAILS)

    users = run_sql(
        f"SELECT id::text AS user_id, email FROM auth.users WHERE email IN ({email_list}) ORDER BY email"
    )
    if len(users) != 5:
        print(f"WARNING: expected 5 users, found {len(users)}", file=sys.stderr)

    user_ids = [u["user_id"] for u in users]
    uid_array = ", ".join(f"'{u}'::uuid" for u in user_ids)

    entities = run_sql(
        f"""
        WITH u AS (SELECT id, email FROM auth.users WHERE email IN ({email_list}))
        SELECT 'trainer_profiles' AS kind, tp.id::text AS entity_id, u.email
        FROM trainer_profiles tp JOIN u ON tp.user_id = u.id
        UNION ALL
        SELECT 'academy_profiles', ap.id::text, u.email FROM academy_profiles ap JOIN u ON ap.created_by = u.id
        UNION ALL
        SELECT 'club_profiles', cp.id::text, u.email FROM club_profiles cp JOIN u ON cp.created_by = u.id
        UNION ALL
        SELECT 'profiles', p.id::text, u.email FROM profiles p JOIN u ON p.user_id = u.id
        ORDER BY kind, email
        """
    )

    trainer_ids = [e["entity_id"] for e in entities if e["kind"] == "trainer_profiles"]
    academy_ids = [e["entity_id"] for e in entities if e["kind"] == "academy_profiles"]
    club_ids = [e["entity_id"] for e in entities if e["kind"] == "club_profiles"]
    profile_ids = [e["entity_id"] for e in entities if e["kind"] == "profiles"]

    def arr(ids: list[str]) -> str:
        return ", ".join(f"'{i}'::uuid" for i in ids) if ids else "NULL"

    counts_sql = f"""
    WITH u AS (SELECT unnest(ARRAY[{uid_array}]) AS user_id),
         tp AS (SELECT unnest(ARRAY[{arr(trainer_ids)}]) AS id),
         ap AS (SELECT unnest(ARRAY[{arr(academy_ids)}]) AS id),
         cp AS (SELECT unnest(ARRAY[{arr(club_ids)}]) AS id),
         pr AS (SELECT unnest(ARRAY[{arr(profile_ids)}]) AS id)
    SELECT * FROM (
      SELECT 'auth.users' AS tbl, COUNT(*)::bigint AS n FROM auth.users WHERE id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'profiles', COUNT(*) FROM profiles WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'user_roles', COUNT(*) FROM user_roles WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'trainer_profiles', COUNT(*) FROM trainer_profiles WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'trainer_onboarding', COUNT(*) FROM trainer_onboarding WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'academy_profiles', COUNT(*) FROM academy_profiles WHERE created_by IN (SELECT user_id FROM u)
      UNION ALL SELECT 'academy_managers', COUNT(*) FROM academy_managers WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'club_profiles', COUNT(*) FROM club_profiles WHERE created_by IN (SELECT user_id FROM u)
      UNION ALL SELECT 'club_managers', COUNT(*) FROM club_managers WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'onboarding_email_queue', COUNT(*) FROM onboarding_email_queue WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'onboarding_email_logs', COUNT(*) FROM onboarding_email_logs WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'notification_preferences', COUNT(*) FROM notification_preferences WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'notifications', COUNT(*) FROM notifications WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'notification_queue', COUNT(*) FROM notification_queue WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'banner_events', COUNT(*) FROM banner_events WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'calendar_events', COUNT(*) FROM calendar_events WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'mollie_oauth_states', COUNT(*) FROM mollie_oauth_states WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'admin_impersonation_logs (admin)', COUNT(*) FROM admin_impersonation_logs WHERE admin_user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'admin_impersonation_logs (target)', COUNT(*) FROM admin_impersonation_logs WHERE target_user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'court_reviews', COUNT(*) FROM court_reviews WHERE user_id IN (SELECT user_id FROM u)
      UNION ALL SELECT 'bookings (player profile)', COUNT(*) FROM bookings WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'invoices (player profile)', COUNT(*) FROM invoices WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'reviews (player profile)', COUNT(*) FROM reviews WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'intake_requests', COUNT(*) FROM intake_requests WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'trainer_followers', COUNT(*) FROM trainer_followers WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'club_followers', COUNT(*) FROM club_followers WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'academy_followers', COUNT(*) FROM academy_followers WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'slot_priority_claims', COUNT(*) FROM slot_priority_claims WHERE player_id IN (SELECT id FROM pr)
      UNION ALL SELECT 'availability_slots', COUNT(*) FROM availability_slots WHERE trainer_id IN (SELECT id FROM tp)
      UNION ALL SELECT 'reviews (trainer)', COUNT(*) FROM reviews WHERE trainer_id IN (SELECT id FROM tp)
      UNION ALL SELECT 'invoices (trainer_id)', COUNT(*) FROM invoices WHERE trainer_id IN (SELECT id FROM tp)
      UNION ALL SELECT 'bookings (trainer slots)', COUNT(*) FROM bookings b
        JOIN availability_slots s ON b.slot_id = s.id WHERE s.trainer_id IN (SELECT id FROM tp)
      UNION ALL SELECT 'payment_audit_log (invoice link)', COUNT(*) FROM payment_audit_log pal
        WHERE pal.invoice_id IN (SELECT id FROM invoices WHERE player_id IN (SELECT id FROM pr)
          OR trainer_id IN (SELECT id FROM tp))
      UNION ALL SELECT 'payment_audit_log (booking link)', COUNT(*) FROM payment_audit_log pal
        WHERE pal.booking_id IN (SELECT b.id FROM bookings b WHERE b.player_id IN (SELECT id FROM pr)
          OR b.slot_id IN (SELECT s.id FROM availability_slots s WHERE s.trainer_id IN (SELECT id FROM tp)))
      UNION ALL SELECT 'subscription_payments (trainer)', COUNT(*) FROM subscription_payments
        WHERE profile_type = 'trainer' AND profile_id IN (SELECT id FROM tp)
      UNION ALL SELECT 'subscription_payments (academy)', COUNT(*) FROM subscription_payments
        WHERE profile_type = 'academy' AND profile_id IN (SELECT id FROM ap)
      UNION ALL SELECT 'subscription_payments (club)', COUNT(*) FROM subscription_payments
        WHERE profile_type = 'club' AND profile_id IN (SELECT id FROM cp)
      UNION ALL SELECT 'academy_trainers', COUNT(*) FROM academy_trainers WHERE academy_profile_id IN (SELECT id FROM ap)
      UNION ALL SELECT 'trainer_locations', COUNT(*) FROM trainer_locations WHERE trainer_id IN (SELECT id FROM tp)
    ) x
    ORDER BY tbl;
    """

    counts = run_sql(counts_sql)
    nonzero = [c for c in counts if int(c["n"]) > 0]

    print("=== AUTH USERS ===")
    for u in users:
        print(f"  {u['email']}  {u['user_id']}")

    print("\n=== ENTITY IDS ===")
    for e in entities:
        print(f"  {e['email']}  {e['kind']}  {e['entity_id']}")

    print("\n=== ROW COUNTS (nonzero only) ===")
    for c in nonzero:
        print(f"  {c['tbl']}: {c['n']}")

    print("\n=== ROW COUNTS (zero — critical checks) ===")
    critical = [
        "bookings (player profile)",
        "bookings (trainer slots)",
        "invoices (player profile)",
        "invoices (trainer_id)",
        "reviews (player profile)",
        "reviews (trainer)",
        "availability_slots",
        "payment_audit_log (invoice link)",
        "payment_audit_log (booking link)",
        "subscription_payments (trainer)",
    ]
    by_tbl = {c["tbl"]: int(c["n"]) for c in counts}
    for t in critical:
        print(f"  {t}: {by_tbl.get(t, '?')}")

    # Fetch full rows for nonzero base tables (exclude views)
    base_tables = [
        ("auth.users", f"SELECT * FROM auth.users WHERE id IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("profiles", f"SELECT * FROM profiles WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("user_roles", f"SELECT * FROM user_roles WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}])) ORDER BY role"),
        ("trainer_profiles", f"SELECT id, user_id, slug, subscription_status, is_public, trial_ends_at, stripe_customer_id, created_at FROM trainer_profiles WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("trainer_onboarding", f"SELECT * FROM trainer_onboarding WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("academy_profiles", f"SELECT id, name, slug, created_by, is_public, subscription_status FROM academy_profiles WHERE created_by IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("academy_managers", f"SELECT * FROM academy_managers WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("club_profiles", f"SELECT id, created_by, subscription_status FROM club_profiles WHERE created_by IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("club_managers", f"SELECT * FROM club_managers WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}]))"),
        ("onboarding_email_queue", f"SELECT * FROM onboarding_email_queue WHERE user_id IN (SELECT unnest(ARRAY[{uid_array}]))"),
    ]

    # Dynamic: any base table with user_id column
    dynamic = run_sql(
        f"""
        SELECT c.table_name,
          format('SELECT COUNT(*) FROM %I WHERE %I IN (SELECT unnest(ARRAY[{uid_array}]))', c.table_name, c.column_name) AS q
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.column_name = 'user_id'
          AND c.table_name NOT IN (
            'profiles','user_roles','trainer_profiles','trainer_onboarding',
            'onboarding_email_queue','onboarding_email_logs','notification_preferences',
            'notifications','notification_queue','banner_events','calendar_events',
            'mollie_oauth_states','court_reviews'
          )
        ORDER BY c.table_name
        """
    )
    print("\n=== DYNAMIC user_id TABLES ===")
    for d in dynamic:
        try:
            n = run_sql(d["q"])[0]["count"]
        except Exception:
            try:
                n = run_sql(d["q"])[0].get("count(*)") or run_sql(d["q"])[0].get("count")
            except Exception as e:
                print(f"  {d['table_name']}: error {e}")
                continue
        if int(n) > 0:
            print(f"  {d['table_name']}: {n}")

    print("\n=== ROW DETAILS ===")
    for name, sql in base_tables:
        rows = run_sql(sql)
        if not rows:
            continue
        print(f"\n--- {name} ({len(rows)}) ---")
        print(json.dumps(rows, indent=2, default=str))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
