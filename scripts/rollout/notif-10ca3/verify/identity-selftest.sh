#!/usr/bin/env bash
# Executable proof that the EXACT-identity allow-list in lib/common.sh rejects
# substring/look-alike hosts and wrong refs, and accepts only the two legitimate
# address forms. Run: bash scripts/rollout/notif-10ca3/verify/identity-selftest.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../lib/common.sh"

REF="abcdefghijklmnopqrst"   # a valid 20-char ref
P=0; F=0
ok_case()  { if "$@" >/dev/null 2>&1; then P=$((P+1)); echo "  PASS  accept: $*"; else F=$((F+1)); echo "  FAIL  wrongly rejected: $*"; fi; }
bad_case() { if "$@" >/dev/null 2>&1; then F=$((F+1)); echo "  FAIL  wrongly accepted: $*"; else P=$((P+1)); echo "  PASS  reject: $*"; fi; }

# assert_host_user_is_ref runs in a subshell so its die() cannot exit this script
call() { ( assert_host_user_is_ref "$REF" "$1" "$2" ); }
callurl() { ( assert_conn_url_is_ref "$REF" "$1" ); }

echo "host/user allow-list:"
ok_case  call "db.${REF}.supabase.co"                 "postgres"
ok_case  call "aws-0-eu-central-1.pooler.supabase.com" "postgres.${REF}"
bad_case call "db.${REF}.supabase.co.evil.com"        "postgres"      # substring attack
bad_case call "db.${REF}.supabase.co"                 "postgres.evil" # wrong user (direct)
bad_case call "db.wrongwrongwrongwrong.supabase.co"   "postgres"      # wrong ref
bad_case call "aws-0-eu.pooler.supabase.com"          "postgres.wrongwrongwrongwrong"  # pooler wrong ref
bad_case call "aws-0-eu.pooler.supabase.com.evil.io"  "postgres.${REF}"                # pooler suffix spoofed
bad_case call "evil.pooler.supabase.com.attacker.net" "postgres.${REF}"

echo "connection-URL parsing:"
ok_case  callurl "postgresql://postgres:secret@db.${REF}.supabase.co:5432/postgres?sslmode=require"
ok_case  callurl "postgres://postgres.${REF}:pw@aws-0-eu.pooler.supabase.com:6543/postgres"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co.evil.com/postgres"
bad_case callurl "postgresql://postgres.otherotherotherother:pw@aws-0.pooler.supabase.com/postgres"

echo "url_add_query (safe append):"
[[ "$(url_add_query 'https://h/p' k v)"       == 'https://h/p?k=v'      ]] && { P=$((P+1)); echo "  PASS  first param uses ?"; } || { F=$((F+1)); echo "  FAIL first param"; }
[[ "$(url_add_query 'https://h/p?a=1' k v)"   == 'https://h/p?a=1&k=v'  ]] && { P=$((P+1)); echo "  PASS  second param uses &"; } || { F=$((F+1)); echo "  FAIL second param"; }

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
