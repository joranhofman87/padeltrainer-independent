/**
 * PGlite rehearsal for 20260613120000_rebook_group_claims.sql.
 * Verifies group-aware respond_to_priority_claim: one accept books the whole
 * series, one decline releases it, capacity is guarded per slot, and legacy
 * (rebook_group_id NULL) single claims keep their original behavior.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = new PGlite();
let failures = 0;
const check = (cond: boolean, msg: string, extra?: unknown) => {
  if (cond) { console.log('  PASS', msg); }
  else { failures++; console.error('  FAIL', msg, extra !== undefined ? JSON.stringify(extra) : ''); }
};

await db.exec(`
  CREATE SCHEMA IF NOT EXISTS public;
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE TABLE public.availability_slots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    start_time timestamptz NOT NULL,
    max_participants integer,
    priority_window_ends_at timestamptz
  );
  CREATE TABLE public.bookings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id uuid, player_id uuid, guest_player_id uuid,
    status text, payment_status text, created_at timestamptz, updated_at timestamptz
  );
  CREATE TABLE public.slot_priority_claims (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id uuid NOT NULL,
    player_id uuid, guest_player_id uuid,
    status text NOT NULL DEFAULT 'pending',
    claim_token text NOT NULL UNIQUE,
    invited_at timestamptz, responded_at timestamptz, decline_reason text,
    source_slot_id uuid, booking_id uuid, rebook_group_id uuid,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  );
`);

// Apply only the function definition from the migration (skip ALTER/INDEX — the
// table above already has rebook_group_id).
const migration = readFileSync(join(process.cwd(), 'supabase/migrations/20260613120000_rebook_group_claims.sql'), 'utf8');
const fnStart = migration.indexOf('CREATE OR REPLACE FUNCTION');
await db.exec(migration.slice(fnStart));

const S = (n: number) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const P = (n: number) => `aaaaaaaa-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const G = '11111111-1111-1111-1111-111111111111';

// Group of 3 weekly slots (max 4 each), player P1 has a claim on all three.
// A second player P2 also has a claim on slot 1 only (separate, must be untouched).
await db.exec(`
  INSERT INTO public.availability_slots (id, start_time, max_participants, priority_window_ends_at) VALUES
    ('${S(1)}', now() + interval '7 days',  4, now() + interval '5 days'),
    ('${S(2)}', now() + interval '14 days', 4, now() + interval '5 days'),
    ('${S(3)}', now() + interval '21 days', 4, now() + interval '5 days');
  INSERT INTO public.slot_priority_claims (slot_id, player_id, status, claim_token, rebook_group_id) VALUES
    ('${S(1)}', '${P(1)}', 'pending', 'tok-p1-s1', '${G}'),
    ('${S(2)}', '${P(1)}', 'pending', 'tok-p1-s2', '${G}'),
    ('${S(3)}', '${P(1)}', 'pending', 'tok-p1-s3', '${G}'),
    ('${S(1)}', '${P(2)}', 'pending', 'tok-p2-s1', '${G}');
`);

// --- ACCEPT via P1's representative token books all 3 of P1's slots ---
const acc = (await db.query<{ r: any }>(`SELECT public.respond_to_priority_claim('tok-p1-s1','accept') AS r`)).rows[0].r;
check(acc.ok === true && acc.group === true && acc.booked === 3, 'group accept books all 3 series slots', acc);

const p1Bookings = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.bookings WHERE player_id='${P(1)}' AND status='confirmed' AND payment_status='pending'`)).rows[0].n;
check(p1Bookings === 3, 'P1 has 3 confirmed unpaid bookings', p1Bookings);

const p1Claims = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.slot_priority_claims WHERE player_id='${P(1)}' AND status='claimed'`)).rows[0].n;
check(p1Claims === 3, 'all 3 of P1 claims marked claimed', p1Claims);

const p2Claim = (await db.query<{ status: string }>(`SELECT status FROM public.slot_priority_claims WHERE claim_token='tok-p2-s1'`)).rows[0].status;
check(p2Claim === 'pending', 'P2 claim on shared slot untouched by P1 accept', p2Claim);

// --- DECLINE via P2 token releases only P2's claim(s) in the group ---
const dec = (await db.query<{ r: any }>(`SELECT public.respond_to_priority_claim('tok-p2-s1','decline') AS r`)).rows[0].r;
check(dec.ok === true && dec.group === true && dec.declined === 1, 'group decline releases P2 series (1 slot)', dec);
const p2After = (await db.query<{ status: string }>(`SELECT status FROM public.slot_priority_claims WHERE claim_token='tok-p2-s1'`)).rows[0].status;
check(p2After === 'declined', 'P2 claim now declined', p2After);

// --- Capacity: fill slot 2 to max, then a fresh group accept skips the full one ---
await db.exec(`
  INSERT INTO public.availability_slots (id, start_time, max_participants, priority_window_ends_at) VALUES
    ('${S(4)}', now() + interval '7 days',  1, now() + interval '5 days'),
    ('${S(5)}', now() + interval '14 days', 1, now() + interval '5 days');
  -- slot 4 already full (1/1), slot 5 open
  INSERT INTO public.bookings (slot_id, player_id, status, payment_status) VALUES ('${S(4)}','${P(9)}','confirmed','pending');
  INSERT INTO public.slot_priority_claims (slot_id, player_id, status, claim_token, rebook_group_id) VALUES
    ('${S(4)}', '${P(3)}', 'pending', 'tok-p3-s4', '22222222-2222-2222-2222-222222222222'),
    ('${S(5)}', '${P(3)}', 'pending', 'tok-p3-s5', '22222222-2222-2222-2222-222222222222');
`);
const accFull = (await db.query<{ r: any }>(`SELECT public.respond_to_priority_claim('tok-p3-s4','accept') AS r`)).rows[0].r;
check(accFull.booked === 1 && accFull.skipped_full === 1, 'group accept books open slot, skips full one', accFull);
const p3s4 = (await db.query<{ status: string }>(`SELECT status FROM public.slot_priority_claims WHERE claim_token='tok-p3-s4'`)).rows[0].status;
check(p3s4 === 'pending', 'full-slot claim stays pending (owner can see it did not fit)', p3s4);

// --- Legacy single claim (rebook_group_id NULL) unchanged ---
await db.exec(`
  INSERT INTO public.availability_slots (id, start_time, max_participants, priority_window_ends_at) VALUES
    ('${S(6)}', now() + interval '7 days', 4, now() + interval '5 days');
  INSERT INTO public.slot_priority_claims (slot_id, player_id, status, claim_token) VALUES
    ('${S(6)}', '${P(4)}', 'pending', 'tok-legacy');
`);
const legacy = (await db.query<{ r: any }>(`SELECT public.respond_to_priority_claim('tok-legacy','accept') AS r`)).rows[0].r;
check(legacy.ok === true && legacy.status === 'claimed' && legacy.group === undefined && !!legacy.booking_id, 'legacy single accept unchanged (no group flag)', legacy);

// --- Idempotency: re-accept an already-claimed token is a no-op response ---
const again = (await db.query<{ r: any }>(`SELECT public.respond_to_priority_claim('tok-p1-s1','accept') AS r`)).rows[0].r;
check(again.ok === false && again.reason === 'already_responded', 'already-responded token returns no-op', again);

console.log(failures === 0 ? '\nALL rebook-group-claims rehearsal checks passed.' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
