"""Shared helpers for public-schema CSV import (migration_exports/)."""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from auth_common import TARGET_PROJECT_REF

# View / status exports — not base tables
SKIP_TABLE_PATTERNS = re.compile(
    r"(_owner|_safe|_public|_mollie_status)$|^query-results$"
)

# Tables with no CSV in migration_exports (schema may exist on target)
MISSING_EXPORT_TABLES = frozenset(
    {
        "club_managers",
        "club_mollie_accounts",
        "club_players",
        "club_profile_views",
    }
)

# Analytics / audit / history / queues — skipped by default (not required for cutover)
OPTIONAL_SKIP_TABLES = frozenset(
    {
        "admin_impersonation_logs",
        "payment_audit_log",
        "player_rating_history",
        "academy_profile_views",
        "trainer_profile_views",
        "banner_events",
        "notification_queue",
        "onboarding_email_queue",
        "onboarding_email_logs",
        "rate_limits",
        "email_campaign_templates",
        "email_campaigns",
        "email_campaign_recipients",
    }
)

# Columns omitted on insert (re-auth / security after cutover)
STRIP_COLUMNS_BY_TABLE: dict[str, frozenset[str]] = {
    "academy_mollie_accounts": frozenset(
        {"access_token", "refresh_token", "token_expires_at"}
    ),
    "trainer_mollie_accounts": frozenset(
        {"access_token", "refresh_token", "token_expires_at"}
    ),
}

# Satisfied before public import (auth migration complete)
EXTERNAL_PARENTS = frozenset({"auth.users"})

# ~rows/sec for COPY over pooler (conservative)
ROWS_PER_SECOND_ESTIMATE = 250

REFERENCES_RE = re.compile(
    r"REFERENCES\s+(?:public\.)?(\w+)(?:\s*\(|\.|;)",
    re.IGNORECASE,
)


@dataclass
class TableExport:
    name: str
    path: Path
    columns: list[str]
    row_count: int
    duplicate_files: list[str] = field(default_factory=list)


@dataclass
class ImportPlan:
    target_project_ref: str
    exports_dir: Path
    import_tables: list[str]
    deferred_tables: list[str]
    missing_exports: list[str]
    row_counts: dict[str, int]
    import_order: list[str]
    total_rows: int
    estimated_seconds: float
    fk_edges_used: int
    fk_source: str
    warnings: list[str] = field(default_factory=list)


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
        return header, sum(1 for _ in reader)


# Curated FK edges (child → parent) when migration line parsing misses inline REFERENCES
SUPPLEMENTAL_FK: list[tuple[str, str]] = [
    ("profiles", "auth.users"),  # satisfied externally; ignored in topo
    ("user_roles", "auth.users"),
    ("trainer_profiles", "auth.users"),
    ("trainer_onboarding", "auth.users"),
    ("club_profiles", "locations"),
    ("academy_locations", "academy_profiles"),
    ("academy_locations", "locations"),
    ("academy_managers", "academy_profiles"),
    ("academy_trainers", "academy_profiles"),
    ("academy_trainers", "trainer_profiles"),
    ("trainer_locations", "trainer_profiles"),
    ("trainer_locations", "locations"),
    ("availability_slots", "trainer_profiles"),
    ("availability_slots", "locations"),
    ("bookings", "availability_slots"),
    ("bookings", "profiles"),
    ("bookings", "guest_players"),
    ("guest_players", "trainer_profiles"),
    ("guest_players", "profiles"),
    ("intake_requests", "cycles"),
    ("intake_requests", "profiles"),
    ("intake_requests", "locations"),
    ("proposed_assignments", "intake_requests"),
    ("proposed_assignments", "availability_slots"),
    ("proposed_assignments", "trainer_profiles"),
    ("invoices", "trainer_profiles"),
    ("invoices", "profiles"),
    ("invoices", "academy_profiles"),
    ("location_translations", "locations"),
    ("trainer_mollie_accounts", "trainer_profiles"),
    ("academy_mollie_accounts", "academy_profiles"),
    ("academy_followers", "academy_profiles"),
    ("academy_followers", "profiles"),
    ("trainer_followers", "trainer_profiles"),
    ("trainer_followers", "profiles"),
    ("club_followers", "club_profiles"),
    ("player_links", "profiles"),
    ("player_locations", "profiles"),
    ("waiting_list_entries", "profiles"),
    ("academy_player_tags", "academy_profiles"),
    ("academy_player_metadata", "academy_profiles"),
    ("extra_cost_presets", "trainer_profiles"),
    ("user_discounts", "profiles"),
]


def _merge_supplemental_fk(edges: dict[str, set[str]]) -> dict[str, set[str]]:
    for child, parent in SUPPLEMENTAL_FK:
        if parent == "auth.users":
            continue
        edges[child].add(parent)
    return edges


def load_fk_edges_from_migrations(migrations_dir: Path) -> dict[str, set[str]]:
    """child_table -> set of public parent tables (auth.users ignored here)."""
    edges: dict[str, set[str]] = defaultdict(set)
    current_table: str | None = None

    create_re = re.compile(
        r"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+public\.(\w+)",
        re.IGNORECASE,
    )
    alter_re = re.compile(
        r"ALTER\s+TABLE(?:\s+ONLY)?\s+public\.(\w+)",
        re.IGNORECASE,
    )

    for path in sorted(migrations_dir.glob("*.sql")):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for line in text.splitlines():
            cm = create_re.search(line)
            if cm:
                current_table = cm.group(1)
            am = alter_re.search(line)
            if am:
                current_table = am.group(1)
            if not current_table:
                continue
            if "auth.users" in line.lower():
                continue
            for pm in REFERENCES_RE.finditer(line):
                parent = pm.group(1)
                if parent == current_table:
                    continue
                if parent in ("users",):  # auth.users split
                    continue
                edges[current_table].add(parent)

    return _merge_supplemental_fk(edges)


def load_fk_edges_from_db(database_url: str) -> dict[str, set[str]]:
    import psycopg2  # type: ignore

    edges: dict[str, set[str]] = defaultdict(set)
    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                  tc.table_name AS child_table,
                  ccu.table_name AS parent_table,
                  ccu.table_schema AS parent_schema
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                  AND tc.table_schema = kcu.table_schema
                JOIN information_schema.constraint_column_usage ccu
                  ON ccu.constraint_name = tc.constraint_name
                  AND ccu.table_schema = tc.table_schema
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = 'public'
                  AND ccu.table_schema = 'public'
                """
            )
            for child, parent, schema in cur.fetchall():
                if child != parent:
                    edges[child].add(parent)
    finally:
        conn.close()
    return _merge_supplemental_fk(edges)


def topological_import_order(
    tables: set[str],
    fk_edges: dict[str, set[str]],
) -> list[str]:
    """Parents before children. Tables with no deps ordered alphabetically within level."""
    relevant: dict[str, set[str]] = {}
    for child in tables:
        parents = {p for p in fk_edges.get(child, set()) if p in tables}
        relevant[child] = parents

    in_degree = {t: len(relevant[t]) for t in tables}
    children_of: dict[str, list[str]] = defaultdict(list)
    for child, parents in relevant.items():
        for p in parents:
            children_of[p].append(child)

    ready = sorted(t for t in tables if in_degree[t] == 0)
    order: list[str] = []
    while ready:
        t = ready.pop(0)
        order.append(t)
        for child in sorted(children_of[t]):
            in_degree[child] -= 1
            if in_degree[child] == 0:
                ready.append(child)
        ready.sort()

    remaining = [t for t in tables if t not in order]
    if remaining:
        order.extend(sorted(remaining))
    return order


def build_import_plan(
    exports_dir: Path,
    *,
    include_optional: bool = False,
    migrations_dir: Path | None = None,
    database_url: str | None = None,
) -> ImportPlan:
    exports = discover_exports(exports_dir)
    all_export_tables = set(exports.keys())

    deferred = sorted(
        t for t in all_export_tables if t in OPTIONAL_SKIP_TABLES and not include_optional
    )
    import_set = all_export_tables - set(deferred)

    warnings: list[str] = []
    migrations_dir = migrations_dir or Path("supabase/migrations")
    fk_source = "migrations"
    if database_url:
        try:
            fk_edges = load_fk_edges_from_db(database_url)
            fk_source = "database"
        except Exception as e:
            fk_edges = load_fk_edges_from_migrations(migrations_dir)
            warnings.append(f"DB FK introspection failed ({e}); using migrations")
    else:
        fk_edges = load_fk_edges_from_migrations(migrations_dir)

    import_order = topological_import_order(import_set, fk_edges)
    row_counts = {t: exports[t].row_count for t in import_order}
    total_rows = sum(row_counts.values())
    edge_count = sum(
        1
        for child in import_set
        for parent in fk_edges.get(child, set())
        if parent in import_set
    )

    if not include_optional:
        warnings.append(
            f"Deferred {len(deferred)} optional table(s) "
            f"(analytics/log/queues). Use --include-optional to import them."
        )
    warnings.extend(
        f"No CSV for public.{t} — target stays empty unless exported separately"
        for t in sorted(MISSING_EXPORT_TABLES)
    )

    return ImportPlan(
        target_project_ref=TARGET_PROJECT_REF,
        exports_dir=exports_dir,
        import_tables=list(import_order),
        deferred_tables=deferred,
        missing_exports=sorted(MISSING_EXPORT_TABLES),
        row_counts=row_counts,
        import_order=import_order,
        total_rows=total_rows,
        estimated_seconds=max(30.0, total_rows / ROWS_PER_SECOND_ESTIMATE),
        fk_edges_used=edge_count,
        fk_source=fk_source,
        warnings=warnings,
    )


def assert_target_database_url(url: str) -> None:
    if TARGET_PROJECT_REF not in url:
        raise ValueError(
            f"Refusing to run: DATABASE_URL must contain '{TARGET_PROJECT_REF}', "
            f"got host/ref mismatch"
        )


def format_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.0f}s"
    minutes = seconds / 60
    if minutes < 90:
        return f"{minutes:.1f} min"
    return f"{minutes / 60:.1f} hr"
