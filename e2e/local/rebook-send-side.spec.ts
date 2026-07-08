import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/**
 * Rebook SEND side (local stack): the academy turns a finished weekly cyclus into a NEXT round and
 * the priority invites are minted. bulk-rebook-cycle copies each weekly series forward into a fresh
 * target cycle and mints GROUP-level priority claims (one shared rebook_group_id per series) — the
 * invite records the send step then emails. Locally no RESEND key is set, so the email leg fails
 * gracefully (invitesSent: 0) while the round + claims still commit — that graceful degradation is
 * itself part of what we assert.
 *
 * Also guards the documented IDOR lesson: a plain player must NOT be able to trigger a rebook blast
 * on the academy's cyclus, even though rebook slots are world-readable and a player can read their
 * own claim. Authorization is the academy_managers gate, nothing inferred from readable rows.
 */
const SB = 'http://127.0.0.1:54321';
const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

async function login(ctx: APIRequestContext, email: string): Promise<string> {
  const r = await ctx.post(`${SB}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    data: { email, password: 'Password123!' },
  });
  const j = await r.json();
  expect(j.access_token, `login failed for ${email}: ${JSON.stringify(j)}`).toBeTruthy();
  return j.access_token as string;
}

const svc = () => createClient(SB, SVC, { auth: { persistSession: false } });

test('manager bulk-rebooks a cyclus → next round + priority invites minted', async () => {
  const db = svc();
  const ctx = await pwRequest.newContext();
  const { data: src } = await db.from('cycles').select('id').eq('name', 'Voorjaar 0').eq('type', 'cyclus').single();
  expect(src, 'seeded source cyclus not found').toBeTruthy();

  const token = await login(ctx, 'academy.manager@local.test');
  // A unique name AND a unique future start week per run, so neither the re-run guard (keyed on
  // name+start_date) nor the duplicate-slot overlap trigger (same trainer+time) blocks a repeat run.
  const base = new Date(Date.UTC(2027, 0, 6)); // a Wednesday far in the future
  base.setUTCDate(base.getUTCDate() + (Date.now() % 400) * 7);
  const newStartDate = base.toISOString().slice(0, 10);
  const cycleName = `E2E Rebook ${Date.now()}`;
  const res = await ctx.post(`${SB}/functions/v1/bulk-rebook-cycle`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, 'Content-Type': 'application/json' },
    data: { sourceCyclusId: src!.id, newStartDate, targetCycleName: cycleName },
  });
  const body = await res.json();
  expect(body.ok, `bulk-rebook-cycle: ${JSON.stringify(body)}`).toBe(true);
  expect(body.targetCycleId).toBeTruthy();
  expect(body.groups).toBe(2); // two weekly series in the seeded source cyclus
  expect(body.claimsCreated).toBeGreaterThan(0);
  // No email provider locally → the send leg fails gracefully but the round is still committed.
  expect(body.invitesSent).toBe(0);

  // The invites are minted: every claim on the new round is a PENDING claim carrying a token, and
  // they are grouped one shared rebook_group_id per series (one "Yes" rebooks the whole group).
  const { data: slots } = await db.from('availability_slots').select('id').eq('cyclus_id', body.targetCycleId);
  const slotIds = (slots ?? []).map((s) => s.id);
  expect(slotIds.length).toBe(4);
  const { data: claims } = await db
    .from('slot_priority_claims')
    .select('status, claim_token, rebook_group_id')
    .in('slot_id', slotIds);
  expect((claims ?? []).length).toBe(body.claimsCreated);
  expect((claims ?? []).every((c) => c.status === 'pending' && !!c.claim_token)).toBe(true);
  expect(new Set((claims ?? []).map((c) => c.rebook_group_id)).size).toBe(2);
  await ctx.dispose();
});

test('a player cannot trigger a bulk rebook on the academy cyclus (IDOR guard)', async () => {
  const db = svc();
  const ctx = await pwRequest.newContext();
  const { data: src } = await db.from('cycles').select('id').eq('name', 'Voorjaar 0').eq('type', 'cyclus').single();

  const token = await login(ctx, 'player1.a0@local.test');
  const res = await ctx.post(`${SB}/functions/v1/bulk-rebook-cycle`, {
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, 'Content-Type': 'application/json' },
    data: { sourceCyclusId: src!.id, newStartDate: '2026-09-09', targetCycleName: `E2E Player IDOR ${Date.now()}` },
  });
  expect(res.status(), 'a non-manager must be forbidden from minting a rebook round').toBe(403);
  await ctx.dispose();
});
