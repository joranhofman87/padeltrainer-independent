"""Shared helpers for auth migration from profiles CSV exports."""

from __future__ import annotations

import csv
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

TARGET_PROJECT_REF = "ficwbdrzefmblkbkomzw"

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", re.IGNORECASE)


@dataclass(frozen=True)
class ProfileAuthRow:
    profile_id: str
    user_id: str
    email: str
    full_name: str | None
    preferred_language: str | None
    csv_line: int


@dataclass
class AuthDryRunReport:
    profile_rows: int
    unique_user_ids: int
    creatable_users: int
    missing_user_id: list[tuple[int, str]]
    missing_email: list[tuple[str, str | None, int]]
    invalid_email: list[tuple[str, str, int]]
    invalid_user_id: list[tuple[str, int]]
    duplicate_user_id: dict[str, list[int]]
    duplicate_email: dict[str, list[str]]
    blocked: list[dict[str, str | int | None]]

    def to_dict(self) -> dict:
        return {
            "profile_rows": self.profile_rows,
            "unique_user_ids": self.unique_user_ids,
            "creatable_users": self.creatable_users,
            "missing_user_id_count": len(self.missing_user_id),
            "missing_email_count": len(self.missing_email),
            "invalid_email_count": len(self.invalid_email),
            "invalid_user_id_count": len(self.invalid_user_id),
            "duplicate_user_id_count": len(self.duplicate_user_id),
            "duplicate_email_count": len(self.duplicate_email),
            "blocked_count": len(self.blocked),
            "missing_user_id": self.missing_user_id,
            "missing_email": [
                {"user_id": u, "full_name": n, "line": ln}
                for u, n, ln in self.missing_email
            ],
            "invalid_email": [
                {"user_id": u, "email": e, "line": ln}
                for u, e, ln in self.invalid_email
            ],
            "invalid_user_id": [
                {"user_id": u, "line": ln} for u, ln in self.invalid_user_id
            ],
            "duplicate_user_id": self.duplicate_user_id,
            "duplicate_email": self.duplicate_email,
            "blocked": self.blocked,
        }


def find_profiles_csv(exports_dir: Path) -> Path:
    files = list(exports_dir.glob("profiles-export-*.csv"))
    if not files:
        raise FileNotFoundError(
            f"No profiles-export-*.csv in {exports_dir}. "
            "Export public.profiles from Lovable first."
        )
    return max(files, key=lambda p: p.stat().st_size)


def load_profile_auth_rows(exports_dir: Path) -> list[ProfileAuthRow]:
    path = find_profiles_csv(exports_dir)
    rows: list[ProfileAuthRow] = []
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f, delimiter=";")
        for line_no, row in enumerate(reader, start=2):
            rows.append(
                ProfileAuthRow(
                    profile_id=(row.get("id") or "").strip(),
                    user_id=(row.get("user_id") or "").strip(),
                    email=(row.get("email") or "").strip().lower(),
                    full_name=(row.get("full_name") or "").strip() or None,
                    preferred_language=(row.get("preferred_language") or "").strip()
                    or None,
                    csv_line=line_no,
                )
            )
    return rows


def analyze_profiles(rows: list[ProfileAuthRow]) -> AuthDryRunReport:
    by_uid: dict[str, list[ProfileAuthRow]] = defaultdict(list)
    by_email: dict[str, list[str]] = defaultdict(list)

    missing_user_id: list[tuple[int, str]] = []
    missing_email: list[tuple[str, str | None, int]] = []
    invalid_email: list[tuple[str, str, int]] = []
    invalid_user_id: list[tuple[str, int]] = []
    blocked: list[dict[str, str | int | None]] = []

    for r in rows:
        if not r.user_id:
            missing_user_id.append((r.csv_line, r.profile_id))
            blocked.append(
                {
                    "reason": "missing_user_id",
                    "profile_id": r.profile_id,
                    "user_id": None,
                    "email": r.email or None,
                    "line": r.csv_line,
                }
            )
            continue
        try:
            uuid.UUID(r.user_id)
        except ValueError:
            invalid_user_id.append((r.user_id, r.csv_line))
            blocked.append(
                {
                    "reason": "invalid_user_id",
                    "profile_id": r.profile_id,
                    "user_id": r.user_id,
                    "email": r.email or None,
                    "line": r.csv_line,
                }
            )
            continue
        if not r.email:
            missing_email.append((r.user_id, r.full_name, r.csv_line))
            blocked.append(
                {
                    "reason": "missing_email",
                    "profile_id": r.profile_id,
                    "user_id": r.user_id,
                    "email": None,
                    "line": r.csv_line,
                }
            )
            continue
        if not EMAIL_RE.match(r.email):
            invalid_email.append((r.user_id, r.email, r.csv_line))
            blocked.append(
                {
                    "reason": "invalid_email",
                    "profile_id": r.profile_id,
                    "user_id": r.user_id,
                    "email": r.email,
                    "line": r.csv_line,
                }
            )
            continue
        by_uid[r.user_id].append(r)
        by_email[r.email].append(r.user_id)

    duplicate_user_id = {
        uid: [x.csv_line for x in items] for uid, items in by_uid.items() if len(items) > 1
    }
    for uid, lines in duplicate_user_id.items():
        blocked.append(
            {
                "reason": "duplicate_user_id",
                "profile_id": None,
                "user_id": uid,
                "email": by_uid[uid][0].email,
                "line": lines[0],
                "extra_lines": ",".join(str(l) for l in lines[1:]),
            }
        )

    duplicate_email = {em: uids for em, uids in by_email.items() if len(set(uids)) > 1}
    for em, uids in duplicate_email.items():
        for uid in set(uids):
            blocked.append(
                {
                    "reason": "duplicate_email",
                    "profile_id": None,
                    "user_id": uid,
                    "email": em,
                    "line": next(x.csv_line for x in rows if x.user_id == uid),
                }
            )

    creatable = [
        r
        for r in rows
        if r.user_id
        and r.email
        and EMAIL_RE.match(r.email)
        and r.user_id not in duplicate_user_id
        and r.email not in duplicate_email
    ]
    # One row per user_id (if duplicates slipped, take first)
    seen: set[str] = set()
    unique_creatable: list[ProfileAuthRow] = []
    for r in creatable:
        if r.user_id in seen:
            continue
        seen.add(r.user_id)
        unique_creatable.append(r)

    return AuthDryRunReport(
        profile_rows=len(rows),
        unique_user_ids=len(by_uid),
        creatable_users=len(unique_creatable),
        missing_user_id=missing_user_id,
        missing_email=missing_email,
        invalid_email=invalid_email,
        invalid_user_id=invalid_user_id,
        duplicate_user_id=duplicate_user_id,
        duplicate_email=duplicate_email,
        blocked=blocked,
    )


def get_creatable_users(
    rows: list[ProfileAuthRow], report: AuthDryRunReport
) -> list[ProfileAuthRow]:
    """Rows safe to pass to Admin API create (one per user_id)."""
    seen: set[str] = set()
    out: list[ProfileAuthRow] = []
    for r in rows:
        if not r.user_id or not r.email:
            continue
        if r.user_id in report.duplicate_user_id:
            continue
        if r.email in report.duplicate_email:
            continue
        if any(
            b.get("user_id") == r.user_id
            and b["reason"]
            in ("missing_email", "invalid_email", "invalid_user_id", "missing_user_id")
            for b in report.blocked
        ):
            continue
        if r.user_id in seen:
            continue
        seen.add(r.user_id)
        out.append(r)
    return out


def assert_target_project_url(supabase_url: str) -> None:
    if TARGET_PROJECT_REF not in supabase_url:
        raise ValueError(
            f"Refusing to run: SUPABASE_URL must contain target ref "
            f"'{TARGET_PROJECT_REF}', got {supabase_url!r}"
        )
