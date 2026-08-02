#!/usr/bin/env bash
# ===========================================================================
# repo-guard-test.sh — STATIC guard against re-introducing the withdrawn design.
#
# ADR-001 withdrew the extension-table fence for two independent reasons:
# Supabase advises against triggers on net.http_request_queue, and DROP TRIGGER
# requires OWNERSHIP of these extension-managed tables (a GRANT TRIGGER yields a
# fence that can be installed and never removed).
#
# The behavioural suites prove the current tooling does not do it. This suite
# proves no FUTURE edit can quietly re-add it, and that the retained-for-review
# copies under sql/withdrawn/ stay unreachable.
#
# Run: bash scripts/rollout/notif-10ca3/verify/repo-guard-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
B="$HERE/.."
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"; rm -f "$HERE/../synth/.pinmutant.mjs"' EXIT
P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

# Everything in the bundle EXCEPT the retained-for-review copies and this suite
# (which necessarily names the forbidden patterns in order to search for them).
# Two files necessarily NAME the forbidden constructs in order to act on them:
# this suite (which searches for them) and the sanitizer (which neutralises them).
# The exemption is explicit and asserted below, not a silent skip.
EXEMPT_BY_DESIGN=(repo-guard-test.sh sanitize-migrations.mjs)
executable_files(){
  find "$B" -type f \( -name '*.sh' -o -name '*.sql' -o -name '*.mjs' -o -name '*.js' \) \
    -not -path '*/sql/withdrawn/*' -not -path '*/evidence/*' \
    -not -name 'repo-guard-test.sh' -not -name 'sanitize-migrations.mjs'
}
# Strip SQL/# comments so prose describing the ban is not mistaken for the ban,
# then COLLAPSE THE FILE TO ONE LINE. A line-oriented grep cannot see
#     CREATE TRIGGER x
#       BEFORE INSERT ON net.http_request_queue
# which is exactly how the withdrawn artifact formats it — so pasting it back
# would have passed. Normalising whitespace first removes that escape hatch.
live_lines(){ sed -e 's/--.*$//' -e 's/^[[:space:]]*#.*$//' "$1" | tr '\n' ' ' | tr -s '[:space:]' ' '; }

echo "== no executable path may fence an extension table =="
hits=0
while IFS= read -r f; do
  live_lines "$f" | grep -qiE 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(CONSTRAINT[[:space:]]+)?TRIGGER[^;]*[[:space:]]ON[[:space:]]+net\.http_request_queue' \
    && { fail "creates a trigger on net.http_request_queue: ${f#$B/}"; hits=$((hits+1)); }
done < <(executable_files)
[[ "$hits" -eq 0 ]] && pass "no executable file creates a trigger on net.http_request_queue (Supabase advises against it)"

hits=0
while IFS= read -r f; do
  live_lines "$f" | grep -qiE 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(CONSTRAINT[[:space:]]+)?TRIGGER[^;]*[[:space:]]ON[[:space:]]+cron\.job[^A-Za-z_]' \
    && { fail "creates a trigger on cron.job: ${f#$B/}"; hits=$((hits+1)); }
done < <(executable_files)
[[ "$hits" -eq 0 ]] && pass "no executable file creates a trigger on cron.job (DROP TRIGGER would need ownership)"

echo "== no executable path may bypass extension-object ownership =="
# pattern<TAB>description — a TAB delimiter, because every pattern below
# legitimately contains regex alternation
while IFS=$'\t' read -r pat desc; do
  [[ -n "$pat" ]] || continue
  hits=0
  while IFS= read -r f; do
    live_lines "$f" | grep -qiE "$pat" && { fail "$desc in ${f#$B/}"; hits=$((hits+1)); }
  done < <(executable_files)
  [[ "$hits" -eq 0 ]] && pass "no executable file contains $desc"
done <<'PATS'
ALTER[[:space:]]+(TABLE|SCHEMA|FUNCTION|EXTENSION|SEQUENCE|VIEW)[^;]*OWNER[[:space:]]+TO	an OWNER TO reassignment
GRANT[^;]*[[:space:]](supabase_admin|pg_monitor)[[:space:]]*(TO|;)	granting membership in a privileged role
DROP[[:space:]]+EXTENSION[[:space:]]+(IF[[:space:]]+EXISTS[[:space:]]+)?(pg_cron|pg_net)	dropping pg_cron or pg_net
CREATE[[:space:]]+EXTENSION[^;]*(pg_cron|pg_net)	creating or recreating pg_cron or pg_net
GRANT[[:space:]]+TRIGGER[[:space:]]+ON[^;]*(cron\.job|net\.http_request_queue)	granting TRIGGER on an extension table
REASSIGN[[:space:]]+OWNED	a REASSIGN OWNED
PATS

echo "== the two by-design exemptions are exactly the two expected files =="
[[ "${#EXEMPT_BY_DESIGN[@]}" -eq 2 ]] && pass "exactly two files are exempt from the pattern scan" || fail "the exemption list has grown"
for f in "${EXEMPT_BY_DESIGN[@]}"; do
  case "$f" in
    repo-guard-test.sh)       pass "exempt: this suite, which must name the patterns to search for them";;
    sanitize-migrations.mjs)  pass "exempt: the sanitizer, which must name them to NEUTRALISE them";;
    *) fail "unexpected exemption: $f";;
  esac
done
# and the sanitizer must only ever REMOVE those statements, never emit one
sed -e 's|//.*$||' "$B/synth/sanitize-migrations.mjs" \
  | grep -qE "(writeFileSync|query|exec)[^)]*CREATE[[:space:]]+EXTENSION" \
  && fail "the sanitizer EMITS a CREATE EXTENSION rather than only matching one" \
  || pass "the sanitizer only matches CREATE EXTENSION; it never emits one"
grep -q 'NEUTRALISED' "$B/synth/sanitize-migrations.mjs" \
  && pass "…and replaces it with a commented, self-describing marker" || fail "no neutralisation marker"

echo "== the withdrawn artifacts are retained but unreachable =="
for f in clone_source_seal.sql clone_source_arm.sql clone_isolation.sql clone_unfence.sql; do
  [[ -f "$B/sql/withdrawn/$f" ]] && pass "retained for review: sql/withdrawn/$f" || fail "missing retained copy: $f"
  [[ ! -f "$B/sql/$f" ]] && pass "…and absent from the executable artifact set" || fail "$f is still executable"
done
hits=0
while IFS= read -r f; do
  live_lines "$f" | grep -q 'withdrawn/' && { fail "references the withdrawn directory: ${f#$B/}"; hits=$((hits+1)); }
done < <(executable_files)
[[ "$hits" -eq 0 ]] && pass "no executable file loads anything from sql/withdrawn/"
[[ -f "$B/sql/withdrawn/README.md" ]] && pass "the withdrawn directory explains itself and links the ADR" || fail "no withdrawn/README.md"

# The nested run below re-invokes this suite; without this flag it would recurse.
if [[ -n "${REPO_GUARD_NESTED:-}" ]]; then
  echo "================  ${P} passed, ${F} failed  ================"
  [[ "$F" -eq 0 ]]; exit
fi

echo "== MUTATION: restore the exact withdrawn artifact into an executable path =="
# The strongest test of this guard is the thing it exists to stop: copy the real
# withdrawn file back, unmodified, and require the guard to fail.
# Restored under its CANONICAL name — the realistic regression is someone moving
# the file back, not renaming it. Each artifact is then caught by whichever rule
# applies to it: the seal by the multi-line CREATE TRIGGER match, the isolation
# gate by "absent from the executable artifact set".
for src in clone_source_seal.sql clone_source_arm.sql clone_isolation.sql clone_unfence.sql; do
  [[ -e "$B/sql/$src" ]] && { fail "$src already exists in sql/ — cannot run the restore mutation"; continue; }
  cp "$B/sql/withdrawn/$src" "$B/sql/$src"
  REPO_GUARD_NESTED=1 bash "$HERE/repo-guard-test.sh" >/dev/null 2>&1; rc=$?
  rm -f "$B/sql/$src"
  [[ "$rc" -ne 0 ]] && pass "restoring sql/withdrawn/$src verbatim into sql/ is CAUGHT" \
                    || fail "the guard MISSED the verbatim withdrawn artifact $src"
done
# and the multi-line form specifically, since that is what a line-oriented grep missed
grep -A2 'CREATE TRIGGER rollout_clone_fence_netq' "$B/sql/withdrawn/clone_source_seal.sql" \
  | grep -q 'ON net.http_request_queue' \
  && pass "the withdrawn artifact really does split CREATE TRIGGER and its ON clause across lines" \
  || fail "the multi-line premise of this test no longer holds"

echo "== the sanitizer is fail-closed against a MOVING main =="
PIN="$B/clone-safety/reviewed-migration-chain.json"
[[ -s "$PIN" ]] && pass "the migration chain is pinned by reviewed digest" || fail "no reviewed-chain pin"
node -e "const p=require('$PIN'); process.exit(/^[0-9a-f]{64}$/.test(p.sha256) && p.files>0 ? 0 : 1)" \
  && pass "…with a well-formed sha256 and file count" || fail "malformed pin"
SAN="$B/synth/sanitize-migrations.mjs"
grep -q 'ALLOWED_EXT' "$SAN" && pass "extensions are an ALLOW-list (an unreviewed one is refused, not ignored)" || fail "extensions are still a deny-list"
grep -q 'stripComments' "$SAN" && pass "patterns are matched on comment-stripped text, so formatting cannot hide a construct" || fail "no comment stripping"
for pat in 'supabase_functions\.http_request' 'extensions\.http_' 'dblink' 'CREATE\\s\+\(FOREIGN\\s\+TABLE\|SERVER' 'schedule_in_database' 'COPY' 'pg_read_'; do
  grep -qE "$pat" "$SAN" && pass "the outbound sweep covers ${pat//\\/}" || fail "sweep misses ${pat//\\/}"
done
# the pin must actually bite
TMPSRC="$ROOT/movingmain"; mkdir -p "$TMPSRC"
cp "$B/../../../supabase/migrations/"*.sql "$TMPSRC/" 2>/dev/null
printf 'SELECT 1;\n' > "$TMPSRC/29990101000000_a_new_migration.sql"
node "$SAN" "$TMPSRC" "$ROOT/sanout" >/dev/null 2>&1
[[ $? -ne 0 ]] && pass "a chain with ONE new migration is REFUSED until it is re-reviewed and re-pinned" || fail "the pin does not bite"
# capture, then match: under `set -o pipefail` the producer's non-zero exit (which
# is the POINT here) would make a successful grep look like a failed pipeline
OUT="$(node "$SAN" "$TMPSRC" "$ROOT/sanout" 2>&1 || true)"
grep -q 'has CHANGED since it was reviewed' <<<"$OUT" \
  && pass "…and says exactly that, with both digests" || fail "no actionable pin message"
grep -q 'reviewed: [0-9a-f]\{64\}' <<<"$OUT" && grep -q 'current : [0-9a-f]\{64\}' <<<"$OUT" \
  && pass "…printing both digests so the reviewer can diff them" || fail "digests not printed"
printf 'CREATE EXTENSION IF NOT EXISTS http;\n' > "$TMPSRC/29990101000001_outbound.sql"
OUT="$(node "$SAN" "$TMPSRC" "$ROOT/sanout" 2>&1 || true)"
grep -q 'unreviewed extension "http"' <<<"$OUT" \
  && pass "an UNREVIEWED outbound extension is named and refused" || fail "unreviewed extension not caught"
printf 'SELECT supabase_functions.http_request();\n' > "$TMPSRC/29990101000002_hook.sql"
OUT="$(node "$SAN" "$TMPSRC" "$ROOT/sanout" 2>&1 || true)"
grep -q 'invokes supabase_functions.http_request' <<<"$OUT" \
  && pass "a top-level supabase_functions.http_request call is refused" || fail "http_request call not caught"
printf 'CREATE /* sneaky */ EXTENSION IF NOT EXISTS dblink;\n' > "$TMPSRC/29990101000003_cmt.sql"
OUT="$(node "$SAN" "$TMPSRC" "$ROOT/sanout" 2>&1 || true)"
grep -q 'unreviewed extension "dblink"' <<<"$OUT" \
  && pass "…and a comment between CREATE and EXTENSION does not hide it" || fail "comment-split CREATE EXTENSION slipped past"
rm -rf "$TMPSRC" "$ROOT/sanout"

echo "== an UNSAFE chain cannot be pinned (pin ordering) =="
TMPSRC="$ROOT/pinorder"; mkdir -p "$TMPSRC"
cp "$B/../../../supabase/migrations/"*.sql "$TMPSRC/" 2>/dev/null
cp "$PIN" "$ROOT/pin.bak"   # a FILE copy: $(cat) strips the trailing newline
printf 'CREATE EXTENSION IF NOT EXISTS http;\n' > "$TMPSRC/29990101000009_unsafe.sql"
OUT="$(node "$SAN" "$TMPSRC" "$ROOT/pinout" --write-pin 2>&1 || true)"
grep -q 'refusing to PIN' <<<"$OUT" && pass "--write-pin REFUSES a chain the sweep found unsafe" || fail "an unsafe chain was pinnable"
grep -q 'PINNED' <<<"$OUT" && fail "it printed PINNED for an unsafe chain" || pass "…and does not print PINNED"
cmp -s "$PIN" "$ROOT/pin.bak" && pass "…and the pin file is untouched, byte for byte" || { fail "the pin file was rewritten"; cp "$ROOT/pin.bak" "$PIN"; }
grep -q 'unreviewed extension "http"' <<<"$OUT" && pass "…naming exactly what made it unsafe" || fail "no reason given"
# the SAFE-but-changed case must still be pinnable, or the flag is useless
printf 'SELECT 1;\n' > "$TMPSRC/29990101000009_unsafe.sql"
OUT="$(node "$SAN" "$TMPSRC" "$ROOT/pinout" 2>&1 || true)"
grep -q 'has CHANGED since it was reviewed' <<<"$OUT" && pass "a SAFE but changed chain still refuses to BUILD until re-pinned" || fail "changed chain built"
# mutation: restore the pre-fix ordering (write before the sweep is consulted)
MUT="$B/synth/.pinmutant.mjs"   # beside the real one: PIN_FILE is resolved relative to the script
python3 - "$SAN" "$MUT" <<'PYX'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
# assembled from chr(10) so no literal newline can appear inside the regex source
nl = chr(10)
pat = "  if \\(unsafeRefusals\\.length\\) \\{[\\s\\S]*?" + nl + "  \\}" + nl
m = re.search(pat, s)
assert m, "guard block not found"
open(dst, "w").write(s[:m.start()] + s[m.end():])
PYX
printf 'CREATE EXTENSION IF NOT EXISTS http;\n' > "$TMPSRC/29990101000009_unsafe.sql"
OUT="$(node "$MUT" "$TMPSRC" "$ROOT/pinout" --write-pin 2>&1 || true)"
grep -q 'PINNED' <<<"$OUT" \
  && pass "MUTANT (safety check removed from --write-pin) PINS an unsafe chain — checking before writing is load-bearing" \
  || fail "pin-ordering mutant not distinguishable"
cp "$ROOT/pin.bak" "$PIN"        # the mutant rewrote it; restore byte-exactly
rm -rf "$TMPSRC" "$ROOT/pinout" "$MUT"
cmp -s "$PIN" "$ROOT/pin.bak" && pass "…and the real pin is restored byte for byte after the mutation" || fail "pin left mutated"

echo "== the synthetic history follows the BACKFILL predicate, not every event =="
GEN="$B/synth/build-baseline.mjs"
grep -q "STATE_PRODUCING = \['sent', 'delivered', 'bounced', 'complained', 'operator_reset'\]" "$GEN" \
  && pass "the generator's state-producing set is exactly the backfill's" || fail "generator predicate drifted"
ADR="$B/docs/ADR-001-clone-safety-fence-withdrawn.md"
grep -q "event_type IN ('sent', 'delivered', 'bounced', 'complained', 'operator_reset')" "$ADR" \
  && pass "…and the sizing query measures the same set" || fail "the sizing histogram counts every event type"
# coupled to the migration itself, so a change there fails here
git -C "$B/../../.." show "$(node -e "process.stdout.write(require('fs').readFileSync('$B/PINS.env','utf8').match(/PR615_SHA=([0-9a-f]{40})/)[1])"):supabase/migrations/20261006100000_email_delivery_concurrency_suppression.sql" 2>/dev/null \
  | grep -q "event_type IN ('sent', 'delivered', 'bounced', 'complained', 'operator_reset')" \
  && pass "…and BOTH match the predicate in the pinned migration itself" || fail "the pinned migration's predicate no longer matches"

echo "== the ADR exists and is referenced from the refusal path =="
ADR="$B/docs/ADR-001-clone-safety-fence-withdrawn.md"
[[ -s "$ADR" ]] && pass "ADR-001 is present" || fail "ADR-001 missing"
grep -q 'webhook-debugging-guide-M8sk47' "$ADR" && pass "ADR cites the Supabase guidance on net.http_request_queue triggers" || fail "ADR does not cite the Supabase source"
grep -q 'DROP TRIGGER' "$ADR" && grep -q 'ownership' "$ADR" && pass "ADR states the CREATE/DROP privilege asymmetry" || fail "ADR omits the privilege asymmetry"
grep -q 'ADR-001-clone-safety-fence-withdrawn.md' "$B/run-rollout.sh" && pass "the refusal points the operator at the ADR" || fail "refusal does not reference the ADR"
grep -q 'Supabase Support' "$ADR" && pass "ADR carries the drafted Supabase Support question" || fail "no Support question drafted"

echo "== the README no longer instructs anyone to run the withdrawn procedure =="
R="$B/README.md"
sed -e 's/^[[:space:]]*>.*$//' "$R" | grep -qE '^\s*run-rollout\.sh clone-source-quiesce' \
  && fail "README still shows clone-source-quiesce as a step to run" \
  || pass "README shows no runnable clone-source-quiesce step"
grep -q 'ADR-001' "$R" && pass "README links the ADR" || fail "README does not link the ADR"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
