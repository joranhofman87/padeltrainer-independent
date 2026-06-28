// A1: enforce_booking_slot_tier now runs the capacity (overbooking) guard for
// ALL authenticated inserts — staff-for-player and staff-for-guest, not just a
// player self-booking — while TIER checks stay self-only and service-role
// inserts still bypass. Runs the REAL trigger (both migrations) against PGlite.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const STAFF = '10000000-0000-0000-0000-000000000001';
const PLAYER = '20000000-0000-0000-0000-000000000002';
const OTHER = '20000000-0000-0000-0000-000000000003';
const GUEST = '30000000-0000-0000-0000-000000000004';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA IF NOT EXISTS auth;
  -- auth.uid() is redefined per case (NULL = service role). get_profile_id_for_user
  -- is identity here, so the caller's profile id IS auth.uid().
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.get_profile_id_for_user(u uuid) RETURNS uuid AS $f$ SELECT u $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_cycle_member(u uuid, c uuid) RETURNS boolean AS $f$ SELECT false $f$ LANGUAGE sql STABLE;

  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, max_participants int, start_time timestamptz,
    priority_window_ends_at timestamptz, member_window_ends_at timestamptz,
    public_release_status text, source_cycle_id uuid);
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
    status text, payment_status text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.slot_priority_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_token text, slot_id uuid, player_id uuid, guest_player_id uuid,
    status text, rebook_group_id uuid, responded_at timestamptz, decline_reason text, booking_id uuid);
`);

// Apply the prior trigger migration (creates the trigger + initial function),
// then the A1 migration (replaces the function body) — mirrors prod order.
await db.exec(readFileSync('supabase/migrations/20260614110000_slot_capacity_advisory_locks.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260702120000_enforce_capacity_for_staff_bookings.sql', 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const setCaller = (uid) =>
  db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT ${uid ? `'${uid}'::uuid` : 'NULL::uuid'} $f$ LANGUAGE sql STABLE;`);
const seats = async (slot) =>
  Number((await db.query(`SELECT count(*) n FROM public.bookings WHERE slot_id=$1 AND COALESCE(status,'confirmed') NOT IN ('cancelled','cancelled_swap')`, [slot])).rows[0].n);

let slotSeq = 0;
async function makeSlot({ max = 1, taken = 0, status = 'public', priorityWindow = null }) {
  slotSeq += 1;
  const id = `50000000-0000-0000-0000-0000000000${String(slotSeq).padStart(2, '0')}`;
  await db.query(
    `INSERT INTO public.availability_slots (id, max_participants, start_time, public_release_status, priority_window_ends_at) VALUES ($1,$2, now(), $3, $4)`,
    [id, max, status, priorityWindow],
  );
  for (let i = 0; i < taken; i++) {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1, gen_random_uuid(), 'confirmed', 'pending')`, [id]);
  }
  return id;
}
async function tryBook(slot, { player = null, guest = null, status = 'confirmed' }) {
  try {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status) VALUES ($1,$2,$3,$4,'pending')`,
      [slot, player, guest, status]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// A — service role (auth.uid() NULL) bypasses: insert onto a FULL slot succeeds.
await setCaller(null);
let slot = await makeSlot({ max: 1, taken: 1 });
let r = await tryBook(slot, { player: PLAYER });
ok(r.ok === true, 'A service-role insert bypasses capacity (backend paths self-guard)', r);

// B — staff-for-player onto a FULL slot is REJECTED (the fix).
await setCaller(STAFF);
slot = await makeSlot({ max: 1, taken: 1 });
r = await tryBook(slot, { player: PLAYER });
ok(r.ok === false && /slot_full/.test(r.error || ''), 'B staff booking a PLAYER onto a full slot → slot_full', r);
ok((await seats(slot)) === 1, 'B no overbooking — still 1/1', await seats(slot));

// C — staff-for-guest onto a FULL slot is REJECTED (the fix).
slot = await makeSlot({ max: 1, taken: 1 });
r = await tryBook(slot, { player: null, guest: GUEST });
ok(r.ok === false && /slot_full/.test(r.error || ''), 'C staff booking a GUEST onto a full slot → slot_full', r);

// D — staff booking onto a slot WITH room succeeds.
slot = await makeSlot({ max: 2, taken: 1 });
r = await tryBook(slot, { player: PLAYER });
ok(r.ok === true && (await seats(slot)) === 2, 'D staff booking onto a slot with room → allowed (2/2)', r);

// E — player self-booking onto a FULL slot is REJECTED (unchanged behaviour).
await setCaller(PLAYER);
slot = await makeSlot({ max: 1, taken: 1 });
r = await tryBook(slot, { player: PLAYER });
ok(r.ok === false && /slot_full/.test(r.error || ''), 'E player self-booking a full slot → slot_full (unchanged)', r);

// F — staff bypasses the TIER window: a HELD (hidden) slot with room accepts a
//     staff-placed booking, where a self-booking would be slot_not_released.
await setCaller(STAFF);
slot = await makeSlot({ max: 2, taken: 0, status: 'held' });
r = await tryBook(slot, { player: OTHER });
ok(r.ok === true, 'F staff booking onto a HELD slot → allowed (tier checks skipped for staff)', r);

// G — player self-booking onto a HELD slot is still TIER-blocked.
await setCaller(PLAYER);
slot = await makeSlot({ max: 2, taken: 0, status: 'held' });
r = await tryBook(slot, { player: PLAYER });
ok(r.ok === false && /slot_not_released/.test(r.error || ''), 'G player self-booking a HELD slot → slot_not_released (tier still enforced for self)', r);

console.log(fail === 0 ? '\nALL staff-capacity checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
