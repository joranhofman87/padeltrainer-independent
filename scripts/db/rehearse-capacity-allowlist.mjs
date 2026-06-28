// #181 — every DB capacity COUNT now uses the occupancy ALLOWLIST
// (confirmed/pending/pending_approval), so a stale `rejected`/`completed` row no longer
// counts toward a slot's capacity, while the occupying statuses still do. Runs the REAL
// trigger + book_slot_for_payment + respond_to_priority_claim (full migration chain
// incl. 20260702140000) against PGlite.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const STAFF = '10000000-0000-0000-0000-000000000001';
const PLAYER = '20000000-0000-0000-0000-000000000002';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.get_profile_id_for_user(u uuid) RETURNS uuid AS $f$ SELECT u $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_cycle_member(u uuid, c uuid) RETURNS boolean AS $f$ SELECT false $f$ LANGUAGE sql STABLE;

  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, max_participants int, start_time timestamptz,
    priority_window_ends_at timestamptz, member_window_ends_at timestamptz,
    public_release_status text, source_cycle_id uuid);
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
    status text, payment_status text, payment_amount numeric, notes text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
  CREATE TABLE public.slot_priority_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), claim_token text, slot_id uuid, player_id uuid, guest_player_id uuid,
    status text, rebook_group_id uuid, responded_at timestamptz, decline_reason text, booking_id uuid);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
`);

for (const m of [
  '20260614110000_slot_capacity_advisory_locks.sql',
  '20260701130000_book_slot_for_payment_notes.sql',
  '20260702120000_enforce_capacity_for_staff_bookings.sql',
  '20260702140000_capacity_count_allowlist.sql',
]) await db.exec(readFileSync(`supabase/migrations/${m}`, 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };

let seq = 0;
async function makeSlot(max, occupantStatus) {
  seq += 1;
  const id = `50000000-0000-0000-0000-0000000000${String(seq).padStart(2, '0')}`;
  await db.query(`INSERT INTO public.availability_slots (id, max_participants, start_time, public_release_status) VALUES ($1,$2, now(), 'public')`, [id, max]);
  if (occupantStatus) {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1, gen_random_uuid(), $2, 'pending')`, [id, occupantStatus]);
  }
  return id;
}
async function staffInserts(slot) { // staff (auth.uid=STAFF) books PLAYER — capacity runs, tier skipped
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT '${STAFF}'::uuid $f$ LANGUAGE sql STABLE;`);
  try { await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1,$2,'confirmed','pending')`, [slot, PLAYER]); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function bookPay(slot) { // service-role RPC (auth.uid NULL)
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;`);
  try { const r = await db.query(`SELECT public.book_slot_for_payment($1,$2,10) AS id`, [slot, PLAYER]); return { ok: true, id: r.rows[0].id }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function acceptClaim(slot, occupantStatus) {
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;`);
  const tok = `tok_${seq}`;
  await db.query(`INSERT INTO public.slot_priority_claims (claim_token, slot_id, player_id, status) VALUES ($1,$2,$3,'pending')`, [tok, slot, PLAYER]);
  const r = await db.query(`SELECT public.respond_to_priority_claim($1,'accept') AS r`, [tok]);
  return r.rows[0].r;
}

// ---- TRIGGER (enforce_booking_slot_tier) ----
let r = await staffInserts(await makeSlot(1, 'rejected'));
ok(r.ok === true, 'TRIGGER: a REJECTED occupant does NOT count → staff insert onto a "full" slot succeeds', r);
r = await staffInserts(await makeSlot(1, 'completed'));
ok(r.ok === true, 'TRIGGER: a COMPLETED occupant does NOT count → staff insert succeeds', r);
r = await staffInserts(await makeSlot(1, 'confirmed'));
ok(r.ok === false && /slot_full/.test(r.error || ''), 'TRIGGER: a CONFIRMED occupant DOES count → staff insert rejected slot_full', r);
r = await staffInserts(await makeSlot(1, 'pending_approval'));
ok(r.ok === false && /slot_full/.test(r.error || ''), 'TRIGGER: a PENDING_APPROVAL occupant DOES count → rejected slot_full', r);

// ---- book_slot_for_payment ----
r = await bookPay(await makeSlot(1, 'rejected'));
ok(r.ok === true && r.id, 'book_slot_for_payment: REJECTED occupant does NOT count → booking created', r);
r = await bookPay(await makeSlot(1, 'confirmed'));
ok(r.ok === false && /slot_full/.test(r.error || ''), 'book_slot_for_payment: CONFIRMED occupant DOES count → slot_full', r);

// ---- respond_to_priority_claim (legacy single) ----
r = await acceptClaim(await makeSlot(1, 'completed'), 'completed');
ok(r.ok === true && r.status === 'claimed', 'respond_to_priority_claim: COMPLETED occupant does NOT count → accept claims the seat', r);
r = await acceptClaim(await makeSlot(1, 'confirmed'), 'confirmed');
ok(r.ok === false && r.reason === 'slot_full', 'respond_to_priority_claim: CONFIRMED occupant DOES count → accept rejected slot_full', r);

// ---- swap_member_booking (target-slot capacity count) ----
const P_SWAP = '20000000-0000-0000-0000-0000000000aa';
const U_SWAP = '10000000-0000-0000-0000-0000000000aa';
async function swapMember(occupantStatus) {
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT '${U_SWAP}'::uuid $f$ LANGUAGE sql STABLE;`);
  await db.query(`INSERT INTO public.profiles (id, user_id) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [P_SWAP, U_SWAP]);
  const oldSlot = await makeSlot(2, null);
  const ob = (await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1,$2,'confirmed','pending') RETURNING id`, [oldSlot, P_SWAP])).rows[0].id;
  const newSlot = await makeSlot(1, occupantStatus);
  try { const res = await db.query(`SELECT public.swap_member_booking($1,$2) AS r`, [ob, newSlot]); return { ok: res.rows[0].r.ok === true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
r = await swapMember('rejected');
ok(r.ok === true, 'swap_member_booking: REJECTED occupant does NOT count → swap to a "full" slot succeeds', r);
r = await swapMember('confirmed');
ok(r.ok === false && /Slot is full/.test(r.error || ''), 'swap_member_booking: CONFIRMED occupant DOES count → "Slot is full"', r);

console.log(fail === 0 ? '\nALL capacity-allowlist checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
