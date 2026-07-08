#!/usr/bin/env bash
# One command for the FULL local E2E suite, including the money paths. No real Mollie, no real
# money, no real email:
#   1. a mock Mollie (scripts/db/mock-mollie.mjs) on :54999
#   2. the edge functions served with MOLLIE_API_BASE pointed at the mock (supabase/functions/.env.e2e)
#   3. a fresh seed with a stand-in Mollie access token (so academy_mollie_accounts exists)
#   4. the e2e/local Playwright suite (which starts its own vite dev server via the config)
#
# Prereq: `supabase start` + a fresh `supabase db reset`. Run: npm run e2e:local:paid
# The mock + edge serve are torn down on exit (the edge-serve trap also strips its transient ?no-dts).
set -euo pipefail
cd "$(dirname "$0")/../.."

ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'

MOCK_PID=""
EDGE_PID=""
cleanup() {
  # The edge-serve wrapper runs `supabase functions serve` in the FOREGROUND, so a SIGTERM to the
  # wrapper alone can't run its ?no-dts-strip trap until that child dies. Kill the serve child first
  # so the wrapper's trap fires and cleans the tree, then the wrapper + mock. Bound the wait so the
  # command always returns (a hung teardown would read as a CI timeout).
  pkill -TERM -f 'supabase functions serve' 2>/dev/null || true
  [ -n "$EDGE_PID" ] && kill -TERM "$EDGE_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill -TERM "$MOCK_PID" 2>/dev/null || true
  sleep 2
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 1) Mock Mollie (reuse one already running, else start it).
if curl -sf -m 2 http://127.0.0.1:54999/v2/profiles >/dev/null 2>&1; then
  echo "mock-mollie already running on :54999"
else
  node scripts/db/mock-mollie.mjs &
  MOCK_PID=$!
fi

# 2) Edge functions pointed at the mock.
bash scripts/db/edge-serve-local.sh supabase/functions/.env.e2e &
EDGE_PID=$!

# 3) Wait for the edge runtime to answer (400 on an empty body = booted; 503 = still starting).
echo "waiting for edge functions to boot…"
booted=""
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -X POST \
    http://127.0.0.1:54321/functions/v1/create-guest-slot-payment \
    -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true)
  if [ "$code" = "400" ]; then booted="yes"; echo "edge functions up"; break; fi
  sleep 2
done
if [ -z "$booted" ]; then echo "edge functions did not boot in time" >&2; exit 1; fi

# 4) Fresh seed with a stand-in Mollie access token (the mock ignores its value).
MOLLIE_TEST_ACCESS_TOKEN=test_mock npm run db:seed:local

# 5) The full local suite (the config starts its own vite dev server + logs in each role).
npx playwright test --config playwright.local.config.ts "$@"
