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

# libpq takes host / hostaddr / port / user / dbname / service / options from the URI QUERY STRING
# and lets them OVERRIDE the authority — so every one of these names the EXPECTED project in its
# authority and would connect somewhere else. Only sslmode is allow-listed.
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?host=db.wrongwrongwrongwrong.supabase.co"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?hostaddr=203.0.113.10"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?user=postgres.wrongwrongwrongwrong"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?dbname=elsewhere"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?service=other"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?options=-csearch_path%3Devil"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=require&host=db.wrongwrongwrongwrong.supabase.co"
# a percent-encoded KEY must be refused rather than decoded and compared — `%68ost` and `host`
# must not be able to differ here
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?%68ost=db.wrongwrongwrongwrong.supabase.co"
# libpq takes the LAST occurrence, so a duplicate is a way to hide the effective value
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=require&sslmode=disable"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=disable"
ok_case  callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?sslmode=verify-full"
# THE DISCRIMINATOR FOR THE KEY ALLOW-LIST. Every case above is also caught by the sslmode VALUE
# check, so deleting "the key must be sslmode" left them all green. Here the key is an identity
# parameter and the value is a legal sslmode, so only the key rule stops it.
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres?host=require"

# libpq URIs accept a COMMA-SEPARATED host list and FAIL OVER along it. Taking the host before the
# first ':' and the port after the last ':' read this as one valid host on a valid port — while psql
# would try the expected host on a dead port and then connect to the second one.
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:1,attacker.example:5432/postgres"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co,attacker.example/postgres"
bad_case callurl "postgresql://postgres.${REF}:pw@aws-0-eu.pooler.supabase.com:5432,attacker.example:5432/postgres"

# The PATH is the database name, and with the query string constrained it is the only source of one.
# An empty path means "the database named after the user" — a different connection than the one
# being validated.
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432/otherdb"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:5432"
bad_case callurl "postgresql://postgres:pw@db.${REF}.supabase.co:notaport/postgres"

# libpq accepts keyword/value conninfo as well as URIs, and the URI parser reads it wrongly: this
# splits at the first '://' into an authority naming the EXPECTED project, then psql connects to the
# host named later in the same string.
bad_case callurl "dbname=postgresql://postgres@db.${REF}.supabase.co/postgres host=db.wrongwrongwrongwrong.supabase.co"
bad_case callurl "postgres.${REF}:pw@aws-0-eu.pooler.supabase.com:5432/postgres"   # no scheme -> psql reads it as a DBNAME

echo "url_add_query (safe append):"
[[ "$(url_add_query 'https://h/p' k v)"       == 'https://h/p?k=v'      ]] && { P=$((P+1)); echo "  PASS  first param uses ?"; } || { F=$((F+1)); echo "  FAIL first param"; }
[[ "$(url_add_query 'https://h/p?a=1' k v)"   == 'https://h/p?a=1&k=v'  ]] && { P=$((P+1)); echo "  PASS  second param uses &"; } || { F=$((F+1)); echo "  FAIL second param"; }

echo "================  ${P} passed, ${F} failed  ================"
[[ "$F" -eq 0 ]]
