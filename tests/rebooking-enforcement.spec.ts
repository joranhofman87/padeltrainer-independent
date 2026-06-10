/**
 * Integration test for Phase 1 of the priority-rebooking feature:
 * server-side enforcement of slot tier + capacity on the bookings INSERT path.
 *
 * Today bookings are inserted directly from the client and the bookings RLS
 * only checks `player_id = self`. The enforcement migration adds a BEFORE
 * INSERT trigger (`enforce_booking_slot_tier`) that rejects a player
 * self-booking when the slot is still in its priority/member window (and they
 * are not entitled) or when the slot is full.
 *
 * This test exercises that trigger against the live Supabase project, so it is
 * DORMANT until both: (1) the trigger migration is deployed, and (2) it is
 * explicitly enabled via RUN_REBOOKING_ENFORCEMENT=1 with a service-role key.
 * Until then it skips, so it never reds CI before the trigger exists.
 *
 * Run after deploy:
 *   RUN_REBOOKING_ENFORCEMENT=1 \
 *   SUPABASE_SERVICE_ROLE_KEY=... VITE_SUPABASE_URL=... VITE_SUPABASE_PUBLISHABLE_KEY=... \
 *   npx playwright test tests/rebooking-enforcement.spec.ts
 */
import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
const ENABLED =
  process.env.RUN_REBOOKING_ENFORCEMENT === '1' && !!SUPABASE_URL && !!SERVICE_KEY && !!ANON_KEY;

const PASSWORD = 'TestPassword123!';
const stamp = () => `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

type Ctx = {
  admin: SupabaseClient;
  trainerProfileId: string;
  slotId: string;
  playerA: { userId: string; profileId: string; email: string };
  playerB: { userId: string; profileId: string; email: string };
  createdUserIds: string[];
};

async function makeUser(admin: SupabaseClient, role: string) {
  const email = `enf-${role}-${stamp()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  // profile is auto-created by handle_new_user(); fetch its id
  const { data: prof } = await admin
    .from('profiles')
    .select('id')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (!prof?.id) throw new Error('profile not auto-created for user');
  return { userId: data.user.id, profileId: prof.id, email };
}

async function setup(): Promise<Ctx> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const trainerUser = await makeUser(admin, 'trainer');
  const { data: tp, error: tpErr } = await admin
    .from('trainer_profiles')
    .insert({ user_id: trainerUser.userId })
    .select('id')
    .single();
  if (tpErr || !tp) throw new Error(`trainer_profiles insert failed: ${tpErr?.message}`);

  const start = new Date(Date.now() + 7 * 86400_000).toISOString();
  const end = new Date(Date.now() + 7 * 86400_000 + 3600_000).toISOString();
  const priorityEnds = new Date(Date.now() + 3 * 86400_000).toISOString();
  const { data: slot, error: slotErr } = await admin
    .from('availability_slots')
    .insert({
      trainer_id: tp.id,
      start_time: start,
      end_time: end,
      max_participants: 1,
      priority_window_ends_at: priorityEnds,
      price_per_session: 10,
    })
    .select('id')
    .single();
  if (slotErr || !slot) throw new Error(`slot insert failed: ${slotErr?.message}`);

  const playerA = await makeUser(admin, 'playerA');
  const playerB = await makeUser(admin, 'playerB');

  // Player A holds a pending priority claim on the slot.
  const { error: claimErr } = await admin.from('slot_priority_claims').insert({
    slot_id: slot.id,
    player_id: playerA.profileId,
    status: 'pending',
  });
  if (claimErr) throw new Error(`claim insert failed: ${claimErr.message}`);

  return {
    admin,
    trainerProfileId: tp.id,
    slotId: slot.id,
    playerA,
    playerB,
    createdUserIds: [trainerUser.userId, playerA.userId, playerB.userId],
  };
}

async function teardown(ctx: Ctx) {
  await ctx.admin.from('bookings').delete().eq('slot_id', ctx.slotId);
  await ctx.admin.from('slot_priority_claims').delete().eq('slot_id', ctx.slotId);
  await ctx.admin.from('availability_slots').delete().eq('id', ctx.slotId);
  await ctx.admin.from('trainer_profiles').delete().eq('id', ctx.trainerProfileId);
  for (const id of ctx.createdUserIds) {
    await ctx.admin.auth.admin.deleteUser(id).catch(() => {});
  }
}

/** Sign in as a user and return a client scoped to their JWT (so auth.uid() = them). */
async function clientFor(email: string): Promise<SupabaseClient> {
  const c = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`signIn failed: ${error.message}`);
  return c;
}

test.describe('booking tier + capacity enforcement', () => {
  test.skip(!ENABLED, 'Set RUN_REBOOKING_ENFORCEMENT=1 + service-role key after deploying the trigger.');

  let ctx: Ctx;
  test.beforeAll(async () => { ctx = await setup(); });
  test.afterAll(async () => { if (ctx) await teardown(ctx); });

  test('blocks a non-claim-holder from booking a slot in its priority window', async () => {
    const b = await clientFor(ctx.playerB.email);
    const { error } = await b
      .from('bookings')
      .insert({ slot_id: ctx.slotId, player_id: ctx.playerB.profileId, status: 'confirmed' });
    expect(error, 'priority-tier booking by non-claim-holder must be rejected').not.toBeNull();
    expect(`${error?.message}`).toMatch(/priority_restricted|tier|priority/i);
  });

  test('allows the claim-holder to book their priority slot', async () => {
    const a = await clientFor(ctx.playerA.email);
    const { error } = await a
      .from('bookings')
      .insert({ slot_id: ctx.slotId, player_id: ctx.playerA.profileId, status: 'confirmed' });
    expect(error, 'claim-holder should be able to book their own priority slot').toBeNull();
  });

  test('blocks booking a full slot (capacity / overbooking guard)', async () => {
    // Slot capacity is 1 and the claim-holder already took it above.
    const b = await clientFor(ctx.playerB.email);
    const { error } = await b
      .from('bookings')
      .insert({ slot_id: ctx.slotId, player_id: ctx.playerB.profileId, status: 'confirmed' });
    expect(error, 'booking a full slot must be rejected').not.toBeNull();
    expect(`${error?.message}`).toMatch(/full|capacity/i);
  });
});
