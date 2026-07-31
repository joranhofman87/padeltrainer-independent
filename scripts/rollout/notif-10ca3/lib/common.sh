# shellcheck shell=bash
# Shared library for the 10c-a3 rollout bundle.
# Sourced by run-rollout.sh, rehearse-clone.sh and logs/fetch-edge-logs.sh.
# No secrets are ever echoed. Every failed assertion returns non-zero so the
# caller's `set -Eeuo pipefail` aborts the run.

# ---------------------------------------------------------------------------
# logging (all to stderr so stdout stays capture-clean for evidence)
# ---------------------------------------------------------------------------
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log()  { printf '[%s] %s\n'      "$(_ts)" "$*" >&2; }
ok()   { printf '[%s] OK   %s\n' "$(_ts)" "$*" >&2; }
warn() { printf '[%s] WARN %s\n' "$(_ts)" "$*" >&2; }
die()  { printf '[%s] FAIL %s\n' "$(_ts)" "$*" >&2; exit 1; }

require_cmd() {
  # require_cmd psql "install the Supabase CLI / libpq"
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 ${2:+($2)}"
}

# portable ISO8601-UTC <-> epoch (BSD/macOS `date -j -f`, GNU `date -d`)
iso_to_epoch() { date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s 2>/dev/null || date -u -d "$1" +%s; }
epoch_to_iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# project-ref identity — EXACT allow-list, never a substring match
# ---------------------------------------------------------------------------
# A Supabase project ref is exactly 20 lowercase alphanumerics.
assert_ref_format() {
  local ref="$1"
  [[ "$ref" =~ ^[a-z0-9]{20}$ ]] || die "REF '$ref' is not a valid 20-char project ref"
}

# The only host/user forms that legitimately address project <ref>:
#   direct   host = db.<ref>.supabase.co                 user = postgres
#   pooler   host = <region>.pooler.supabase.com         user = postgres.<ref>
# We accept a host ONLY if it equals db.<ref>.supabase.co OR ends in the exact
# literal suffix ".pooler.supabase.com" AND the user is postgres.<ref>.
# Substring/`grep` matches are rejected by construction (exact string compares).
assert_host_user_is_ref() {
  local ref="$1" host="$2" user="$3"
  assert_ref_format "$ref"
  if [[ "$host" == "db.${ref}.supabase.co" ]]; then
    [[ "$user" == "postgres" ]] || die "direct host db.${ref}.supabase.co with unexpected user '$user'"
    return 0
  fi
  # pooler: host must END with the exact suffix and the segment before it be non-empty region
  if [[ "$host" == *".pooler.supabase.com" && "$host" != ".pooler.supabase.com" ]]; then
    [[ "$user" == "postgres.${ref}" ]] || die "pooler host '$host' with user '$user' != postgres.${ref}"
    return 0
  fi
  die "host '$host' is not an allow-listed address for ref '$ref' (expected db.${ref}.supabase.co or *.pooler.supabase.com w/ user postgres.${ref})"
}

# Parse a libpq/URI connection string into HOST/PORT/USER/DBNAME (no password
# capture, no echo) and assert it targets EXPECTED_REF exactly.
# Usage: assert_conn_url_is_ref "$EXPECTED_REF" "$CONN_URL"
assert_conn_url_is_ref() {
  local ref="$1" url="$2"
  # strip scheme
  local rest="${url#*://}"
  # userinfo@authority/...   -> split at first '/'
  local authority="${rest%%/*}"
  local userinfo="" hostport=""
  if [[ "$authority" == *"@"* ]]; then
    userinfo="${authority%@*}"
    hostport="${authority##*@}"
  else
    hostport="$authority"
  fi
  local user="${userinfo%%:*}"          # drop :password if present — never stored/echoed
  local host="${hostport%%:*}"
  # percent-decoded user (pooler user 'postgres.<ref>' contains a dot, no encoding needed,
  # but a URL may encode it) — decode the single common case of %2E -> '.'
  user="${user//%2E/.}"; user="${user//%2e/.}"
  [[ -n "$host" ]] || die "could not parse host from connection URL"
  [[ -n "$user" ]] || die "could not parse user from connection URL"
  assert_host_user_is_ref "$ref" "$host" "$user"
  ok "connection target verified as ref '$ref' (host=$host user=$user)"
}

# For `supabase db push`, the CLI targets the *linked* project. Assert the linked
# ref equals EXPECTED_REF exactly before any push.
assert_linked_ref_is() {
  local ref="$1"
  assert_ref_format "$ref"
  require_cmd supabase
  # The CLI records the linked project's ref in supabase/.temp/project-ref — the
  # canonical, machine-readable source (unlike the decorated `projects list` table).
  local ref_file="supabase/.temp/project-ref" linked=""
  [[ -f "$ref_file" ]] || die "no linked Supabase project (run: supabase link --project-ref $ref)"
  linked="$(tr -d '[:space:]' < "$ref_file")"
  [[ -n "$linked" ]] || die "empty $ref_file — re-run: supabase link --project-ref $ref"
  [[ "$linked" == "$ref" ]] || die "linked project ref '$linked' != EXPECTED_REF '$ref' — refusing to push"
  ok "linked Supabase project ref verified == '$ref'"
}

# Assert the checked-out supabase/config.toml (CWD-relative — run INSIDE the
# rollout worktree) declares project_id == ref. Catches a worktree whose config
# points at a different project before any db push.
assert_config_project_ref_is() {
  local ref="$1" f="supabase/config.toml" got
  assert_ref_format "$ref"
  [[ -f "$f" ]] || die "no $f in $(pwd) — run inside the rollout worktree"
  got="$(sed -n 's/^[[:space:]]*project_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
  [[ -n "$got" ]] || die "could not read project_id from $f"
  [[ "$got" == "$ref" ]] || die "worktree config project_id '$got' != EXPECTED_REF '$ref' — refusing"
  ok "worktree config project_id verified == '$ref'"
}

# ---------------------------------------------------------------------------
# rollout guards (unit-tested by verify/guard-mutation-test.sh)
# ---------------------------------------------------------------------------
# The pending migration set MUST equal the expected set exactly (order-free).
assert_pending_is_expected() {
  local actual="$1" expected="$2" a e
  a="$(printf '%s\n' "$actual"   | sed '/^[[:space:]]*$/d' | sort -u)"
  e="$(printf '%s\n' "$expected" | sed '/^[[:space:]]*$/d' | sort -u)"
  [[ "$a" == "$e" ]] || die "pending migrations are not exactly the expected set (got: $(echo "$a" | tr '\n' ' ')| want: $(echo "$e" | tr '\n' ' '))"
  ok "pending migration set == expected ($(echo "$e" | tr '\n' ' '))"
}

# The maintenance drain must be PROVEN before any migration: enough time elapsed
# AND zero sends passed the gate. Both conditions are hard.
assert_drain_proven() {
  local elapsed="$1" min="$2" sends="$3"
  [[ "$elapsed" =~ ^[0-9]+$ ]] || die "drain: bad elapsed '$elapsed'"
  [[ "$sends" =~ ^[0-9]+$ ]]  || die "drain: bad send count '$sends'"
  [[ "$elapsed" -ge "$min" ]] || die "drain NOT proven: only ${elapsed}s elapsed (need >= ${min}s)"
  [[ "$sends" -eq 0 ]]        || die "drain NOT proven: ${sends} provider_send_started event(s) passed the gate"
  ok "drain proven: ${elapsed}s elapsed, 0 sends since gate ON"
}

# ---------------------------------------------------------------------------
# safe URL query construction (handles a base URL that already has ?params)
# ---------------------------------------------------------------------------
# url_add_query "https://h/path?a=1" "sslmode" "require"  -> ".../path?a=1&sslmode=require"
url_add_query() {
  local base="$1" key="$2" val="$3" sep='?'
  [[ "$base" == *"?"* ]] && sep='&'
  printf '%s%s%s=%s' "$base" "$sep" "$key" "$val"
}

# ---------------------------------------------------------------------------
# psql runner — always ON_ERROR_STOP, always fail-loud
# ---------------------------------------------------------------------------
# run_sql <conn_url> <file.sql> [extra psql args...]
# Password must come from PGPASSWORD/PGPASSFILE, never on the command line.
run_sql() {
  local url="$1" file="$2"; shift 2
  require_cmd psql
  [[ -f "$file" ]] || die "sql file not found: $file"
  log "psql -f $(basename "$file")"
  psql "$url" -v ON_ERROR_STOP=1 --no-psqlrc -q -f "$file" "$@" \
    || die "SQL artifact failed (non-zero psql exit): $file"
  ok "$(basename "$file") passed"
}
