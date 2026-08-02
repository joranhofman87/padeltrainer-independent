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
P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

# Everything in the bundle EXCEPT the retained-for-review copies and this suite
# (which necessarily names the forbidden patterns in order to search for them).
executable_files(){
  find "$B" -type f \( -name '*.sh' -o -name '*.sql' -o -name '*.mjs' -o -name '*.js' \) \
    -not -path '*/sql/withdrawn/*' -not -path '*/evidence/*' -not -name 'repo-guard-test.sh'
}
# strip SQL/# comments so prose describing the ban is not mistaken for the ban
live_lines(){ sed -e 's/--.*$//' -e 's/^[[:space:]]*#.*$//' "$1"; }

echo "== no executable path may fence an extension table =="
hits=0
while IFS= read -r f; do
  live_lines "$f" | grep -qiE 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(CONSTRAINT[[:space:]]+)?TRIGGER[^;]*\bON[[:space:]]+net\.http_request_queue' \
    && { fail "creates a trigger on net.http_request_queue: ${f#$B/}"; hits=$((hits+1)); }
done < <(executable_files)
[[ "$hits" -eq 0 ]] && pass "no executable file creates a trigger on net.http_request_queue (Supabase advises against it)"

hits=0
while IFS= read -r f; do
  live_lines "$f" | grep -qiE 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?(CONSTRAINT[[:space:]]+)?TRIGGER[^;]*\bON[[:space:]]+cron\.job\b' \
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
