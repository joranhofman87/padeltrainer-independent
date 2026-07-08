#!/usr/bin/env bash
# Serve Supabase edge functions against the LOCAL stack for E2E.
#
# The local edge runtime can't build the @supabase/supabase-js TypeScript-types graph from esm.sh
# (it references a storage-js@2.99.1 path that 404s), so functions BOOT_ERROR. Fix: transiently
# append ?no-dts to the supabase-js imports (drops the types header; the runtime JS is identical),
# serve, and revert on exit. We do NOT commit ?no-dts because it would strip the types the
# `edge-typecheck` CI gate (deno check) relies on — so it's applied only while serving.
#
# Usage: scripts/db/edge-serve-local.sh [env-file]
#   env-file (optional): passed to `supabase functions serve --env-file` (e.g. for MOLLIE_API_KEY).
set -euo pipefail
cd "$(dirname "$0")/../.."

FILES=$(grep -rlE 'esm\.sh/@supabase/supabase-js@' supabase/functions | grep '\.ts$' || true)
revert() {
  echo "edge-serve-local: reverting ?no-dts patch…"
  echo "$FILES" | while read -r f; do [ -n "$f" ] && git checkout -- "$f" 2>/dev/null || true; done
}
trap revert EXIT INT TERM
# Self-heal: a prior run killed with SIGKILL skips the trap and leaves ?no-dts applied. Revert any
# lingering patch before we start (scoped to the supabase-js importers, so unrelated WIP is safe).
echo "$FILES" | while read -r f; do [ -n "$f" ] && git checkout -- "$f" 2>/dev/null || true; done

# Idempotent: normalise each supabase-js import to exactly one ?no-dts (perl → portable).
echo "$FILES" | while read -r f; do
  [ -n "$f" ] && perl -pi -e 's#(esm\.sh/\@supabase/supabase-js\@[0-9]+(\.[0-9]+)*)(\?no-dts)?"#$1?no-dts"#g' "$f"
done
echo "edge-serve-local: patched ?no-dts on $(echo "$FILES" | grep -c . ) files; starting functions serve…"

if [ "${1:-}" != "" ]; then
  supabase functions serve --env-file "$1"
else
  supabase functions serve
fi
