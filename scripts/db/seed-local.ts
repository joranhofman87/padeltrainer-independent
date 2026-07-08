/**
 * Local seed for automated testing / manual exploration against the LOCAL Supabase stack.
 *
 *   supabase start && supabase db reset      # fresh schema
 *   npm run db:seed:local                     # this script
 *
 * Creates a realistic academy graph with real auth logins (so Playwright/manual login works),
 * cycles + bookings, and a LIVE rebook round whose priority claims carry DETERMINISTIC tokens —
 * so an invite → claim → accept flow can be driven end-to-end. SEED_SCALE=large adds filler
 * academies + guest players + bookings to surface list/pagination/RLS scale issues.
 *
 * Never run against production — it targets the local stack by default and creates *@local.test
 * users. The local service-role key below is the public Supabase demo key (safe to commit).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const SCALE = process.env.SEED_SCALE || 'small';
const PASSWORD = 'Password123!';

if (!/127\.0\.0\.1|localhost/.test(URL)) {
  console.error(`Refusing to seed a non-local URL: ${URL}`);
  process.exit(1);
}

const admin: SupabaseClient = createClient(URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const iso = (d: Date) => d.toISOString();
const daysFromNow = (n: number, hour = 18) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 0, 0, 0);
  return d;
};
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60000);

async function must<T>(label: string, p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${JSON.stringify(error)}`);
  return data;
}

/** Idempotent: delete any prior seed auth users so a re-run starts clean (domain rows cascade). */
async function purgeSeedUsers() {
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const seeded = data.users.filter((u) => u.email?.endsWith('@local.test'));
    for (const u of seeded) await admin.auth.admin.deleteUser(u.id);
    if (data.users.length < 200) break;
    page += 1;
  }
}

/** Idempotent: delete prior seed DOMAIN rows (academies by slug) in FK-safe order, so a
 *  re-run doesn't collide on the unique academy slug. Auth users are handled separately. */
async function purgeSeedData() {
  const { data: acads } = await admin.from('academy_profiles').select('id').or('slug.eq.test-padel-academy,slug.like.filler-academy-%');
  const acadIds = (acads ?? []).map((a: { id: string }) => a.id);
  if (acadIds.length === 0) return;
  const { data: cyc } = await admin.from('cycles').select('id').in('owner_id', acadIds);
  const cycleIds = (cyc ?? []).map((c: { id: string }) => c.id);
  let slotIds: string[] = [];
  if (cycleIds.length) {
    const { data: slots } = await admin.from('availability_slots').select('id').in('cyclus_id', cycleIds);
    slotIds = (slots ?? []).map((s: { id: string }) => s.id);
  }
  if (slotIds.length) {
    await admin.from('slot_priority_claims').delete().in('slot_id', slotIds);
    await admin.from('bookings').delete().in('slot_id', slotIds);
    await admin.from('availability_slots').delete().in('id', slotIds);
  }
  if (cycleIds.length) await admin.from('cycles').delete().in('id', cycleIds);
  await admin.from('academy_trainers').delete().in('academy_profile_id', acadIds);
  await admin.from('academy_managers').delete().in('academy_profile_id', acadIds);
  await admin.from('academy_mollie_accounts').delete().in('academy_profile_id', acadIds);
  await admin.from('guest_players').delete().in('academy_profile_id', acadIds);
  await admin.from('academy_profiles').delete().in('id', acadIds);
}

async function makeUser(email: string, fullName: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: fullName },
  });
  if (error) throw new Error(`createUser ${email}: ${error.message}`);
  return data.user.id;
}

const firstOf = (name: string) => name.split(' ')[0];

async function seedAcademy(idx: number, withRebookRound: boolean) {
  const tag = idx === 0 ? '' : `${idx}`;
  const managerUid = await makeUser(`academy.manager${tag}@local.test`, `Manager ${idx}`);

  const academy = await must('academy_profiles', admin.from('academy_profiles').insert({
    name: idx === 0 ? 'Test Padel Academy' : `Filler Academy ${idx}`,
    slug: idx === 0 ? 'test-padel-academy' : `filler-academy-${idx}`,
    contact_email: `academy.manager${tag}@local.test`,
    is_public: true, subscription_status: 'active', timezone: 'Europe/Amsterdam',
    created_by: managerUid,
    // Invoice/business details — required so non-draft invoices (the upfront pay path) can mint.
    business_name: idx === 0 ? 'Test Padel Academy B.V.' : `Filler Academy ${idx} B.V.`,
    business_address: 'Sportlaan 1, 1234 AB Amsterdam',
    kvk_number: '12345678', btw_number: 'NL001234567B01',
    iban: 'NL91ABNA0417164300', bic: 'ABNANL2A',
  }).select('id').single());

  await must('academy_managers', admin.from('academy_managers').insert({
    academy_profile_id: academy.id, user_id: managerUid, role: 'owner',
  }).select('user_id').single());

  // Trainers (auth users + profiles + academy link)
  const trainerIds: string[] = [];
  for (let t = 1; t <= 2; t++) {
    const uid = await makeUser(`trainer${t}.a${idx}@local.test`, `Trainer ${t}-${idx}`);
    const tp = await must('trainer_profiles', admin.from('trainer_profiles').insert({
      user_id: uid, is_public: true, hourly_rate: 45, timezone: 'Europe/Amsterdam',
    }).select('id').single());
    await must('academy_trainers', admin.from('academy_trainers').insert({
      academy_profile_id: academy.id, trainer_profile_id: tp.id,
    }).select('academy_profile_id').single());
    trainerIds.push(tp.id);
  }

  // Registered players (auth users + profiles). Guests (no auth).
  const nPlayers = SCALE === 'large' ? 20 : 6;
  const playerIds: string[] = [];
  for (let p = 1; p <= nPlayers; p++) {
    const name = `Player ${p}-${idx}`;
    const uid = await makeUser(`player${p}.a${idx}@local.test`, name);
    // A signup trigger auto-creates the profiles row — UPDATE it rather than insert (avoids a
    // duplicate user_id) and read back its id (what player_id references).
    const prof = await must('profiles', admin.from('profiles').update({
      full_name: name, first_name: firstOf(name), email: `player${p}.a${idx}@local.test`, skill_rating: 3 + (p % 3),
    }).eq('user_id', uid).select('id').single());
    playerIds.push(prof.id);
  }
  const guestRows = Array.from({ length: SCALE === 'large' ? 8 : 3 }, (_, g) => ({
    trainer_id: trainerIds[g % trainerIds.length], academy_profile_id: academy.id,
    full_name: `Guest ${g + 1}-${idx}`, first_name: `Guest`, email: `guest${g + 1}.a${idx}@local.test`, phone: '+31612345678',
  }));
  const guests = await must('guest_players', admin.from('guest_players').insert(guestRows).select('id'));
  const guestIds = guests.map((r: { id: string }) => r.id);

  // Source cycle (currently running) + weekly slots + bookings that fill the seats.
  const sourceCycle = await must('cycles', admin.from('cycles').insert({
    owner_type: 'academy', owner_id: academy.id, name: `Voorjaar ${idx}`, status: 'open',
    price_per_session: 20, start_date: iso(daysFromNow(-56)).slice(0, 10), end_date: iso(daysFromNow(-7)).slice(0, 10),
    settings: {},
  }).select('id').single());

  const nSlots = SCALE === 'large' ? 8 : 4;
  const seatHolders = [...playerIds.map((id) => ({ player_id: id })), ...guestIds.map((id) => ({ guest_player_id: id }))];
  for (let s = 0; s < nSlots; s++) {
    const start = daysFromNow(-49 + s * 7, 18);
    const slot = await must('availability_slots', admin.from('availability_slots').insert({
      trainer_id: trainerIds[s % trainerIds.length], academy_profile_id: academy.id, cyclus_id: sourceCycle.id,
      cyclus_name: sourceCycle ? `Voorjaar ${idx}` : null, start_time: iso(start), end_time: iso(plusMin(start, 90)),
      price_per_session: 20, max_participants: 4, is_public: true,
    }).select('id').single());
    // Seat 4 players/guests per slot (round-robin over the cohort).
    const seats = seatHolders.slice(0, 4).map((who) => ({
      slot_id: slot.id, status: 'confirmed', payment_status: 'paid', payment_amount: 20, paid_at: iso(start), ...who,
    }));
    await must('bookings', admin.from('bookings').insert(seats).select('id'));
  }

  if (!withRebookRound) return { academy: academy.id };

  // ── Rebook round: a NEW cycle whose slots carry pending priority claims with fixed tokens ──
  const newCycle = await must('cycles', admin.from('cycles').insert({
    owner_type: 'academy', owner_id: academy.id, name: `Najaar ${idx} (herboeking)`, status: 'open',
    price_per_session: 20, start_date: iso(daysFromNow(14)).slice(0, 10),
    settings: { rebook_payment_mode: 'deferred_split', rebook_auto_reminder: true },
  }).select('id').single());

  // The cohort that gets first dibs = the seated players/guests. One new-round slot per source slot.
  const invitees = [
    ...playerIds.slice(0, 4).map((id, i) => ({ key: `p${i + 1}`, player_id: id as string | null, guest_player_id: null as string | null })),
    { key: 'g1', player_id: null, guest_player_id: guestIds[0] },
  ];
  const windowEnds = daysFromNow(7, 20); // priority window OPEN for 7 days
  for (let s = 0; s < 2; s++) {
    const start = daysFromNow(14 + s * 7, 18);
    const slot = await must('availability_slots', admin.from('availability_slots').insert({
      trainer_id: trainerIds[s % trainerIds.length], academy_profile_id: academy.id, cyclus_id: newCycle.id,
      cyclus_name: `Najaar ${idx} (herboeking)`, start_time: iso(start), end_time: iso(plusMin(start, 90)),
      price_per_session: 20, max_participants: 4, is_public: false,
      priority_window_ends_at: iso(windowEnds), source_cycle_id: sourceCycle.id,
    }).select('id').single());
    // Deterministic claim tokens: seed-claim-<academyIdx>-<slot>-<invitee>
    const claims = invitees.map((inv) => ({
      slot_id: slot.id, player_id: inv.player_id, guest_player_id: inv.guest_player_id,
      status: 'pending', claim_token: `seed-claim-a${idx}-s${s}-${inv.key}`,
    }));
    await must('slot_priority_claims', admin.from('slot_priority_claims').insert(claims).select('id'));
  }

  // ── UPFRONT rebook round (the LAUNCH scenario): a GROUP of up to 4 shares one court; the first
  //    to respond (the "captain") pays the FULL group price upfront, online, no login, no split.
  //    One shared rebook_group_id over all members × both weekly slots → the claim page shows the
  //    "boek en betaal voor de hele groep" button → create-group-rebook-invoice. Members = 3
  //    registered players + 1 guest (academy-created). Captain token = seed-claim-up-a0-s0-p1. ──
  const upfrontCycle = await must('cycles', admin.from('cycles').insert({
    owner_type: 'academy', owner_id: academy.id, name: `Najaar ${idx} — direct betalen`, status: 'open',
    price_per_session: 20, start_date: iso(daysFromNow(14)).slice(0, 10),
    settings: { rebook_payment_mode: 'upfront', rebook_auto_reminder: true },
  }).select('id').single());
  const upfrontGroupId = randomUUID();
  const upfrontMembers = [
    { key: 'p1', player_id: playerIds[0] as string | null, guest_player_id: null as string | null },
    { key: 'p2', player_id: playerIds[1], guest_player_id: null },
    { key: 'p3', player_id: playerIds[2], guest_player_id: null },
    { key: 'g1', player_id: null, guest_player_id: guestIds[0] },
  ];
  for (let s = 0; s < 2; s++) {
    const start = daysFromNow(21 + s * 7, 19);
    const slot = await must('availability_slots', admin.from('availability_slots').insert({
      trainer_id: trainerIds[s % trainerIds.length], academy_profile_id: academy.id, cyclus_id: upfrontCycle.id,
      cyclus_name: `Najaar ${idx} — direct betalen`, start_time: iso(start), end_time: iso(plusMin(start, 90)),
      price_per_session: 20, max_participants: 4, is_public: false,
      priority_window_ends_at: iso(windowEnds), source_cycle_id: sourceCycle.id,
    }).select('id').single());
    const claims = upfrontMembers.map((inv) => ({
      slot_id: slot.id, player_id: inv.player_id, guest_player_id: inv.guest_player_id,
      rebook_group_id: upfrontGroupId, status: 'pending',
      claim_token: `seed-claim-up-a${idx}-s${s}-${inv.key}`,
    }));
    await must('slot_priority_claims', admin.from('slot_priority_claims').insert(claims).select('id'));
  }

  return {
    academy: academy.id, newCycle: newCycle.id, upfrontCycle: upfrontCycle.id,
    sampleToken: `seed-claim-a${idx}-s0-p1`,
    upfrontTokenPlayer: `seed-claim-up-a${idx}-s0-p1`,
    upfrontTokenGuest: `seed-claim-up-a${idx}-s0-g1`,
  };
}

async function main() {
  console.log(`Seeding local (${URL}) · scale=${SCALE}`);
  await purgeSeedData();
  await purgeSeedUsers();
  const hero = await seedAcademy(0, true);
  const fillerCount = SCALE === 'large' ? 12 : 0;
  for (let i = 1; i <= fillerCount; i++) await seedAcademy(i, false);

  // Optional: connect the hero academy to Mollie so the UPFRONT pay leg works locally. The token
  // is passed via env (MOLLIE_TEST_ACCESS_TOKEN) — a test_… key — and NEVER committed. With
  // MOLLIE_CLIENT_ID/SECRET unset, create-invoice-payment uses this token directly (no OAuth
  // refresh), so a test_ API key stands in for the connected-account access token.
  if (process.env.MOLLIE_TEST_ACCESS_TOKEN) {
    await must('academy_mollie_accounts', admin.from('academy_mollie_accounts').insert({
      academy_profile_id: hero.academy,
      access_token: process.env.MOLLIE_TEST_ACCESS_TOKEN,
      mollie_organization_id: process.env.MOLLIE_TEST_PROFILE_ID || 'org_test_seed',
      onboarding_complete: true, charges_enabled: true, payouts_enabled: true,
    }).select('id').single());
    console.log('Connected the hero academy to Mollie (test mode).');
  }

  const counts: Record<string, number> = {};
  for (const t of ['academy_profiles', 'trainer_profiles', 'profiles', 'guest_players', 'cycles', 'availability_slots', 'bookings', 'slot_priority_claims']) {
    const { count } = await admin.from(t).select('*', { count: 'exact', head: true });
    counts[t] = count ?? 0;
  }
  console.log('Row counts:', counts);
  console.log('\nLogins (password for all: %s):', PASSWORD);
  console.log('  academy manager : academy.manager@local.test');
  console.log('  trainer         : trainer1.a0@local.test');
  console.log('  player          : player1.a0@local.test');
  console.log('\nHero rebook round:', hero);
  console.log('  → drive the claim page at /claim/%s', hero.sampleToken);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
