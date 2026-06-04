"""Shared constants for Supabase Storage migration (Lovable → new project)."""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Optional
from urllib.parse import unquote

SOURCE_PROJECT_REF = "ppkbhdiiqdusdeatgdft"
TARGET_PROJECT_REF = "ficwbdrzefmblkbkomzw"

SOURCE_STORAGE_HOST = f"https://{SOURCE_PROJECT_REF}.supabase.co"
TARGET_STORAGE_HOST = f"https://{TARGET_PROJECT_REF}.supabase.co"

OLD_URL_PREFIX = f"{SOURCE_STORAGE_HOST}/storage/v1/object"
NEW_URL_PREFIX = f"{TARGET_STORAGE_HOST}/storage/v1/object"

# Buckets to copy (same names on target)
MIGRATION_BUCKETS = (
    "avatars",
    "invoices",
    "blog-images",
    "partner-banners",
    "backups",
)

# Buckets that require service_role on source (private / no public read)
PRIVATE_BUCKETS = frozenset({"invoices", "backups"})

# Base tables + columns that may store full public/private storage URLs
URL_COLUMNS: list[tuple[str, str]] = [
    ("profiles", "avatar_url"),
    ("academy_profiles", "logo_url"),
    ("academy_profiles", "banner_url"),
    ("academy_profiles", "invoice_logo_url"),
    ("club_profiles", "logo_url"),
    ("club_profiles", "banner_url"),
    ("locations", "logo_url"),
    ("articles", "cover_image_url"),
    ("invoices", "pdf_url"),
    ("partner_banners", "image_url"),
    ("partner_banners", "sponsor_logo_url"),
    ("profile_videos", "video_url"),
    ("trainer_profiles", "invoice_logo_url"),
]

# Host replace for cutover; excludes invoices.pdf_url (signed URLs; regenerate PDFs later).
URL_COLUMNS_NON_INVOICE: list[tuple[str, str]] = [
    (table, column)
    for table, column in URL_COLUMNS
    if (table, column) != ("invoices", "pdf_url")
]

# Top-level prefixes in avatars (list separately to reduce API timeouts)
AVATAR_PATH_PREFIXES = (
    "locations/",
    "clubs/",
    "academies/",
    "trainers/",
    "players/",
    "invoices/",
)


@dataclass
class StorageObject:
    bucket: str
    path: str
    size: int | None = None


def jwt_project_ref(api_key: str) -> str | None:
    try:
        payload = api_key.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("ref")
    except Exception:
        return None


def jwt_role(api_key: str) -> str | None:
    try:
        payload = api_key.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        return data.get("role")
    except Exception:
        return None


def project_url_env(prefix: str) -> tuple[str, str, bool]:
    """prefix: SOURCE or TARGET → (url, api_key, is_service_role)."""
    expected_ref = SOURCE_PROJECT_REF if prefix == "SOURCE" else TARGET_PROJECT_REF
    url = os.environ.get(f"{prefix}_SUPABASE_URL", "").strip()
    if not url and prefix == "TARGET":
        url = os.environ.get("SUPABASE_URL", "").strip()
    if not url and prefix == "SOURCE":
        legacy = os.environ.get("SUPABASE_URL", "").strip()
        if SOURCE_PROJECT_REF in legacy:
            url = legacy

    key = os.environ.get(f"{prefix}_SERVICE_ROLE_KEY", "").strip()
    if not key and prefix == "TARGET":
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    is_service_role = jwt_role(key) == "service_role" if key else False
    key_ref = jwt_project_ref(key) if key else None

    if key and key_ref != expected_ref and prefix == "SOURCE":
        print(
            f"WARNING: {prefix}_SERVICE_ROLE_KEY is for project {key_ref!r}, "
            f"expected {expected_ref!r} — ignoring",
            file=sys.stderr,
        )
        key = ""
        is_service_role = False

    if not key and prefix == "SOURCE":
        anon = (
            os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
            or os.environ.get("VITE_SUPABASE_PUBLISHABLE_KEY", "").strip()
        )
        if anon and jwt_project_ref(anon) == expected_ref:
            key = anon
            is_service_role = False
            print(
                "NOTE: Using anon/publishable key for SOURCE (public buckets only; "
                "private buckets need SOURCE_SERVICE_ROLE_KEY for ppkbhd)",
                file=sys.stderr,
            )

    return url, key, is_service_role


def assert_project_url(url: str, ref: str, label: str) -> None:
    if ref not in url:
        raise ValueError(f"{label} URL must contain project ref '{ref}', got {url!r}")


def storage_list_page(
    supabase_url: str,
    service_role_key: str,
    bucket: str,
    *,
    prefix: str = "",
    limit: int = 1000,
    offset: int = 0,
    max_attempts: int = 10,
) -> list[dict]:
    import time

    api = supabase_url.rstrip("/") + f"/storage/v1/object/list/{bucket}"
    body = json.dumps({"prefix": prefix, "limit": limit, "offset": offset}).encode()
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
    }
    last_err: Exception | None = None
    for attempt in range(max_attempts):
        req = urllib.request.Request(api, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())
            return data if isinstance(data, list) else []
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (408, 429, 500, 502, 503, 504, 544) and attempt < max_attempts - 1:
                time.sleep(min(2**attempt, 60))
                continue
            raise
        except Exception as e:
            last_err = e
            if attempt < max_attempts - 1:
                time.sleep(min(2**attempt, 30))
                continue
            raise
    if last_err:
        raise last_err
    return []


def list_bucket_objects_recursive(
    supabase_url: str,
    api_key: str,
    bucket: str,
    *,
    on_progress: Callable[[str, int], None] | None = None,
    root_prefix: str = "",
) -> list[StorageObject]:
    """List file objects under root_prefix (read-only). Folders have no `id`."""
    files: list[StorageObject] = []

    def walk(prefix: str) -> None:
        offset = 0
        limit = 1000
        while True:
            batch = storage_list_page(
                supabase_url,
                api_key,
                bucket,
                prefix=prefix,
                limit=limit,
                offset=offset,
            )
            if not batch:
                break
            for item in batch:
                name = item.get("name") or ""
                if not name:
                    continue
                child_prefix = f"{prefix}{name}"
                if item.get("id"):
                    meta = item.get("metadata") or {}
                    size = meta.get("size")
                    files.append(
                        StorageObject(
                            bucket=bucket,
                            path=child_prefix,
                            size=int(size) if size is not None else None,
                        )
                    )
                    if on_progress and len(files) % 500 == 0:
                        on_progress(bucket, len(files))
                else:
                    walk(child_prefix + "/")
            if len(batch) < limit:
                break
            offset += limit

    walk(root_prefix)
    return files


def iter_bucket_objects_recursive(
    supabase_url: str,
    api_key: str,
    bucket: str,
    *,
    root_prefix: str = "",
) -> Iterator[StorageObject]:
    """Yield file objects under root_prefix (streaming walk)."""

    def walk(prefix: str) -> Iterator[StorageObject]:
        offset = 0
        limit = 1000
        while True:
            batch = storage_list_page(
                supabase_url,
                api_key,
                bucket,
                prefix=prefix,
                limit=limit,
                offset=offset,
            )
            if not batch:
                break
            for item in batch:
                name = item.get("name") or ""
                if not name:
                    continue
                child_prefix = f"{prefix}{name}"
                if item.get("id"):
                    meta = item.get("metadata") or {}
                    size = meta.get("size")
                    yield StorageObject(
                        bucket=bucket,
                        path=child_prefix,
                        size=int(size) if size is not None else None,
                    )
                else:
                    yield from walk(child_prefix + "/")
            if len(batch) < limit:
                break
            offset += limit

    yield from walk(root_prefix)


def iter_bucket_objects(
    supabase_url: str,
    api_key: str,
    bucket: str,
) -> Iterator[StorageObject]:
    if bucket != "avatars":
        yield from iter_bucket_objects_recursive(supabase_url, api_key, bucket)
        return
    seen: set[str] = set()
    for prefix in AVATAR_PATH_PREFIXES:
        for obj in iter_bucket_objects_recursive(
            supabase_url, api_key, bucket, root_prefix=prefix
        ):
            if obj.path in seen:
                continue
            seen.add(obj.path)
            yield obj


def list_bucket_objects(
    supabase_url: str,
    api_key: str,
    bucket: str,
    *,
    on_progress: Callable[[str, int], None] | None = None,
) -> list[StorageObject]:
    """List bucket objects; avatars uses known top-level prefixes."""
    if bucket != "avatars":
        return list_bucket_objects_recursive(
            supabase_url, api_key, bucket, on_progress=on_progress
        )
    merged: list[StorageObject] = []
    for prefix in AVATAR_PATH_PREFIXES:
        batch = list_bucket_objects_recursive(
            supabase_url, api_key, bucket, on_progress=on_progress, root_prefix=prefix
        )
        merged.extend(batch)
    seen: set[str] = set()
    unique: list[StorageObject] = []
    for obj in merged:
        if obj.path in seen:
            continue
        seen.add(obj.path)
        unique.append(obj)
    return unique


def public_object_url(project_host: str, bucket: str, path: str) -> str:
    return f"{project_host}/storage/v1/object/public/{bucket}/{path}"


_STORAGE_PATH_RE = re.compile(
    r"/storage/v1/object/(?:public|sign|authenticated)/([^/?]+)/([^?]+)"
)


def parse_storage_path_from_url(url: str) -> Optional[tuple[str, str]]:
    """Return (bucket, path) from a Supabase storage URL, or None."""
    m = _STORAGE_PATH_RE.search(url)
    if not m:
        return None
    return m.group(1), unquote(m.group(2))
