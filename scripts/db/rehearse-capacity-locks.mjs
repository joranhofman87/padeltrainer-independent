import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const SLOT = '50000000-0000-0000-0000-000000000001';
const PL1 = '20000000-0000-0000-0000-000000000001';
const PL2 = '20000000-0000-0000-0000-000000000002';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.get_profile_id_for_user(u uuid) RETURNS uuid AS $f$ SELECT NULL::uuid $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_cycle_member(u uuid, c uuid) RETURNS boolean AS $f$ SELECT true $f$ LANGUAGE sql STABLE;

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

  -- 2-seat slot, one seat already taken.
  INSERT INTO public.availability_slots (id, max_participants, start_time) VALUES ('${SLOT}', 2, now());
  INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${SLOT}', '${PL1}', 'confirmed', 'pending');
  -- Two pending legacy claims by two different players on the last seat.
  INSERT INTO public.slot_priority_claims (claim_token, slot_id, player_id, status) VALUES
    ('tok_a', '${SLOT}', '${PL2}', 'pending'),
    ('tok_b', '${SLOT}', '20000000-0000-0000-0000-000000000003', 'pending');
`);

const mig = readFileSync('supabase/migrations/20260614110000_slot_capacity_advisory_locks.sql', 'utf8');
await db.exec(mig);  // applies cleanly = functions compile + advisory-lock syntax valid

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const seats = async () => Number((await db.query(`SELECT count(*) n FROM public.bookings WHERE slot_id='${SLOT}' AND COALESCE(status,'confirmed') NOT IN ('cancelled','cancelled_swap')`)).rows[0].n);
const accept = async (tok) => (await db.query(`SELECT public.respond_to_priority_claim($1,'accept') AS r`, [tok])).rows[0].r;

ok(true, 'MIGRATION applies cleanly (functions compile, pg_advisory_xact_lock syntax valid)');

// First accept fills the last seat.
let r = await accept('tok_a');
ok(r.ok === true && r.status === 'claimed', 'ACCEPT #1 books the last seat (under capacity)', r);
ok((await seats()) === 2, 'slot now at capacity (2/2)', await seats());

// Second accept must be rejected — slot full (the lock + count now sees 2).
r = await accept('tok_b');
ok(r.ok === false && r.reason === 'slot_full', 'ACCEPT #2 rejected: slot_full (capacity enforced post-lock)', r);
ok((await seats()) === 2, 'no overbooking — still 2/2', await seats());

// Advisory lock function itself works under this Postgres build.
const lk = (await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('${SLOT}'::text, 0)) IS NOT DISTINCT FROM NULL AS acquired`)).rows[0];
ok(lk !== undefined, 'pg_advisory_xact_lock(hashtextextended(...)) executes', lk);

console.log(fail === 0 ? '\nALL capacity-lock checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
