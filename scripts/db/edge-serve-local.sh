#!/usr/bin/env bash
# Serve Supabase edge functions against the LOCAL stack for E2E.
#
# The local edge runtime can't build the @supabase/supabase-js TypeScript-types graph from esm.sh
# (it references a storage-js@2.99.1 path that 404s), so functions BOOT_ERROR. Fix: transiently
# append ?no-dts to the supabase-js imports (drops the types header; the runtime JS is identical),
# serve, and strip it again on exit. We do NOT commit ?no-dts because it would strip the types the
# `edge-typecheck` CI gate (deno check) relies on — so it's applied only while serving.
#
# The add/strip use perl (idempotent, portable) and touch ONLY the ?no-dts suffix, so committed
# code (e.g. the MOLLIE_API_BASE seam) and any other WIP are preserved.
#
# Usage: scripts/db/edge-serve-local.sh [env-file]
set -euo pipefail
cd "$(dirname "$0")/../.."

FILES=$(grep -rlE 'esm\.sh/@supabase/supabase-js@' supabase/functions | grep '\.ts$' || true)
strip_nodts() { echo "$FILES" | while read -r f; do [ -n "$f" ] && perl -pi -e 's#(esm\.sh/\@supabase/supabase-js\@[0-9]+(\.[0-9]+)*)\?no-dts"#$1"#g' "$f"; done; }
add_nodts()   { echo "$FILES" | while read -r f; do [ -n "$f" ] && perl -pi -e 's#(esm\.sh/\@supabase/supabase-js\@[0-9]+(\.[0-9]+)*)(\?no-dts)?"#$1?no-dts"#g' "$f"; done; }

trap 'echo "edge-serve-local: removing ?no-dts…"; strip_nodts' EXIT INT TERM
strip_nodts  # clean any leftover from a prior SIGKILL (only touches ?no-dts, nothing else)
add_nodts
echo "edge-serve-local: patched ?no-dts; starting functions serve…"

if [ "${1:-}" != "" ]; then
  supabase functions serve --env-file "$1"
else
  supabase functions serve
fi
