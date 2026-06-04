#!/usr/bin/env python3
"""Read-only: compare target DB rows vs CSV exports for non-empty import tables."""

from __future__ import annotations

import csv
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_common import assert_target_database_url, discover_exports

TABLES = [
    "banner_placements",
    "certifications",
    "locations",
    "profiles",
    "rating_systems",
    "review_tags",
    "specializations",
    "subscription_plans",
]

# Natural keys for overlap when ids differ
KEY_COLUMNS: dict[str, list[str]] = {
    "banner_placements": ["slug"],
    "certifications": ["name", "country"],
    "locations": ["slug"],
    "profiles": ["user_id"],
    "rating_systems": ["code"],
    "review_tags": ["name", "category"],
    "specializations": ["name"],
    "subscription_plans": ["tier", "plan_type"],
}


def load_csv_ids_and_keys(exports_dir: Path, table: str) -> tuple[set[str], set[tuple], int]:
    exports = discover_exports(exports_dir)
    ex = exports[table]
    ids: set[str] = set()
    keys: set[tuple] = set()
    key_cols = KEY_COLUMNS[table]
    with ex.path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for row in reader:
            rid = (row.get("id") or "").strip()
            if rid:
                ids.add(rid)
            keys.add(tuple((row.get(c) or "").strip() for c in key_cols))
    return ids, keys, ex.row_count


def main() -> int:
    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("ERROR: DATABASE_URL required", file=sys.stderr)
        return 1
    assert_target_database_url(db_url)

    import psycopg2  # type: ignore
    from psycopg2.extras import RealDictCursor

    exports_dir = Path("migration_exports")
    conn = psycopg2.connect(db_url)
    report: list[dict] = []

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            for table in TABLES:
                cur.execute(f"SELECT COUNT(*) AS n FROM public.{table}")  # noqa: S608
                db_count = int(cur.fetchone()["n"])

                cur.execute(f"SELECT * FROM public.{table}")  # noqa: S608
                db_rows = cur.fetchall()
                db_ids = {str(r["id"]) for r in db_rows if r.get("id")}

                csv_ids, csv_keys, csv_count = load_csv_ids_and_keys(exports_dir, table)
                key_cols = KEY_COLUMNS[table]

                db_keys: set[tuple] = set()
                for r in db_rows:
                    db_keys.add(tuple(str(r.get(c) or "").strip() for c in key_cols))

                ids_only_db = db_ids - csv_ids
                ids_only_csv = csv_ids - db_ids
                ids_both = db_ids & csv_ids
                keys_only_db = db_keys - csv_keys
                keys_only_csv = csv_keys - db_keys
                keys_both = db_keys & csv_keys

                # For overlapping ids, compare a stable subset of columns
                id_match_detail = "n/a"
                if ids_both:
                    exports = discover_exports(exports_dir)
                    csv_by_id: dict[str, dict] = {}
                    with exports[table].path.open(encoding="utf-8-sig", newline="") as f:
                        for row in csv.DictReader(f, delimiter=";"):
                            rid = (row.get("id") or "").strip()
                            if rid:
                                csv_by_id[rid] = row
                    db_by_id = {str(r["id"]): r for r in db_rows if r.get("id")}
                    compare_cols = [
                        c
                        for c in csv_by_id[next(iter(ids_both))].keys()
                        if c in db_by_id[next(iter(ids_both))]
                        and c not in ("created_at", "updated_at")
                    ]
                    mismatched = 0
                    for rid in ids_both:
                        cr, dr = csv_by_id[rid], db_by_id[rid]
                        for col in compare_cols:
                            cv = (cr.get(col) or "").strip()
                            dv = str(dr.get(col) or "").strip()
                            if cv != dv:
                                mismatched += 1
                                break
                    id_match_detail = (
                        f"{len(ids_both) - mismatched}/{len(ids_both)} shared ids identical "
                        f"(excl. timestamps)"
                    )

                if db_count == csv_count == 0:
                    relation = "both empty"
                elif db_ids == csv_ids and db_count == csv_count:
                    relation = "same id set and counts"
                elif keys_both and not keys_only_db and not keys_only_csv:
                    relation = "same natural keys (ids may differ)"
                elif ids_both and (ids_only_db or ids_only_csv):
                    relation = "partial id overlap"
                elif not ids_both and keys_both:
                    relation = "no shared ids; some shared keys"
                elif db_count < csv_count and not ids_only_db:
                    relation = "db is subset of csv by id"
                elif db_count < csv_count:
                    relation = "db smaller than csv"
                else:
                    relation = "disjoint or different datasets"

                report.append(
                    {
                        "table": table,
                        "db_count": db_count,
                        "csv_count": csv_count,
                        "ids_db": len(db_ids),
                        "ids_csv": len(csv_ids),
                        "ids_both": len(ids_both),
                        "ids_only_db": len(ids_only_db),
                        "ids_only_csv": len(ids_only_csv),
                        "keys_both": len(keys_both),
                        "keys_only_db": len(keys_only_db),
                        "keys_only_csv": len(keys_only_csv),
                        "relation": relation,
                        "id_match_detail": id_match_detail,
                    }
                )
    finally:
        conn.close()

    # Extra profiles: auth alignment
    import psycopg2
    from auth_common import load_profile_auth_rows

    profile_users_csv = {r.user_id for r in load_profile_auth_rows(exports_dir)}
    conn = psycopg2.connect(db_url)
    with conn.cursor() as cur:
        cur.execute("SELECT user_id::text FROM public.profiles")
        profile_users_db = {r[0] for r in cur.fetchall()}
        cur.execute("SELECT COUNT(*) FROM auth.users")
        auth_n = cur.fetchone()[0]
    conn.close()

    print(json.dumps(report, indent=2))
    print()
    print("profiles user_id vs auth.users:", len(profile_users_db), "profiles,", auth_n, "auth")
    print("profiles user_id db==csv:", profile_users_db == profile_users_csv)
    print("db user_ids subset of csv:", profile_users_db <= profile_users_csv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
