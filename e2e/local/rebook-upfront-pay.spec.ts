import { test, expect, request as pwRequest } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/**
 * LAUNCH money-path test: a group captain who is NOT logged in triggers the upfront group pay
 * (create-group-rebook-invoice) and gets ONE invoice at the FULL COURT price for the whole cycle,
 * with NO split — the owner-confirmed model (price_per_session is per-court; €20 × 2 sessions = €40).
 *
 * Prerequisites (a fresh seed + the edge functions served): run `npm run e2e:local:paid`, which
 * seeds and starts scripts/db/edge-serve-local.sh before this spec. Local demo keys below are public.
 */
const SB = 'http://127.0.0.1:54321';
const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const CAPTAIN_TOKEN = 'seed-claim-up-a0-s0-p1';
const EXPECTED_COURT_TOTAL = 40; // per-court €20 × 2 sessions, no split (owner-confirmed)

test('upfront group-captain (logged-out) mints ONE full-court invoice, no split', async () => {
  const ctx = await pwRequest.newContext();
  const res = await ctx.post(`${SB}/functions/v1/create-group-rebook-invoice`, {
    headers: { Authorization: `Bearer ${ANON}`, apikey: ANON, 'Content-Type': 'application/json' },
    data: { token: CAPTAIN_TOKEN },
  });
  const body = await res.json();
  // Logged-out captain succeeds (verify_jwt=false, token-gated) and an invoice is minted.
  expect(body.ok, `unexpected: ${JSON.stringify(body)}`).toBe(true);
  expect(body.invoiceId).toBeTruthy();
  await ctx.dispose();

  // The invoice is the FULL court price for the whole cycle — one payment, no split.
  const svc = createClient(SB, SVC, { auth: { persistSession: false } });
  const { data: inv, error } = await svc.from('invoices').select('total, status').eq('id', body.invoiceId).single();
  expect(error).toBeNull();
  expect(Number(inv!.total)).toBe(EXPECTED_COURT_TOTAL);
  expect(inv!.status).toBe('sent');
});
