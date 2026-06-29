// Rebook go-live A2 — STRICT accept creates a payment_pending HOLD (not a confirmed booking)
// when the cycle opts in (settings.rebook_strict_mollie), the claim still flips to 'claimed', and
// the hold lifecycle (client release + expiry cron) cancels the hold + re-offers the claim. Runs
// the REAL respond_to_priority_claim + release_rebook_hold + release_expired_rebook_holds (full
// migration chain incl. 20260703150000) against PGlite. Mirrors rehearse-strict-hold-capacity.mjs.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const PLAYER = '20000000-0000-0000-0000-000000000002';
const OTHER = '20000000-0000-0000-0000-000000000099';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.get_profile_id_for_user(u uuid) RETURNS uuid AS $f$ SELECT u $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_cycle_member(u uuid, c uuid) RETURNS boolean AS $f$ SELECT false $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_admin(u uuid) RETURNS boolean AS $f$ SELECT false $f$ LANGUAGE sql STABLE;

  CREATE TABLE public.cycles (id uuid PRIMARY KEY, settings jsonb);
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY, max_participants int, start_time timestamptz, cyclus_id uuid,
    priority_window_ends_at timestamptz, member_window_ends_at timestamptz,
    public_release_status text, source_cycle_id uuid);
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, guest_player_id uuid,
    status text, payment_status text, payment_amount numeric, notes text, hold_expires_at timestamptz,
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
  '20260703150000_rebook_strict_accept_and_release.sql',
]) await db.exec(readFileSync(`supabase/migrations/${m}`, 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const asAnon = () => db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;`);
const asUser = (u) => db.exec(`CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT '${u}'::uuid $f$ LANGUAGE sql STABLE;`);

let seq = 0;
async function makeStrictSlot(strict) {
  seq += 1;
  const cyc = `c0000000-0000-0000-0000-0000000000${String(seq).padStart(2, '0')}`;
  const slot = `50000000-0000-0000-0000-0000000000${String(seq).padStart(2, '0')}`;
  await db.query(`INSERT INTO public.cycles (id, settings) VALUES ($1, $2)`, [cyc, JSON.stringify({ rebook_strict_mollie: strict })]);
  await db.query(`INSERT INTO public.availability_slots (id, max_participants, start_time, cyclus_id, public_release_status) VALUES ($1, 1, now(), $2, 'public')`, [slot, cyc]);
  return slot;
}
async function acceptClaim(slot, player = PLAYER) {
  await asAnon();
  const tok = `tok_${seq}`;
  await db.query(`INSERT INTO public.slot_priority_claims (claim_token, slot_id, player_id, status) VALUES ($1,$2,$3,'pending')`, [tok, slot, player]);
  const r = await db.query(`SELECT public.respond_to_priority_claim($1,'accept') AS r`, [tok]);
  return { res: r.rows[0].r, tok };
}
const bookingFor = async (slot) => (await db.query(`SELECT id, status, hold_expires_at, player_id FROM public.bookings WHERE slot_id=$1 ORDER BY created_at DESC LIMIT 1`, [slot])).rows[0];
const claimFor = async (tok) => (await db.query(`SELECT status, booking_id FROM public.slot_priority_claims WHERE claim_token=$1`, [tok])).rows[0];

// ---- STRICT accept → hold ----
let slot = await makeStrictSlot(true);
let { res, tok } = await acceptClaim(slot);
let b = await bookingFor(slot);
let cl = await claimFor(tok);
ok(res.ok === true && res.status === 'claimed' && res.strict === true, 'STRICT accept: ok + claimed + strict=true', res);
ok(b.status === 'payment_pending' && b.hold_expires_at !== null, 'STRICT accept: booking is a payment_pending HOLD with a TTL', b);
ok(cl.status === 'claimed' && cl.booking_id === b.id, 'STRICT accept: claim → claimed, points at the hold', cl);

// ---- NON-strict accept → confirmed (regression) ----
slot = await makeStrictSlot(false);
({ res, tok } = await acceptClaim(slot));
b = await bookingFor(slot);
ok(res.ok === true && res.strict === false, 'NON-strict accept: ok + strict=false', res);
ok(b.status === 'confirmed' && b.hold_expires_at === null, 'NON-strict accept: booking is confirmed, no TTL (byte-identical)', b);

// ---- release_rebook_hold (client checkout-start failure) ----
slot = await makeStrictSlot(true);
({ res, tok } = await acceptClaim(slot));
b = await bookingFor(slot);
await asUser(OTHER);
let rel = (await db.query(`SELECT public.release_rebook_hold($1) AS r`, [b.id])).rows[0].r;
ok(rel.ok === false && rel.reason === 'not_yours', 'release_rebook_hold: a non-owner cannot release the hold', rel);
await asUser(PLAYER);
rel = (await db.query(`SELECT public.release_rebook_hold($1) AS r`, [b.id])).rows[0].r;
b = (await db.query(`SELECT status FROM public.bookings WHERE id=$1`, [b.id])).rows[0];
cl = await claimFor(tok);
ok(rel.ok === true && rel.released === true, 'release_rebook_hold: owner releases the hold', rel);
ok(b.status === 'cancelled', 'release_rebook_hold: hold is cancelled', b);
ok(cl.status === 'pending' && cl.booking_id === null, 'release_rebook_hold: claim reset to pending (re-offerable)', cl);
// idempotent re-call
rel = (await db.query(`SELECT public.release_rebook_hold($1) AS r`, [(await bookingFor(slot)).id])).rows[0].r;
ok(rel.ok === true && rel.released === false, 'release_rebook_hold: re-call on a cancelled hold is a no-op', rel);

// ---- release_expired_rebook_holds (cron) ----
// expired strict hold + claim → cancelled + re-offered
const expSlot = await makeStrictSlot(true);
await db.query(`INSERT INTO public.slot_priority_claims (claim_token, slot_id, player_id, status, booking_id) VALUES ('exp_tok', $1, $2, 'claimed', gen_random_uuid())`, [expSlot, PLAYER]);
const expClaim = (await db.query(`SELECT id, booking_id FROM public.slot_priority_claims WHERE claim_token='exp_tok'`)).rows[0];
const expHold = (await db.query(`INSERT INTO public.bookings (id, slot_id, player_id, status, payment_status, hold_expires_at) VALUES ($1, $2, $3, 'payment_pending', 'pending', now() - interval '1 min') RETURNING id`, [expClaim.booking_id, expSlot, PLAYER])).rows[0].id;
// a NON-expired hold + a confirmed booking that must be left alone
const liveSlot = await makeStrictSlot(true);
await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status, hold_expires_at) VALUES ($1, $2, 'payment_pending', 'pending', now() + interval '15 min')`, [liveSlot, PLAYER]);
const confSlot = await makeStrictSlot(true);
await db.query(`INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ($1, $2, 'confirmed', 'pending')`, [confSlot, PLAYER]);

const released = (await db.query(`SELECT public.release_expired_rebook_holds() AS n`)).rows[0].n;
ok(Number(released) === 1, 'release_expired_rebook_holds: returns 1 (one claim reset)', released);
ok((await db.query(`SELECT status FROM public.bookings WHERE id=$1`, [expHold])).rows[0].status === 'cancelled', 'cron: expired hold cancelled', null);
ok((await db.query(`SELECT status FROM public.slot_priority_claims WHERE id=$1`, [expClaim.id])).rows[0].status === 'pending', 'cron: expired hold claim reset to pending', null);
ok((await db.query(`SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1 AND status='payment_pending'`, [liveSlot])).rows[0].n === 1, 'cron: a non-expired hold is left untouched', null);
ok((await db.query(`SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1 AND status='confirmed'`, [confSlot])).rows[0].n === 1, 'cron: a confirmed booking is left untouched', null);

console.log(fail === 0 ? '\nALL strict-accept-release checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
