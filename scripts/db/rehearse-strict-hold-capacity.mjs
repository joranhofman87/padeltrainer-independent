// Rebook go-live A1 — a payment_pending HOLD with a future hold_expires_at counts toward slot
// capacity (so it blocks others), and an EXPIRED hold does not (capacity self-heals in real
// time). Runs the REAL trigger + book_slot_for_payment + respond_to_priority_claim (full
// migration chain incl. the new 20260703140000) against PGlite. Mirrors rehearse-capacity-allowlist.mjs.
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
  '20260703140000_rebook_strict_hold_capacity.sql',
]) await db.exec(readFileSync(`supabase/migrations/${m}`, 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };

let seq = 0;
// occupant: 'active' = payment_pending hold expiring in 15 min; 'expired' = hold expired 1 min ago;
//           'nullexp' = payment_pending with NULL hold_expires_at (malformed; treated as non-occupying);
//           'confirmed' = a normal confirmed booking; null = empty slot.
async function makeSlot(max, occupant) {
  seq += 1;
  const id = `50000000-0000-0000-0000-0000000000${String(seq).padStart(2, '0')}`;
  await db.query(`INSERT INTO public.availability_slots (id, max_participants, start_time, public_release_status) VALUES ($1,$2, now(), 'public')`, [id, max]);
  if (occupant === 'active') {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status, hold_expires_at) VALUES ($1, gen_random_uuid(), 'payment_pending', 'pending', now() + interval '15 min')`, [id]);
  } else if (occupant === 'expired') {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status, hold_expires_at) VALUES ($1, gen_random_uuid(), 'payment_pending', 'pending', now() - interval '1 min')`, [id]);
  } else if (occupant === 'nullexp') {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status, hold_expires_at) VALUES ($1, gen_random_uuid(), 'payment_pending', 'pending', NULL)`, [id]);
  } else if (occupant === 'confirmed') {
    await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1, gen_random_uuid(), 'confirmed', 'pending')`, [id]);
  }
  return id;
}
async function staffInserts(slot) {
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT '${STAFF}'::uuid $f$ LANGUAGE sql STABLE;`);
  try { await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1,$2,'confirmed','pending')`, [slot, PLAYER]); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function bookPay(slot) {
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;`);
  try { const r = await db.query(`SELECT public.book_slot_for_payment($1,$2,10) AS id`, [slot, PLAYER]); return { ok: true, id: r.rows[0].id }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}
async function acceptClaim(slot) {
  await db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;`);
  const tok = `tok_${seq}`;
  await db.query(`INSERT INTO public.slot_priority_claims (claim_token, slot_id, player_id, status) VALUES ($1,$2,$3,'pending')`, [tok, slot, PLAYER]);
  const r = await db.query(`SELECT public.respond_to_priority_claim($1,'accept') AS r`, [tok]);
  return r.rows[0].r;
}

// ---- constraint: payment_pending is now an allowed status; a bogus one is not ----
let cons;
try { await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES (gen_random_uuid(), gen_random_uuid(), 'payment_pending', 'pending')`); cons = { ok: true }; }
catch (e) { cons = { ok: false, error: String(e.message || e) }; }
ok(cons.ok === true, 'CONSTRAINT: status=payment_pending is allowed by bookings_status_check', cons);
try { await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES (gen_random_uuid(), gen_random_uuid(), 'bogus_status', 'pending')`); cons = { ok: true }; }
catch (e) { cons = { ok: false, error: String(e.message || e) }; }
ok(cons.ok === false && /bookings_status_check/.test(cons.error || ''), 'CONSTRAINT: an unknown status is still rejected', cons);

// ---- TRIGGER (enforce_booking_slot_tier) ----
let r = await staffInserts(await makeSlot(1, 'active'));
ok(r.ok === false && /slot_full/.test(r.error || ''), 'TRIGGER: an ACTIVE hold counts → staff insert onto the held seat rejected slot_full', r);
r = await staffInserts(await makeSlot(1, 'expired'));
ok(r.ok === true, 'TRIGGER: an EXPIRED hold does NOT count → staff insert succeeds (seat freed)', r);
r = await staffInserts(await makeSlot(1, 'nullexp'));
ok(r.ok === true, 'TRIGGER: a NULL-expiry payment_pending does NOT count (malformed → non-occupying)', r);

// ---- book_slot_for_payment ----
r = await bookPay(await makeSlot(1, 'active'));
ok(r.ok === false && /slot_full/.test(r.error || ''), 'book_slot_for_payment: ACTIVE hold counts → slot_full', r);
r = await bookPay(await makeSlot(1, 'expired'));
ok(r.ok === true && r.id, 'book_slot_for_payment: EXPIRED hold does NOT count → booking created', r);

// ---- respond_to_priority_claim (legacy single) ----
r = await acceptClaim(await makeSlot(1, 'active'));
ok(r.ok === false && r.reason === 'slot_full', 'respond_to_priority_claim: ACTIVE hold counts → accept rejected slot_full', r);
r = await acceptClaim(await makeSlot(1, 'expired'));
ok(r.ok === true && r.status === 'claimed', 'respond_to_priority_claim: EXPIRED hold does NOT count → accept claims the seat', r);

// ---- regression: a confirmed booking still counts (allowlist unchanged) ----
r = await staffInserts(await makeSlot(1, 'confirmed'));
ok(r.ok === false && /slot_full/.test(r.error || ''), 'REGRESSION: a CONFIRMED occupant still counts → slot_full', r);

console.log(fail === 0 ? '\nALL strict-hold-capacity checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
