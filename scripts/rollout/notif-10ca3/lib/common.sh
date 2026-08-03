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
# die preserving a specific status — used where the ORIGINAL failure's exit code
# must survive a compensating action taken after it
die_rc() { local c="$1"; shift; printf '[%s] FAIL %s\n' "$(_ts)" "$*" >&2; exit "$c"; }

require_cmd() {
  # require_cmd psql "install the Supabase CLI / libpq"
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 ${2:+($2)}"
}

# Required-env / required-arg guards.
#
# These exist because `: "${VAR:?msg}"` is UNSAFE in any script that installs an
# EXIT trap: in bash 3.2 a parameter-expansion failure resets $? to 0 BEFORE the
# trap runs, so the script prints the fatal message and then exits 0 — a silent
# false success. (Verified: identical script without a trap exits 1.) `die`
# calls `exit 1` explicitly, which survives the trap on every path.
# Never reintroduce `${VAR:?}` in a trap-installing script.
# (mutation-pinned by verify/exit-status-test.sh)
require_env() {
  local n="$1"
  [[ -n "${!n:-}" ]] || die "${2:-missing required environment variable: $n}"
}
require_arg() {
  [[ -n "${1:-}" ]] || die "${2:-missing required argument}"
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
  # IT MUST ACTUALLY BE A URI. libpq accepts TWO connection-string forms, and the other one is
  # keyword/value conninfo — `host=... user=... dbname=...`, last occurrence winning. Everything
  # below parses a URI, and on a keyword string it parses the wrong thing entirely: a value like
  #
  #   dbname=postgresql://postgres.<expected>@<expected-pooler>/postgres host=<other> dbname=postgres
  #
  # splits at the first '://' into an authority that names the EXPECTED project, passes every check
  # here, and is then handed to psql — which reads it as keyword conninfo and connects to <other>.
  # Whitespace is what makes that possible (it separates the keywords), and no legitimate connection
  # URI for this bundle contains any, so both are refused: the scheme must lead, and the string must
  # be a single unbroken token.
  case "$url" in
    postgresql://*|postgres://*) : ;;
    *) die "connection string must be a postgresql:// or postgres:// URI — libpq also accepts keyword/value conninfo (host=... user=...), which would defeat the EXPECTED_REF check entirely" ;;
  esac
  [[ "$url" != *[[:space:]]* ]] \
    || die "connection url contains whitespace — refusing: whitespace is what turns a url into libpq keyword/value conninfo, where a later host= overrides the authority"
  [[ "$url" != *[[:cntrl:]]* ]] \
    || die "connection url contains a control character — refusing"
  case "$url" in *\#*) die "refusing a connection url with a fragment" ;; esac

  # THE QUERY STRING IS AN ALLOW-LIST OF ONE. libpq reads `host`, `hostaddr`, `port`, `user`,
  # `dbname`, `service` and `options` out of the URI query string, and they OVERRIDE the authority:
  #
  #   postgresql://postgres@db.<expected>.supabase.co:5432/postgres?host=db.<other>.supabase.co
  #
  # names the expected project in its authority, passes an authority-only validator, and connects to
  # <other>. `options=-csearch_path=…` re-points every unqualified reference besides. Only `sslmode`
  # is permitted, and only at strengths that do not downgrade TLS; a percent-encoded key is refused
  # outright rather than decoded and compared, because `%68ost` and `host` must not be able to
  # differ here.
  local query="" q pair k v seen_sslmode=0
  case "$url" in *\?*) query="${url#*\?}" ;; esac
  if [[ -n "$query" ]]; then
    local IFS_SAVE="$IFS"; IFS='&'
    for pair in $query; do
      IFS="$IFS_SAVE"
      k="${pair%%=*}"; v="${pair#*=}"
      # DELIBERATELY REDUNDANT, and recorded as such rather than pretended otherwise: the exact
      # `== sslmode` comparison below already rejects every encoded spelling, so no test can
      # isolate this line and a mutation that deletes it survives. It is kept because it gives the
      # precise diagnosis, and because it becomes load-bearing the moment the allow-list grows or
      # anyone decodes keys before comparing them.
      [[ "$k" =~ ^[A-Za-z]+$ ]] \
        || die "connection url query parameter '$k' is not a plain name — refusing (a percent-encoded key could name an identity parameter such as host or options)"
      [[ "$k" == "sslmode" ]] \
        || die "connection url query parameter '$k' is not permitted — only sslmode is, because libpq lets host/hostaddr/port/user/dbname/service/options override the authority this check validates"
      case "$v" in
        require|verify-ca|verify-full) : ;;
        *) die "sslmode='$v' would weaken or disable TLS for a production connection — use require, verify-ca or verify-full" ;;
      esac
      [[ "$seen_sslmode" -eq 0 ]] || die "connection url repeats sslmode — libpq takes the LAST occurrence, so a duplicate is a way to hide the effective value"
      seen_sslmode=1
      IFS='&'
    done
    IFS="$IFS_SAVE"
  fi

  # strip scheme, then the query — everything below parses the authority + path only
  local rest="${url#*://}"
  rest="${rest%%\?*}"
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
  # THE PATH IS THE DATABASE NAME, and it was never looked at. With the query string banned it is
  # the only place a dbname can come from, so it must be the one this rollout targets — an empty
  # path silently means "the database named after the user", which is a different connection.
  local path="/${rest#*/}"
  [[ "$rest" == */* ]] || path=""
  [[ "$path" == "/postgres" ]] \
    || die "connection url must name the 'postgres' database (got path '${path:-<none>}') — an empty or different path is a different connection than the one being validated"
  # An explicit port must be a plain number: anything else is not a port, and would mean the
  # authority did not parse the way this validator assumed.
  if [[ "$hostport" == *:* ]]; then
    local port="${hostport##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] || die "connection url port '$port' is not numeric"
  fi
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

# Hosted Edge Functions can run for up to 400s (paid plan); the analytics API
# rounds query bounds to the minute. The drain wait + pre-gate lookback must
# cover a request that began just before the gate and is still executing.
ROLLOUT_FUNCTION_MAX_WALL=400
ROLLOUT_INGEST_MARGIN=120          # analytics minute-rounding (both ends) + ingestion lag
ROLLOUT_DRAIN_FLOOR=$((ROLLOUT_FUNCTION_MAX_WALL + ROLLOUT_INGEST_MARGIN))   # 520s
assert_drain_window() {
  local min="$1"
  [[ "$min" =~ ^[0-9]+$ ]] || die "drain window not numeric: '$min'"
  [[ "$min" -ge "$ROLLOUT_DRAIN_FLOOR" ]] \
    || die "MIN_DRAIN_SECONDS=${min}s < floor ${ROLLOUT_DRAIN_FLOOR}s (400s max function wall + ${ROLLOUT_INGEST_MARGIN}s margin)"
  ok "drain window ${min}s >= floor ${ROLLOUT_DRAIN_FLOOR}s"
}

# The whole rollout is "bounded": every migration runs under an explicit
# statement_timeout + lock_timeout so a runaway rewrite or a lock wait can never
# hold the gate open indefinitely. PostgreSQL treats **0 as DISABLED**, so a cap
# of `0` silently removes exactly the bound the plan depends on while every log
# line still says "bounded". The values are also interpolated into `PGOPTIONS`
# unquoted, so a value like `3000 -c statement_timeout=0` would smuggle in a
# second option. Both caps must therefore be a POSITIVE DECIMAL INTEGER, nothing
# else — no 0, no sign, no units, no whitespace, no extra `-c`.
# (mutation-pinned: verify/guard-mutation-test.sh + verify/operator-flow-test.sh)
assert_timeout_ms() {   # $1 = name  $2 = value
  local n="$1" v="${2-}"
  [[ -n "$v" ]] || die "$n is unset/empty — set it to a positive integer in milliseconds"
  [[ "$v" =~ ^[0-9]+$ ]] \
    || die "$n='$v' is not a plain decimal integer — no signs, spaces, units or extra '-c' options are accepted (it goes straight into PGOPTIONS)"
  [[ "$v" -gt 0 ]] || die "$n='$v' — PostgreSQL treats 0 as DISABLED; the rollout must stay bounded"
  ok "$n = ${v}ms (positive, bounded)"
}
# Validate BOTH caps before anything irreversible. CAP_LOCK's 3000ms default is
# validated too, so a bad exported value can never slip through the default path.
assert_caps() {
  assert_timeout_ms CAP_STMT "${CAP_STMT:-}"
  assert_timeout_ms CAP_LOCK "${CAP_LOCK:-3000}"
}

# Classify the migration ledger. Accepts ONLY the legitimate ordered prefixes.
# Any other subset ({V2}, {V1,V3}, ...) is 'invalid' and must stop recovery.
classify_ledger() { # $1 sorted-csv  $2 V1  $3 V2  $4 V3 -> none|prefix1|prefix2|all|invalid
  case "$1" in
    "")            echo none;;
    "$2")          echo prefix1;;
    "$2,$3")       echo prefix2;;
    "$2,$3,$4")    echo all;;
    *)             echo invalid;;
  esac
}

# The exact pending SUFFIX that must remain for a given ledger state — what a
# resume push should apply. Anything else means a corrupt/unexpected state.
expected_pending_suffix() { # $1 state  $2 V1  $3 V2  $4 V3 -> newline list (empty for 'all')
  case "$1" in
    none)    printf '%s\n%s\n%s\n' "$2" "$3" "$4";;
    prefix1) printf '%s\n%s\n' "$3" "$4";;
    prefix2) printf '%s\n' "$4";;
    all)     printf '';;
    *)       die "no defined pending suffix for ledger state '$1'";;
  esac
}

# Delete a file holding pseudonymous personal data, overwriting first.
#
# `shred` is a GNU coreutils tool and is ABSENT on macOS (and `gshred` is only
# present with coreutils installed) — the operator machine for this rollout is
# darwin. The previous `shred -u ... || rm -f` therefore silently degraded to a
# plain unlink while the runbook promised secure erasure. We now overwrite the
# bytes ourselves when shred is unavailable, and say plainly what happened.
#
# HONEST LIMIT: on SSDs, APFS/btrfs/ZFS copy-on-write, or any journalling
# filesystem, an in-place overwrite does NOT guarantee the old blocks are gone.
# The real controls remain the 0600 permissions and the short retention window.
# FAILS CLOSED: if the overwrite OR the unlink cannot be performed, a non-zero
# status is returned and the caller must not report the evidence as cleaned —
# never unlink-and-claim-overwritten, never claim-deleted-when-still-present.
# Overwrite is block-sized (not bs=1) so it stays bounded on large manifests.
# SYMLINKS ARE REFUSED: `-f` follows links, so a symlinked evidence path would
# shred whatever it points at (and leave the link) — that is never what the
# operator meant, so it stops instead.
secure_delete() {
  local f="$1" size blocks
  if [[ -L "$f" ]]; then
    warn "REFUSING to secure-delete '$(basename "$f")': it is a SYMLINK — overwriting would destroy the link target, not the evidence file. Resolve it by hand."
    return 1
  fi
  [[ -f "$f" ]] || return 0
  if command -v shred >/dev/null 2>&1; then
    shred -u "$f" 2>/dev/null && { ok "securely deleted (shred): $(basename "$f")"; return 0; }
    warn "shred failed on $(basename "$f") — falling back to overwrite"
  elif command -v gshred >/dev/null 2>&1; then
    gshred -u "$f" 2>/dev/null && { ok "securely deleted (gshred): $(basename "$f")"; return 0; }
    warn "gshred failed on $(basename "$f") — falling back to overwrite"
  fi
  size="$(wc -c < "$f" 2>/dev/null | tr -d ' ')" || { warn "cannot size $(basename "$f") — PRESERVED"; return 1; }
  blocks=$(( (size + 65535) / 65536 ))
  if ! dd if=/dev/urandom of="$f" bs=65536 count="$blocks" conv=notrunc 2>/dev/null; then
    warn "OVERWRITE FAILED for $(basename "$f") — file PRESERVED, not deleted (delete it manually once you can overwrite it)"
    return 1
  fi
  if ! rm -f "$f"; then   # UNLINK-GUARD (mutation-pinned: verify/operator-flow-test.sh)
    warn "overwrote $(basename "$f") but UNLINK FAILED — the plaintext is destroyed, but the file still EXISTS; remove it manually. NOT reported as cleaned."
    return 1
  fi
  warn "shred unavailable — overwrote $(basename "$f") ($size bytes) then unlinked (not guaranteed on SSD/CoW)"
  return 0
}

# ---------------------------------------------------------------------------
# clone identity — a clone is named EXPLICITLY and must NOT be production
# ---------------------------------------------------------------------------
# Clone-only commands (verify-clone, clone-push, the A-D rehearsals) write to the
# target: academy_fixture.sql INSERTs before it ROLLBACKs, and clone-push applies
# migrations. Running any of them against production would be a production write.
# So a clone must be named by CLONE_REF, CLONE_REF must differ from EXPECTED_REF,
# and the URL must address CLONE_REF exactly. "--clone" alone is not enough.
assert_clone_url() {   # $1 = url ; uses CLONE_REF + EXPECTED_REF
  local url="$1"
  [[ -n "${CLONE_REF:-}" ]] || die "clone commands require CLONE_REF (the disposable clone's project ref)"
  assert_ref_format "$CLONE_REF"
  [[ "$CLONE_REF" != "${EXPECTED_REF:-}" ]] \
    || die "CLONE_REF equals EXPECTED_REF ($EXPECTED_REF) — refusing: this is PRODUCTION, not a clone"
  assert_conn_url_is_ref "$CLONE_REF" "$url"
  ok "clone target verified as CLONE_REF '$CLONE_REF' (and != production '$EXPECTED_REF')"
}

# per-run salt for the fingerprint manifest (no raw email PII in evidence)
gen_salt() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 16
  elif [[ -r /dev/urandom ]]; then head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'
  else die "no salt source (need openssl or /dev/urandom)"; fi
}

# A manifest must be INTERNALLY COMPLETE + snapshot-consistent, not just carry
# the EV keys: every line matches the exact grammar (no unknown/malformed),
# EAS/EDE fingerprints are unique, and their counts equal the declared
# eas_rows/ede_rows (guaranteed by the REPEATABLE READ snapshot in manifest.sql).
# EAS/EDE are salted SHA-256 (64 hex) fingerprints — never raw PII.
validate_manifest() {
  local f="$1" tag="${2:-manifest}" k n easN edeN easU edeU easRows edeRows
  [[ -f "$f" ]] || die "manifest ($tag): file not found: $f"
  # EV keys exactly once + well-formed
  for k in eas_rows ede_rows eas_bad_state_rows reader_academy_md5 reader_overview_md5; do
    n="$(grep -c "^EV ${k}=" "$f" || true)"; [[ "$n" -eq 1 ]] || die "manifest ($tag): EV $k present $n time(s) (want exactly 1)"
  done
  for k in eas_rows ede_rows eas_bad_state_rows; do
    grep -qE "^EV ${k}=[0-9]+$" "$f" || die "manifest ($tag): EV $k not a non-negative integer"; done
  for k in reader_academy_md5 reader_overview_md5; do
    grep -qE "^EV ${k}=([0-9a-f]{32}|absent)$" "$f" || die "manifest ($tag): EV $k not md5-or-absent"; done
  # EVERY line must be a known, well-formed line: an EV record from the EXPLICIT
  # five-key allow-list, or an EAS/EDE 64-hex fingerprint. Anything else —
  # including an unknown EV key — is rejected.
  if grep -qvE '^(EV (eas_rows|ede_rows|eas_bad_state_rows|reader_academy_md5|reader_overview_md5)=.*|EAS [0-9a-f]{64}|EDE [0-9a-f]{64})$' "$f"; then
    die "manifest ($tag): contains an unknown or malformed line"; fi
  # fingerprints unique + cardinality equals the declared counts (snapshot-consistent)
  easN="$(grep -c '^EAS ' "$f" || true)"; edeN="$(grep -c '^EDE ' "$f" || true)"
  easU="$(grep '^EAS ' "$f" | sort -u | grep -c . || true)"; edeU="$(grep '^EDE ' "$f" | sort -u | grep -c . || true)"
  easRows="$(sed -n 's/^EV eas_rows=//p' "$f")"; edeRows="$(sed -n 's/^EV ede_rows=//p' "$f")"
  [[ "$easN" -eq "$easU" ]] || die "manifest ($tag): duplicate EAS fingerprints ($easN lines, $easU unique)"
  [[ "$edeN" -eq "$edeU" ]] || die "manifest ($tag): duplicate EDE fingerprints ($edeN lines, $edeU unique)"
  [[ "$easN" -eq "$easRows" ]] || die "manifest ($tag): EAS fingerprint count $easN != eas_rows $easRows (incomplete capture)"
  [[ "$edeN" -eq "$edeRows" ]] || die "manifest ($tag): EDE fingerprint count $edeN != ede_rows $edeRows (incomplete capture)"
  local badRows; badRows="$(sed -n 's/^EV eas_bad_state_rows=//p' "$f")"
  [[ "$badRows" -le "$easRows" ]] || die "manifest ($tag): eas_bad_state_rows $badRows > eas_rows $easRows (impossible)"
  ok "manifest ($tag): complete + snapshot-consistent ($easN EAS, $edeN EDE)"
}

# CONCURRENCY-SAFE no-loss proof: every pre-existing address key + event id must
# still exist post-migration; NEW rows are allowed (a pre-gate send finishing or
# a Resend webhook inserting during the window is legitimate). Reader
# fingerprints MUST change; counts/state distribution are EVIDENCE only.
assert_manifest_no_loss() { # $1 pre  $2 post
  local pre="$1" post="$2" lost k vpre vpost
  validate_manifest "$pre" pre; validate_manifest "$post" post
  lost="$(comm -23 <(grep '^EAS ' "$pre" | sort -u) <(grep '^EAS ' "$post" | sort -u) | head -3)"
  [[ -z "$lost" ]] || die "NO-LOSS VIOLATED: email_address_state key(s) missing post-migration (fingerprint: $(echo "$lost" | tr '\n' ' '))"
  lost="$(comm -23 <(grep '^EDE ' "$pre" | sort -u) <(grep '^EDE ' "$post" | sort -u) | head -3)"
  [[ -z "$lost" ]] || die "NO-LOSS VIOLATED: email_delivery_events id(s) missing post-migration"
  ok "no-loss: every pre-existing address key + event id still present (new rows allowed)"
  for k in reader_academy_md5 reader_overview_md5; do   # MUST change (re-emit)
    vpre="$(sed -n "s/^EV ${k}=//p" "$pre")"; vpost="$(sed -n "s/^EV ${k}=//p" "$post")"
    [[ "$vpre" != "$vpost" ]] || die "reader $k unchanged (re-emit missing)"
    ok "reader changed: $k"
  done
  ok "evidence: eas_rows $(sed -n 's/^EV eas_rows=//p' "$pre")->$(sed -n 's/^EV eas_rows=//p' "$post"), bad_state $(sed -n 's/^EV eas_bad_state_rows=//p' "$pre")->$(sed -n 's/^EV eas_bad_state_rows=//p' "$post") (evidence only)"
}

# The deployed commit must equal the reviewed+tested pin (no SHA drift).
assert_sha_matches_pin() {
  local actual="$1" pin="$2" label="${3:-head}"
  [[ "$actual" =~ ^[0-9a-f]{40}$ ]] || die "$label sha is not 40-hex: '$actual'"
  [[ "$pin"    =~ ^[0-9a-f]{40}$ ]] || die "pin sha is not 40-hex: '$pin'"
  [[ "$actual" == "$pin" ]] || die "$label SHA ${actual:0:12} != reviewed pin ${pin:0:12} — refusing (SHA drift)"
  ok "$label SHA matches reviewed pin ${pin:0:12}"
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
# libpq ENVIRONMENT identity — the hole underneath every url guard
# ---------------------------------------------------------------------------
# assert_conn_url_is_ref validates the URL. libpq does not connect using only the
# URL. Every psql process inherits the PG* environment, and several of those
# variables decide WHICH SERVER is reached, independently of anything in the URI:
#
#   PGHOSTADDR    a SEPARATE libpq parameter from `host`. When set, it supplies the
#                 IP directly and the URI's host is used only for SNI/auth — so an
#                 expected-ref URL passes every string check and connects elsewhere.
#   PGSERVICE     names a stanza in pg_service.conf; the stanza supplies any
#                 parameter the URI did not, INCLUDING hostaddr.
#   PGSYSCONFDIR  chooses which pg_service.conf is read.
#   PGOPTIONS     goes through as `-c` runtime options — a search_path here silently
#                 re-points every unqualified `public.` reference in the artifacts.
#
# So the rule is structural, not advisory: identity-affecting PG* variables are
# REMOVED from the psql child's environment (psql_safe below), and any PG*
# variable we do not recognise at all stops the run — an unknown one may well be
# a newer identity parameter, and guessing is the failure mode this exists to
# prevent.
#
# Not on the deny list, deliberately: PGPASSWORD/PGPASSFILE are how the operator
# supplies the password (never on the command line), and they cannot redirect a
# connection.
LIBPQ_ENV_DENY=(
  PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGSERVICE PGSERVICEFILE PGSYSCONFDIR
  PGOPTIONS PGTARGETSESSIONATTRS PGREQUIREPEER PGCHANNELBINDING PGGSSENCMODE
  PGGSSLIB PGKRBSRVNAME PGLOADBALANCEHOSTS PGCONNECT_TIMEOUT
)
LIBPQ_ENV_ALLOW=(
  PGPASSWORD PGPASSFILE PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY PGSSLCRL
  PGSSLNEGOTIATION PGAPPNAME PGCLIENTENCODING PGTZ PGDATESTYLE
)

# Refuse any exported PG* variable that is on neither list. Only NON-EMPTY values
# are considered set, because libpq treats an empty value as absent.
#
# FAIL-CLOSED BY CONSTRUCTION: this reads names out of `env`, and a value
# containing a newline can only ADD an apparent name (which we would refuse), never
# hide a real one — every variable's own line begins with its own name.
assert_no_hostile_libpq_env() {
  local name bad=() n
  while IFS= read -r name; do
    [[ -n "${!name:-}" ]] || continue                 # empty == unset, to libpq
    for n in "${LIBPQ_ENV_DENY[@]}" "${LIBPQ_ENV_ALLOW[@]}"; do
      [[ "$name" == "$n" ]] && continue 2
    done
    bad+=("$name")
  done < <(env | sed -n 's/^\(PG[A-Z0-9_]*\)=.*/\1/p' | sort -u)
  [[ "${#bad[@]}" -eq 0 ]] || die \
    "unrecognised libpq environment variable(s) set: ${bad[*]} — refusing, because an unknown PG* variable may redirect the connection and the EXPECTED_REF check only validates the URL. Unset them and re-run."
  # Warn about the ones we strip, so an operator whose environment was going to
  # redirect the connection finds out rather than wondering why a port changed.
  for n in "${LIBPQ_ENV_DENY[@]}"; do
    if [[ -n "${!n:-}" ]]; then
      warn "$n is set and is being REMOVED from the psql environment (it can override the connection target; put everything the connection needs in the url)"
    fi
  done
  return 0
}

# THE ONLY WAY THIS BUNDLE SHOULD INVOKE psql. Strips every identity-affecting PG*
# variable from the child, and disables ~/.psqlrc — a psqlrc runs before the
# artifact and can \set variables the artifact reads or issue statements of its own.
#
# `env -u` and a plain loop, not `mapfile`: bash 3.2 is the operator platform
# (macOS /bin/bash) and has neither mapfile nor associative arrays.
psql_safe() {
  require_cmd psql
  local unset_args=() n
  for n in "${LIBPQ_ENV_DENY[@]}"; do unset_args+=(-u "$n"); done
  env "${unset_args[@]}" psql --no-psqlrc "$@"
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
  psql_safe "$url" -v ON_ERROR_STOP=1 -q -f "$file" "$@" \
    || die "SQL artifact failed (non-zero psql exit): $file"
  ok "$(basename "$file") passed"
}

# Bounded diagnostic rendering that CANNOT alter control flow.
#
# `grep ... | head -N >&2` looks harmless and is not: under `set -Eeuo pipefail`
# a zero-match grep fails the pipeline, and `head` closing early can SIGPIPE the
# producer. Either can abort before the caller returns the ORIGINAL status or
# cleans up its capture — and one of these sits in the production recovery path.
#
# This reads the file with the shell only, prints at most $2 matching lines to
# stderr, and ALWAYS returns 0. (mutation-pinned: verify/exit-status-test.sh)
render_diag() {   # $1 file, $2 max lines, $3 optional prefix
  local f="${1:-}" max="${2:-6}" prefix="${3:-}" n=0 line
  [[ -n "$f" && -r "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ERROR*|error*|psql:*|FATAL*|NOTICE*|WARNING*)
        printf '%s%s\n' "$prefix" "$line" >&2
        n=$((n + 1))
        [[ "$n" -ge "$max" ]] && break
        ;;
    esac
  done < "$f"
  [[ "$n" -eq 0 ]] && printf '%s(no diagnostic lines in %s)\n' "$prefix" "${f##*/}" >&2
  return 0
}

# Non-fatal variant of run_sql: RETURNS the psql exit status instead of exiting.
# Required wherever a failure must trigger a compensating action (e.g. restoring
# production cron) — `die` would exit the shell before the handler could run,
# even on the left of `||`.
run_sql_soft() {
  local url="$1" file="$2"; shift 2
  require_cmd psql
  [[ -f "$file" ]] || { warn "sql file not found: $file"; return 1; }
  local rc=0
  psql_safe "$url" -v ON_ERROR_STOP=1 -q -f "$file" "$@" || rc=$?
  return "$rc"
}

