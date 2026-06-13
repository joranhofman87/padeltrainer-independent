import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const PLAYER = 'aaaaaaaa-0000-0000-0000-000000000001';
const UID = 'bbbbbbbb-0000-0000-0000-000000000001';

await db.exec(`
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $fn$ SELECT '${UID}'::uuid $fn$ LANGUAGE sql STABLE;
  CREATE SCHEMA IF NOT EXISTS public;
  CREATE FUNCTION public.get_profile_id_for_user(uid uuid) RETURNS uuid AS $fn$
    SELECT CASE WHEN uid = '${UID}'::uuid THEN '${PLAYER}'::uuid ELSE NULL END $fn$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_cycle_member(uid uuid, cyc uuid) RETURNS boolean AS $fn$ SELECT false $fn$ LANGUAGE sql STABLE;
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, max_participants int,
    priority_window_ends_at timestamptz, member_window_ends_at timestamptz,
    public_release_status text DEFAULT 'released', source_cycle_id uuid);
  CREATE TABLE public.slot_priority_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text, notes text);
  INSERT INTO public.availability_slots (id, max_participants) VALUES
    ('00000000-0000-0000-0000-00000000000a', 2),
    ('00000000-0000-0000-0000-00000000000b', 1);
  INSERT INTO public.bookings (id, slot_id, player_id, status)
    VALUES ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-00000000000b', 'cccccccc-0000-0000-0000-000000000009', 'confirmed');
`);

const mig = readFileSync('supabase/migrations/20260613130000_enforce_booking_slot_tier_on_update.sql', 'utf8');
await db.exec(mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION')));

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m)); };
const expectThrow = async (sql, needle) => { try { await db.exec(sql); return false; } catch (e) { return String(e.message).includes(needle); } };

await db.exec(`INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','${PLAYER}','confirmed')`);
ok(true, 'INSERT onto open public slot allowed');

await db.exec(`UPDATE public.bookings SET notes='hi' WHERE id='00000000-0000-0000-0000-000000000001'`);
ok(true, 'UPDATE notes only (same slot) allowed — field edits do not trip the gate');

ok(await expectThrow(`UPDATE public.bookings SET slot_id='00000000-0000-0000-0000-00000000000b' WHERE id='00000000-0000-0000-0000-000000000001'`, 'slot_full'),
   'UPDATE moving booking onto FULL slot blocked (slot_full) — the fix');

ok(await expectThrow(`INSERT INTO public.bookings (id, slot_id, player_id, status) VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-00000000000b','${PLAYER}','confirmed')`, 'slot_full'),
   'INSERT onto FULL slot still blocked');

console.log(fail === 0 ? '\nALL booking-tier-update rehearsal checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
