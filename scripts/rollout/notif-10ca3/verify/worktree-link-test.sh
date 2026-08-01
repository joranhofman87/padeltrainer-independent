#!/usr/bin/env bash
# ===========================================================================
# worktree-link-test.sh — the rollout WORKTREE must establish and verify its OWN
# pooler link before any `supabase db push --linked`.
#
# The defect: `supabase/.temp/` is gitignored, so `git worktree add` never
# carries it into the detached rollout worktree. The CLI there found no pooler
# metadata and fell back to the DIRECT host db.<ref>.supabase.co, which resolves
# IPv6-only — step 7 failed with "IPv6 is not supported on your current network"
# even though the ordinary checkout was correctly linked. Linking the ordinary
# checkout cannot help: dryrun615 / apply615 / resume615 each build a FRESH
# worktree that inherits none of it, so apply615 would have hit the same wall
# after entering its rollout sequence.
#
# No network, no production: supabase/gh/git/psql/curl/date/sleep are stubbed.
# Run: bash scripts/rollout/notif-10ca3/verify/worktree-link-test.sh
# ===========================================================================
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RR="$HERE/../run-rollout.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"; rm -f "$HERE/../.mutant-"*.sh' EXIT

P=0; F=0
pass(){ P=$((P+1)); echo "  PASS  $*"; }
fail(){ F=$((F+1)); echo "  FAIL  $*"; }

REF=ficwbdrzefmblkbkomzw
export REF
V1=20261006100000; V2=20261006110000; V3=20261006120000
export V1 V2 V3
PROD="postgresql://postgres@db.${REF}.supabase.co:5432/postgres?sslmode=require"
BIN="$ROOT/bin"; mkdir -p "$BIN"; export STATEDIR="$ROOT/state"; mkdir -p "$STATEDIR"

# --- stubs ------------------------------------------------------------------
# `git worktree add` materialises the pinned tree WITHOUT .temp — the whole point.
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
# the real code calls `git -C "$WT" status ...`; skip a leading -C <path>
if [[ "${1:-}" == "-C" ]]; then shift 2; fi
case "$1" in
  fetch|cat-file) exit 0;;
  rev-parse) echo 0000000000000000000000000000000000000000; exit 0;;
  worktree)
    if [[ "$2" == add ]]; then wt="$4"; mkdir -p "$wt/supabase/migrations"
      printf 'project_id = "%s"\n' "$REF" > "$wt/supabase/config.toml"
      for v in "$V1" "$V2" "$V3"; do printf -- '-- m\n' > "$wt/supabase/migrations/${v}_name.sql"; done
      echo "$wt" >> "$STATEDIR/worktrees"
      exit 0; fi
    if [[ "$2" == remove ]]; then for a in "$@"; do [[ -d "$a" && "$a" == *rollout-wt-* ]] && rm -rf "$a"; done; exit 0; fi;;
  status)
    # tracked-file dirtiness is simulated per-run
    [[ "$(cat "$STATEDIR/TRACKED_DIRTY" 2>/dev/null)" == 1 ]] && echo " M supabase/config.toml"
    exit "$(cat "$STATEDIR/GIT_STATUS_RC" 2>/dev/null || echo 0)";;
esac
exit 0
EOF
# `supabase link` writes .temp per LINK_MODE; `db push --linked` REFUSES unless
# valid pooler metadata already exists in the CWD — proving the ordering.
cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == link ]]; then
  echo "link $*" >> "$STATEDIR/link_calls"
  echo "$PWD"   >> "$STATEDIR/link_cwd"
  printf '%s ' "$@" >> "$STATEDIR/link_argv"; echo >> "$STATEDIR/link_argv"
  rc="$(cat "$STATEDIR/LINK_RC" 2>/dev/null || echo 0)"
  [[ -n "${LINK_STDERR:-}" ]] && printf '%s\n' "$LINK_STDERR" >&2
  [[ "$rc" != 0 ]] && exit "$rc"
  m="$(cat "$STATEDIR/LINK_MODE" 2>/dev/null || echo good)"
  t="$PWD/supabase/.temp"
  if [[ "$m" == tempsymlink ]]; then
    a="$STATEDIR/ambient-temp"; mkdir -p "$a"
    printf '%s' "$REF" > "$a/project-ref"
    printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$a/pooler-url"
    rm -rf "$t"; mkdir -p "$(dirname "$t")"; ln -s "$a" "$t"; exit 0
  fi
  mkdir -p "$t"
  printf '%s' "$REF" > "$t/project-ref"
  case "$m" in
    good)        printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$t/pooler-url";;
    port6543)    printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:6543/postgres' "$REF" > "$t/pooler-url";;
    nopooler)    rm -f "$t/pooler-url";;
    symlink)     printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$t/real-url"; ln -sf "$t/real-url" "$t/pooler-url";;
    direct)      printf 'postgresql://postgres.%s@db.%s.supabase.co:5432/postgres' "$REF" "$REF" > "$t/pooler-url";;
    credential)  printf 'postgresql://postgres.%s:SUPERSECRETPW@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$t/pooler-url";;
    wronguser)   printf 'postgresql://postgres@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' > "$t/pooler-url";;
    badport)     printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:9999/postgres' "$REF" > "$t/pooler-url";;
    badhost)     printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.evil.com:5432/postgres' "$REF" > "$t/pooler-url";;
    wrongref)    printf 'zzzzzzzzzzzzzzzzzzzz' > "$t/project-ref"
                 printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$t/pooler-url";;
    noref)       rm -f "$t/project-ref"
                 printf 'postgresql://postgres.%s@aws-1-eu-central-1.pooler.supabase.com:5432/postgres' "$REF" > "$t/pooler-url";;
  esac
  [[ "$(cat "$STATEDIR/LINK_DIRTIES_TRACKED" 2>/dev/null)" == 1 ]] && echo 1 > "$STATEDIR/TRACKED_DIRTY"
  exit 0
fi
if [[ "$1" == db && "$2" == push ]]; then
  if printf '%s ' "$@" | grep -q -- '--db-url'; then :; else
    # a LINKED push requires pooler metadata in this working directory
    if [[ ! -f "$PWD/supabase/.temp/pooler-url" ]]; then
      echo "IPv6 is not supported on your current network: dial tcp [2a05::1]:5432: connect: no route to host" >&2
      echo "Run supabase link --project-ref $REF to setup IPv4 connection." >&2
      exit 1
    fi
  fi
  echo "$PWD" >> "$STATEDIR/push_cwd"
  if printf '%s ' "$@" | grep -q -- '--dry-run'; then
    cur=",$(cat "$STATEDIR/ledger" 2>/dev/null),"
    for v in "$V1" "$V2" "$V3"; do case "$cur" in *",$v,"*) : ;; *) printf '  %s_name.sql\n' "$v" >&2;; esac; done
    exit 0
  fi
  printf '%s,%s,%s' "$V1" "$V2" "$V3" > "$STATEDIR/ledger"; echo "Finished supabase db push."; exit 0
fi
if [[ "$1" == secrets ]]; then
  [[ "$2" == unset ]] && echo off > "$STATEDIR/gate"; [[ "$2" == set ]] && echo on > "$STATEDIR/gate"; exit 0
fi
if [[ "$1" == functions ]]; then echo "functions $*" >> "$STATEDIR/fn_calls"; exit 0; fi
exit 0
EOF
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == pr && "$2" == view ]]; then
  grep -q headRefOid <<<"$*"  && { cat "$STATEDIR/pin" 2>/dev/null; exit 0; }
  grep -q mergeCommit <<<"$*" && { cat "$STATEDIR/pin" 2>/dev/null; exit 0; }
  grep -q '\.state'   <<<"$*" && { echo MERGED; exit 0; }
  exit 0
fi
exit 0
EOF
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q -- '-Atqc'; then cat "$STATEDIR/ledger" 2>/dev/null; echo; exit 0; fi
exit 0
EOF
chmod +x "$BIN"/*
source "$HERE/../PINS.env"
printf '%s' "$PR615_SHA" > "$STATEDIR/pin"

reset_state(){ rm -f "$STATEDIR"/{link_calls,link_cwd,link_argv,push_cwd,worktrees,TRACKED_DIRTY,LINK_RC,LINK_DIRTIES_TRACKED,manifest_n,GIT_STATUS_RC}
  rm -rf "$STATEDIR/ambient-temp"
  printf 'good' > "$STATEDIR/LINK_MODE"; printf '' > "$STATEDIR/ledger"; }
run_dryrun(){ ( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' \
    bash "$RR" dryrun615 ) >"$ROOT/out.txt" 2>&1; }
links(){ [[ -f "$STATEDIR/link_calls" ]] && wc -l < "$STATEDIR/link_calls" | tr -d ' ' || echo 0; }
pushes(){ [[ -f "$STATEDIR/push_cwd" ]] && wc -l < "$STATEDIR/push_cwd" | tr -d ' ' || echo 0; }

echo "== the detached worktree starts WITHOUT .temp (the root cause) =="
reset_state
( PATH="$BIN:$PATH" bash -c "
  source '$HERE/../lib/common.sh'; EXPECTED_REF='$REF'
  WT=\"\$(mktemp -d -t rollout-wt-XXXX)\"; git worktree add --detach \"\$WT\" deadbeef >/dev/null 2>&1
  [[ -e \"\$WT/supabase/.temp\" ]] && echo HAS_TEMP || echo NO_TEMP
  rm -rf \"\$WT\"" ) > "$ROOT/wt.txt" 2>&1
grep -q NO_TEMP "$ROOT/wt.txt" && pass "a fresh detached worktree has NO supabase/.temp (so the CLI would use the direct IPv6 host)" || fail "worktree unexpectedly had .temp"
grep -q 'supabase/.temp' "$HERE/../../../../.gitignore" && pass "supabase/.temp is gitignored — it can never be inherited by a worktree" || fail ".temp not gitignored"

echo "== dryrun615 links the worktree, then pushes =="
reset_state; run_dryrun; rc=$?
[[ "$rc" -eq 0 ]] && pass "dryrun615 succeeds once the worktree is linked (exit 0)" || fail "dryrun615 exit=$rc: $(tail -3 "$ROOT/out.txt")"
[[ "$(links)" == 1 ]] && pass "supabase link ran exactly once" || fail "link count $(links)"
[[ "$(cat "$STATEDIR/link_cwd")" == *rollout-wt-* ]] && pass "the link ran INSIDE the rollout worktree, not the ambient checkout" || fail "link cwd $(cat "$STATEDIR/link_cwd")"
grep -q -- "--project-ref $REF" "$STATEDIR/link_argv" && pass "link used --project-ref EXPECTED_REF" || fail "wrong link argv"
grep -qE -- '--password|--skip-pooler' "$STATEDIR/link_argv" && fail "link argv contains --password or --skip-pooler" || pass "link argv has no --password and no --skip-pooler"
grep -q 'stub-not-real' "$STATEDIR/link_argv" && fail "the password appeared in argv" || pass "the password never appears in argv"
grep -q 'worktree linked:' "$ROOT/out.txt" && pass "the verified pooler target is reported (host/port/user, password-free)" || fail "no link confirmation"
[[ "$(pushes)" -ge 1 ]] && pass "db push ran after the link" || fail "no push"

echo "== the push stub REFUSES without pooler metadata (ordering is real) =="
reset_state
MUTNL="$HERE/../.mutant-nolink.sh"
python3 - "$RR" "$MUTNL" <<'PYX'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
old = '  link_worktree_pooler || die "worktree link failed \u2014 the dry run was NOT attempted"\n'
assert s.count(old) == 1, "no-link anchor not unique (%d)" % s.count(old)
open(dst, "w").write(s.replace(old, "", 1))
PYX
grep -q 'the dry run was NOT attempted' "$MUTNL" && fail "mutant sed did not apply" || pass "mutant built: the link stage removed from dryrun615"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' bash "$MUTNL" dryrun615 ) >"$ROOT/m.txt" 2>&1; mrc=$?
[[ "$mrc" -ne 0 ]] && pass "MUTANT (no link) FAILS — this is the observed step-7 failure" || fail "mutant unexpectedly succeeded"
grep -q 'IPv6 is not supported' "$ROOT/m.txt" && pass "MUTANT reproduces the exact IPv6/direct-host diagnostic" || fail "no IPv6 diagnostic"
[[ "$(links)" == 0 ]] && pass "MUTANT never linked" || fail "mutant linked anyway"
rm -f "$MUTNL"

echo "== link failure stops BEFORE any db push =="
reset_state; echo 3 > "$STATEDIR/LINK_RC"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' LINK_STDERR='failed to link: unauthorized' \
  bash "$RR" dryrun615 ) >"$ROOT/out.txt" 2>&1; rc=$?
[[ "$rc" -ne 0 ]] && pass "link failure -> dryrun615 exits nonzero ($rc)" || fail "link failure ignored"
[[ "$(pushes)" == 0 ]] && pass "link failure -> db push was NEVER invoked" || fail "pushed after a failed link"
grep -q 'failed to link: unauthorized' "$ROOT/out.txt" && pass "the link failure diagnostic is surfaced (bounded/redacted)" || fail "link diagnostic swallowed"
grep -q 'stub-not-real' "$ROOT/out.txt" && fail "the password leaked into the link diagnostic" || pass "no password in the link diagnostic"
[[ "$(ls "${TMPDIR:-/tmp}" 2>/dev/null | grep -c 'rollout-link-')" == 0 ]] && pass "the link capture was cleaned up" || fail "link capture stranded"

echo "== every pooler-metadata defect fails closed =="
for m in nopooler symlink direct credential wronguser badport badhost wrongref noref; do
  reset_state; printf '%s' "$m" > "$STATEDIR/LINK_MODE"
  run_dryrun; rc=$?
  [[ "$rc" -ne 0 ]] && pass "pooler metadata '$m' -> refused (exit $rc)" || fail "'$m' was accepted"
  [[ "$(pushes)" == 0 ]] && pass "pooler metadata '$m' -> db push never invoked" || fail "'$m' reached a push"
done
reset_state; printf 'port6543' > "$STATEDIR/LINK_MODE"; run_dryrun
[[ $? -eq 0 ]] && pass "port 6543 (transaction pooler) is accepted" || fail "6543 rejected"

echo "== a link that dirties TRACKED files is refused =="
reset_state; echo 1 > "$STATEDIR/LINK_DIRTIES_TRACKED"
run_dryrun; rc=$?
[[ "$rc" -ne 0 ]] && pass "link mutating tracked worktree files -> refused" || fail "tracked mutation accepted"
[[ "$(pushes)" == 0 ]] && pass "tracked mutation -> db push never invoked" || fail "pushed despite a dirty tracked tree"

echo "== the ambient checkout's .temp is never trusted =="
reset_state
MUTAMB="$HERE/../.mutant-ambient.sh"
python3 - "$RR" "$MUTAMB" <<'PYX'
import sys
src,dst=sys.argv[1],sys.argv[2]
s=open(src).read()
old='  ( cd "$WT" && NO_COLOR=1 supabase link --project-ref "$EXPECTED_REF" ) >"$cap" 2>&1 || rc=$?'
new='  mkdir -p "$WT/supabase/.temp" && cp -R supabase/.temp/. "$WT/supabase/.temp/" 2>/dev/null; rc=0'
assert s.count(old)==1
open(dst,"w").write(s.replace(old,new,1))
PYX
grep -q 'cp -R supabase/.temp' "$MUTAMB" && pass "mutant built: copies the ambient .temp instead of linking" || fail "ambient mutant not applied"
# run it from a decoy checkout with NO ambient .temp to copy: a copy is not a
# link, and asserting only "link count 0" would not prove the run is blocked.
DECOY="$ROOT/decoy"; mkdir -p "$DECOY/supabase"
( cd "$DECOY" && PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' bash "$MUTAMB" dryrun615 ) >"$ROOT/amb.txt" 2>&1; ambrc=$?
[[ "$(links)" == 0 ]] && pass "MUTANT (ambient copy) performs NO link" || fail "ambient mutant still linked"
[[ "$ambrc" -ne 0 ]] && pass "MUTANT (ambient copy) FAILS end to end (exit $ambrc) — a copy is not a link" || fail "ambient mutant succeeded"
[[ "$(pushes)" == 0 ]] && pass "MUTANT (ambient copy) never reached a db push" || fail "ambient mutant pushed"
rm -f "$MUTAMB"

echo "== the link must come BEFORE the dry run =="
reset_state
MUTORD="$HERE/../.mutant-order.sh"
python3 - "$RR" "$MUTORD" <<'PYX'
import sys
src,dst=sys.argv[1],sys.argv[2]
s=open(src).read()
old='''  link_worktree_pooler || die "worktree link failed — the dry run was NOT attempted"
  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"'''
new='''  ( cd "$WT"; export SUPABASE_PROJECT_ID="$EXPECTED_REF"'''
assert s.count(old)==1
s=s.replace(old,new,1)
old2='''  ok "dry run verified: exactly $V1,$V2,$V3 pending"'''
new2='''  link_worktree_pooler || die "worktree link failed"
  ok "dry run verified: exactly $V1,$V2,$V3 pending"'''
assert s.count(old2)==1
open(dst,"w").write(s.replace(old2,new2,1))
PYX
grep -q 'link_worktree_pooler || die "worktree link failed"' "$MUTORD" && pass "mutant built: link moved AFTER the dry run" || fail "order mutant not applied"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' bash "$MUTORD" dryrun615 ) >"$ROOT/mo.txt" 2>&1; morc=$?
[[ "$morc" -ne 0 ]] && pass "MUTANT (link after the dry run) FAILS — ordering is load-bearing" || fail "order mutant succeeded"
grep -q 'IPv6 is not supported' "$ROOT/mo.txt" && pass "MUTANT (link after) hits the direct-host failure" || fail "no IPv6 failure in the order mutant"
rm -f "$MUTORD"

echo "== a FAILED git status is not 'clean' =="
reset_state; echo 17 > "$STATEDIR/GIT_STATUS_RC"
run_dryrun; rc=$?
[[ "$rc" -ne 0 ]] && pass "git status exit 17 with empty output -> refused (exit $rc)" || fail "a failed git status read as a clean tree"
[[ "$(pushes)" == 0 ]] && pass "git status failure -> db push never invoked" || fail "pushed after an undetermined tracked-file status"
grep -q 'could not determine tracked-file status' "$ROOT/out.txt" && pass "the git failure is named explicitly" || fail "no diagnostic for the git failure"
MUTGS="$HERE/../.mutant-gitstatus.sh"
python3 - "$RR" "$MUTGS" <<'PYX'
import sys
src,dst=sys.argv[1],sys.argv[2]
s=open(src).read()
old='  dirty="$(git -C "$WT" status --porcelain --untracked-files=no)" || grc=$?'
new='  dirty="$(git -C "$WT" status --porcelain --untracked-files=no)" || true'
assert s.count(old)==1
open(dst,"w").write(s.replace(old,new,1))
PYX
grep -q 'untracked-files=no)" || true' "$MUTGS" && pass "mutant built: git status exit code ignored" || fail "git-status mutant not applied"
reset_state; echo 17 > "$STATEDIR/GIT_STATUS_RC"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' bash "$MUTGS" dryrun615 ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (ignores git status) ACCEPTS an undetermined tree — the status check is load-bearing" || fail "git-status mutant not distinguishable"
rm -f "$MUTGS"

echo "== metadata reached through a SYMLINKED PARENT is refused =="
reset_state; printf 'tempsymlink' > "$STATEDIR/LINK_MODE"
run_dryrun; rc=$?
[[ "$rc" -ne 0 ]] && pass ".temp symlinked to a VALID-looking ambient dir -> refused (exit $rc)" || fail "aliased ambient metadata accepted"
[[ "$(pushes)" == 0 ]] && pass "symlinked .temp -> db push never invoked" || fail "pushed through a symlinked .temp"
grep -q 'symlinked parent' "$ROOT/out.txt" && pass "the symlinked parent is named in the refusal" || fail "no symlinked-parent diagnostic"
MUTSL="$HERE/../.mutant-parentlink.sh"
python3 - "$RR" "$MUTSL" <<'PYX'
import sys
src,dst=sys.argv[1],sys.argv[2]
s=open(src).read()
old='  [[ ! -L "$t" ]] || die "worktree link: .temp is a SYMLINK — refusing metadata reached through a symlinked parent"\n'
assert s.count(old)==1, s.count(old)
open(dst,"w").write(s.replace(old,"",1))
PYX
grep -q '.temp is a SYMLINK' "$MUTSL" && fail "parent-symlink mutant not applied" || pass "mutant built: parent-symlink guard removed"
reset_state; printf 'tempsymlink' > "$STATEDIR/LINK_MODE"
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' bash "$MUTSL" dryrun615 ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (no parent-symlink guard) ACCEPTS aliased ambient metadata — the guard is load-bearing" || fail "parent-symlink mutant not distinguishable"
rm -f "$MUTSL"

echo "== a capture that cannot be destroyed stops the run =="
NOSHRED="$ROOT/noshred"; mkdir -p "$NOSHRED"
printf '#!/usr/bin/env bash\nexit 1\n' > "$NOSHRED/shred"; printf '#!/usr/bin/env bash\nexit 1\n' > "$NOSHRED/gshred"
RMFAIL="$ROOT/rmfail"; mkdir -p "$RMFAIL"
cat > "$RMFAIL/rm" <<'RMEOF'
#!/usr/bin/env bash
for a in "$@"; do case "$a" in *rollout-link-*) echo "rm: Operation not permitted" >&2; exit 1;; esac; done
exec /bin/rm "$@"
RMEOF
chmod +x "$NOSHRED"/shred "$NOSHRED"/gshred "$RMFAIL"/rm
reset_state
( PATH="$RMFAIL:$NOSHRED:$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' \
  bash "$RR" dryrun615 ) >"$ROOT/cf.txt" 2>&1; cfrc=$?
[[ "$cfrc" -ne 0 ]] && pass "successful link + cleanup failure -> refused (exit $cfrc)" || fail "continued after a failed capture cleanup"
[[ "$(pushes)" == 0 ]] && pass "cleanup failure -> validation and db push never reached" || fail "pushed after a failed cleanup"
grep -q 'refusing to continue to validation or any push' "$ROOT/cf.txt" && pass "the cleanup failure is reported clearly" || fail "no cleanup diagnostic"
grep -q 'worktree linked:' "$ROOT/cf.txt" && fail "validation ran despite the cleanup failure" || pass "validation was NOT reached"
reset_state; echo 7 > "$STATEDIR/LINK_RC"
( PATH="$RMFAIL:$NOSHRED:$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' \
  LINK_STDERR='failed to link: unauthorized' bash "$RR" dryrun615 ) >"$ROOT/cf2.txt" 2>&1
grep -q 'exit 7' "$ROOT/cf2.txt" && pass "failed link (7) + cleanup failure: the LINK's code is preserved" || fail "link code lost"
grep -q 'failed to link: unauthorized' "$ROOT/cf2.txt" && pass "the link diagnostic survives a cleanup failure" || fail "link diagnostic lost"
grep -q 'could not be securely deleted' "$ROOT/cf2.txt" && pass "the cleanup failure is ALSO reported" || fail "cleanup failure silent"
[[ "$(pushes)" == 0 ]] && pass "link failure + cleanup failure -> no push" || fail "pushed anyway"
MUTCU="$HERE/../.mutant-cleanupwarn.sh"
python3 - "$RR" "$MUTCU" <<'PYX'
import sys
src,dst=sys.argv[1],sys.argv[2]
s=open(src).read()
old = '  if ! secure_delete "$cap"; then\n'
old += '    warn "the link SUCCEEDED but its capture could not be securely deleted — refusing to continue to validation or any push; remove it by hand"\n'
old += '    return 1\n  fi'
new = '  secure_delete "$cap" || warn "could not securely delete the link capture"'
assert s.count(old)==1, s.count(old)
open(dst,"w").write(s.replace(old,new,1))
PYX
grep -q 'refusing to continue to validation' "$MUTCU" && fail "cleanup mutant not applied" || pass "mutant built: warn-and-continue cleanup restored"
reset_state
( PATH="$RMFAIL:$NOSHRED:$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_DB_PASSWORD='stub-not-real' bash "$MUTCU" dryrun615 ) >/dev/null 2>&1
[[ $? -eq 0 ]] && pass "MUTANT (warn and continue) proceeds to the push after a failed cleanup — stopping is load-bearing" || fail "cleanup mutant not distinguishable"
rm -f "$MUTCU"
/bin/rm -f "${TMPDIR:-/tmp}"/rollout-link-* 2>/dev/null || true

echo "== resume615 links its recovery worktree =="
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
A="$*"
grep -q 'probe=1' <<<"$A" && { [[ "$(cat "$STATEDIR/gate" 2>/dev/null)" == on ]] && echo '{"maintenance":true}' || echo '{"maintenance":false}'; exit 0; }
grep -q 'api.supabase.com' <<<"$A" && { printf '{"result":[{"timestamp":"2026-07-31T13:00:00Z","event_message":"[SEND-INVOICE-EMAIL] event:blocked {\\"invocationId\\":\\"aaaaaaaa-1111-1111-1111-111111111111\\"}"}],"error":null}'; exit 0; }
grep -q 'functions.supabase.co' <<<"$A" && { printf '{"success":false,"error":"invoice_email_maintenance","invocationId":"aaaaaaaa-1111-1111-1111-111111111111"}\n503'; exit 0; }
echo '{}'
EOF
cat > "$BIN/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$BIN/date" <<'EOF'
#!/usr/bin/env bash
args="$*"; base=1000000; cf="$STATEDIR/date_cnt"
if [[ "$args" == *"+%Y"* ]]; then
  n=""; prev=""; for tok in $args; do [[ "$prev" == "-r" ]] && n="$tok"; [[ "$tok" == @* ]] && n="${tok#@}"; prev="$tok"; done
  if [[ -n "$n" && "$n" -ge "$base" ]]; then echo "2026-07-31T13:30:00Z"; else echo "2026-07-31T13:00:00Z"; fi; exit 0
fi
if [[ "$args" == *"+%s"* ]]; then
  if [[ "$args" == *" -f "* || "$args" == *" -d "* ]]; then echo "$base"; exit 0; fi
  c=$(( $(cat "$cf" 2>/dev/null || echo 0) + 1 )); echo "$c" > "$cf"; echo $(( base + c*600 )); exit 0
fi
echo "2026-07-31T13:00:00Z"
EOF
chmod +x "$BIN/curl" "$BIN/sleep" "$BIN/date"
FA="$(printf 'a%.0s' $(seq 64))"; FB="$(printf 'b%.0s' $(seq 64))"
E1="$(printf '1%.0s' $(seq 64))"; E2="$(printf '2%.0s' $(seq 64))"
export FA FB E1 E2
cat > "$BIN/psql" <<'EOF'
#!/usr/bin/env bash
if printf '%s ' "$@" | grep -q -- '-Atqc'; then cat "$STATEDIR/ledger" 2>/dev/null; echo; exit 0; fi
f=""; prev=""; for a in "$@"; do [[ "$prev" == "-f" ]] && f="$a"; prev="$a"; done
if [[ "$f" == *manifest.sql ]]; then
  # the readers MUST differ between the pre and post captures (the migration
  # re-emits them); a counter distinguishes the two calls
  n=$(( $(cat "$STATEDIR/manifest_n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATEDIR/manifest_n"
  echo "EAS $FA"; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E2"
  if [[ "$n" -le 1 ]]; then ra="$(printf 'a%.0s' $(seq 32))"; ro="$(printf 'a%.0s' $(seq 32))"
  else                      ra="$(printf 'b%.0s' $(seq 32))"; ro="$(printf 'c%.0s' $(seq 32))"; fi
  printf 'EV eas_rows=2\nEV ede_rows=2\nEV eas_bad_state_rows=1\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' "$ra" "$ro"
fi
exit 0
EOF
chmod +x "$BIN/psql"
EVID="$ROOT/evidence"; mkdir -p "$EVID"
{ echo "EAS $FA"; echo "EAS $FB"; echo "EDE $E1"; echo "EDE $E2"
  printf 'EV eas_rows=2\nEV ede_rows=2\nEV eas_bad_state_rows=1\nEV reader_academy_md5=%s\nEV reader_overview_md5=%s\n' \
    "$(printf 'a%.0s' $(seq 32))" "$(printf 'a%.0s' $(seq 32))"; } > "$EVID/manifest-pre.txt"
printf 'salt' > "$EVID/manifest-salt.txt"
reset_state; printf '%s' "$V1" > "$STATEDIR/ledger"; printf 'on' > "$STATEDIR/gate"
# resume615 REUSES the original pre-manifest on disk and captures only a POST
# manifest, so its single capture must already return post-migration readers.
echo 1 > "$STATEDIR/manifest_n"
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
  MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD='stub-not-real' CAP_STMT=30000 \
  bash "$RR" resume615 --yes ) >"$ROOT/res.txt" 2>&1; rrc=$?
[[ "$rrc" -eq 0 ]] && pass "resume615 completes with a linked recovery worktree" || fail "resume615 exit=$rrc: $(tail -3 "$ROOT/res.txt")"
[[ "$(links)" == 1 ]] && pass "resume615 linked its recovery worktree exactly once" || fail "resume615 link count $(links)"
[[ "$(cat "$STATEDIR/link_cwd")" == *rollout-wt-* ]] && pass "resume615 linked INSIDE its worktree" || fail "resume615 linked elsewhere"

echo "== apply615 links ONCE and reuses it for both dry runs and the push =="
reset_state
( PATH="$BIN:$PATH" ROLLOUT_EVIDENCE_DIR="$EVID" EXPECTED_REF="$REF" PROD_CONN_URL="$PROD" \
  MANAGER_TOKEN=x SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD='stub-not-real' CAP_STMT=30000 \
  bash "$RR" apply615 --yes ) >"$ROOT/ap.txt" 2>&1; arc=$?
[[ "$arc" -eq 0 ]] && pass "apply615 completes with a linked merge-SHA worktree" || fail "apply615 exit=$arc: $(tail -4 "$ROOT/ap.txt")"
[[ "$(links)" == 1 ]] && pass "apply615 linked exactly ONCE (not per dry run)" || fail "apply615 link count $(links)"
[[ "$(pushes)" -ge 3 ]] && pass "apply615 reused that one link for both dry runs and the real push ($(pushes) CLI pushes)" || fail "apply615 pushes=$(pushes)"
uniq_cwd="$(sort -u "$STATEDIR/push_cwd" | wc -l | tr -d ' ')"
[[ "$uniq_cwd" == 1 ]] && pass "every apply615 push ran in the SAME linked worktree" || fail "$uniq_cwd distinct push cwds"
[[ "$(cat "$STATEDIR/link_cwd")" == "$(head -1 "$STATEDIR/push_cwd")" ]] && pass "the link cwd is exactly the push cwd" || fail "link/push cwd mismatch"

echo "== phase616 and the clone paths do NOT link =="
reset_state
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" SUPABASE_ACCESS_TOKEN=x SUPABASE_DB_PASSWORD='stub-not-real' MANAGER_TOKEN=x \
  bash "$RR" phase616 --yes ) >/dev/null 2>&1
[[ "$(links)" == 0 ]] && pass "phase616 never links (it deploys functions; no linked db push)" || fail "phase616 linked"
reset_state
( PATH="$BIN:$PATH" EXPECTED_REF="$REF" CLONE_REF=zzzzzzzzzzzzzzzzzzzz CAP_STMT=30000 SUPABASE_DB_PASSWORD='stub-not-real' \
  bash "$RR" clone-push --yes "postgresql://postgres@db.zzzzzzzzzzzzzzzzzzzz.supabase.co:5432/postgres" ) >/dev/null 2>&1
[[ "$(links)" == 0 ]] && pass "clone-push never links (it targets --db-url, not the linked project)" || fail "clone-push linked"
sed -n '/^cmd_clone_make_prefix()/,/^}/p' "$RR" | grep -q 'link_worktree_pooler' \
  && fail "clone-make-prefix links" || pass "clone-make-prefix never links"

echo "== static: exactly the three linked paths carry the stage =="
[[ "$(grep -c 'link_worktree_pooler ||' "$RR")" == 3 ]] && pass "exactly 3 call sites (dryrun615, apply615, resume615)" || fail "$(grep -c 'link_worktree_pooler ||' "$RR") call sites"
grep -nE '^[^#]*supabase[^#]*--skip-pooler' "$RR" && fail "--skip-pooler is passed to the CLI" \
  || pass "--skip-pooler is never passed to the CLI (only named in the explanatory comment)"
sed -n '/^link_worktree_pooler()/,/^}/p' "$RR" | grep -q -- '--password' && fail "link uses --password" || pass "link never uses --password"

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
