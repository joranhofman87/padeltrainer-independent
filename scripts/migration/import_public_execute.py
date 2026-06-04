#!/usr/bin/env python3
"""
Execute public-table CSV import into target Supabase (PostgreSQL only).

DEFAULT: dry-run summary only.

  DATABASE_URL="postgresql://postgres.ficwbdrzefmblkbkomzw:...@aws-1-eu-central-1.pooler.supabase.com:5432/postgres" \\
  python3 scripts/migration/import_public_execute.py

Real import (requires explicit approval):

  DATABASE_URL="..." \\
  python3 scripts/migration/import_public_execute.py --execute --confirm

Safety:
  - Skips auth schema
  - SET session_replication_role = replica (no onboarding/email triggers)
  - No Edge Function / HTTP calls from this script
  - Aborts if target table already has rows (no silent overwrite)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from import_common import (
    STRIP_COLUMNS_BY_TABLE,
    build_import_plan,
    discover_exports,
    assert_target_database_url,
    format_duration,
)


def get_table_columns(cur, table: str) -> list[str]:
    cur.execute(
        """
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
        """,
        (table,),
    )
    return [r[0] for r in cur.fetchall()]


def get_column_types(cur, table: str) -> dict[str, tuple[str, str, str]]:
    cur.execute(
        """
        SELECT column_name, data_type, udt_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        """,
        (table,),
    )
    return {name: (dtype, udt, nullable) for name, dtype, udt, nullable in cur.fetchall()}


def parse_cell(raw: str | None, dtype: str, udt: str, is_nullable: str):
    """Convert CSV string to Python value for parameterized INSERT."""
    if raw is None or not str(raw).strip():
        if is_nullable == "YES":
            return None
        if dtype == "boolean":
            return False
        if "timestamp" in dtype or udt in ("timestamptz", "timestamp", "date"):
            return None if is_nullable == "YES" else "1970-01-01 00:00:00+00"
        if dtype in ("text", "character varying"):
            return "Unknown"
        return ""
    v = str(raw).strip()
    if dtype == "ARRAY" or udt.startswith("_"):
        if v.startswith("[") and v.endswith("]"):
            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    if udt == "_uuid":
                        return [uuid.UUID(x) for x in parsed if x]
                    return parsed
            except (json.JSONDecodeError, ValueError):
                pass
        return v
    if dtype in ("json", "jsonb"):
        if v.startswith(("{", "[")):
            try:
                return json.loads(v)
            except json.JSONDecodeError:
                return v
        return v
    if "timestamp" in dtype or udt in ("timestamptz", "timestamp", "date"):
        return v
    if udt == "uuid":
        return v
    if dtype == "boolean":
        if not v:
            return None if is_nullable == "YES" else False
        return v.lower() in ("true", "t", "1", "yes")
    if dtype in ("integer", "bigint", "smallint") or udt in ("int4", "int8", "int2"):
        try:
            return int(float(v))
        except ValueError:
            return v
    if dtype == "numeric" or udt == "numeric":
        return v
    if dtype == "double precision" or udt == "float8":
        return float(v)
    return v


def table_row_count(cur, table: str) -> int:
    cur.execute(f"SELECT COUNT(*) FROM public.{table}")  # noqa: S608
    (n,) = cur.fetchone()
    return int(n)


def import_table_batch(
    cur,
    table: str,
    export_path: Path,
    db_columns: list[str],
    col_types: dict[str, tuple[str, str, str]],
    strip_cols: set[str],
    *,
    page_size: int = 500,
) -> int:
    from psycopg2.extras import execute_values, Json  # type: ignore

    with export_path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        if not reader.fieldnames:
            return 0
        csv_cols = [c for c in reader.fieldnames if c in db_columns and c not in strip_cols]
        if not csv_cols:
            raise RuntimeError(f"{table}: no overlapping columns between CSV and database")

        cols_sql = ", ".join(f'"{c}"' for c in csv_cols)
        sql = f'INSERT INTO public."{table}" ({cols_sql}) VALUES %s'  # noqa: S608

        batch: list[tuple] = []
        row_count = 0
        skipped = 0
        for row in reader:
            if "id" in csv_cols:
                rid = (row.get("id") or "").strip()
                try:
                    uuid.UUID(rid)
                except ValueError:
                    skipped += 1
                    continue
            vals = []
            for c in csv_cols:
                dtype, udt, nullable = col_types.get(c, ("text", "text", "YES"))
                cell = parse_cell(row.get(c), dtype, udt, nullable)
                if dtype in ("json", "jsonb") and isinstance(cell, (dict, list)):
                    cell = Json(cell)
                vals.append(cell)
            batch.append(tuple(vals))
            if len(batch) >= page_size:
                execute_values(cur, sql, batch, page_size=len(batch))
                row_count += len(batch)
                batch = []
        if batch:
            execute_values(cur, sql, batch, page_size=len(batch))
            row_count += len(batch)
        if skipped:
            print(f"  (skipped {skipped} malformed CSV row(s) in {table})", file=sys.stderr)
        return row_count


def run_execute(
    database_url: str,
    exports_dir: Path,
    *,
    include_optional: bool,
) -> int:
    import psycopg2  # type: ignore
    from psycopg2.extras import register_uuid  # type: ignore

    register_uuid()
    assert_target_database_url(database_url)
    plan = build_import_plan(
        exports_dir,
        include_optional=include_optional,
        database_url=database_url,
    )
    exports = discover_exports(exports_dir)

    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    started = time.monotonic()
    results: list[dict] = []

    try:
        with conn.cursor() as cur:
            cur.execute("SET session_replication_role = replica")
            cur.execute("SET statement_timeout = 0")

            for table in plan.import_order:
                ex = exports[table]
                existing = table_row_count(cur, table)
                if existing > 0:
                    raise RuntimeError(
                        f"public.{table} already has {existing} rows — "
                        "refusing to import (truncate not allowed without explicit approval)"
                    )

                db_cols = get_table_columns(cur, table)
                col_types = get_column_types(cur, table)
                strip = STRIP_COLUMNS_BY_TABLE.get(table, frozenset())
                t0 = time.monotonic()
                if ex.row_count == 0:
                    n = 0
                else:
                    n = import_table_batch(
                        cur, table, ex.path, db_cols, col_types, strip
                    )
                elapsed = time.monotonic() - t0
                results.append(
                    {"table": table, "rows": n, "seconds": round(elapsed, 2)}
                )
                print(f"OK {table}: {n:,} rows in {elapsed:.1f}s")

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        try:
            with conn.cursor() as cur:
                cur.execute("SET session_replication_role = DEFAULT")
        except Exception:
            pass
        conn.close()

    total_rows = sum(r["rows"] for r in results)
    elapsed = time.monotonic() - started
    print()
    print("--- Import finished ---")
    print(f"Tables: {len(results)}")
    print(f"Rows:   {total_rows:,}")
    print(f"Time:   {format_duration(elapsed)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute public CSV import")
    parser.add_argument("--exports-dir", type=Path, default=Path("migration_exports"))
    parser.add_argument("--include-optional", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")

    if args.execute:
        if not db_url:
            print("ERROR: DATABASE_URL or SUPABASE_DB_URL required for --execute", file=sys.stderr)
            return 1
        try:
            assert_target_database_url(db_url)
        except ValueError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            return 1

    plan = build_import_plan(
        args.exports_dir,
        include_optional=args.include_optional,
        database_url=db_url if args.execute else None,
    )

    if not args.execute:
        print("DRY-RUN MODE (no database writes)")
        print(f"Would import {len(plan.import_tables)} tables, {plan.total_rows:,} rows")
        print(f"Estimated: {format_duration(plan.estimated_seconds)}")
        print(f"FK order source: {plan.fk_source}")
        if not db_url:
            print("DATABASE_URL not set — plan uses migration FK graph only (no target row checks)")
        print("To execute:")
        print(
            "  DATABASE_URL='postgresql://postgres.ficwbdrzefmblkbkomzw:...@.../postgres' \\"
        )
        print(
            "  python3 scripts/migration/import_public_execute.py --execute --confirm"
        )
        return 0

    if not args.confirm:
        print("ERROR: --execute requires --confirm", file=sys.stderr)
        return 1

    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("ERROR: pip install psycopg2-binary", file=sys.stderr)
        return 1

    print(f"EXECUTE import → {plan.target_project_ref}")
    print(f"Tables: {len(plan.import_tables)}, rows: {plan.total_rows:,}")
    return run_execute(db_url, args.exports_dir, include_optional=args.include_optional)


if __name__ == "__main__":
    sys.exit(main())
