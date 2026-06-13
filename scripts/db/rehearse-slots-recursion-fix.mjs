import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const U = { TR: '10000000-0000-0000-0000-000000000001', PL: '10000000-0000-0000-0000-000000000002' };
const P = { TR: '20000000-0000-0000-0000-000000000001', PL: '20000000-0000-0000-0000-000000000002' };
const TP = '30000000-0000-0000-0000-000000000001';
const SLOT_PUB = '50000000-0000-0000-0000-000000000001'; // public slot
const SLOT_PRIV = '50000000-0000-0000-0000-000000000002'; // private slot the player booked

await db.exec(`
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$
    SELECT NULLIF(current_setting('test.uid', true), '')::uuid $f$ LANGUAGE sql STABLE;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text);
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, is_public boolean, start_time timestamptz);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid, status text);

  GRANT SELECT ON public.availability_slots, public.bookings, public.profiles, public.trainer_profiles TO anon, authenticated;

  CREATE FUNCTION public.get_profile_id_for_user(u uuid) RETURNS uuid
    AS $f$ SELECT id FROM public.profiles WHERE user_id = u $f$ LANGUAGE sql STABLE SECURITY DEFINER;

  INSERT INTO public.profiles (id,user_id,full_name) VALUES
    ('${P.TR}','${U.TR}','Trainer'),('${P.PL}','${U.PL}','Player');
  INSERT INTO public.trainer_profiles (id,user_id) VALUES ('${TP}','${U.TR}');
  INSERT INTO public.availability_slots (id,trainer_id,is_public,start_time) VALUES
    ('${SLOT_PUB}','${TP}',true, now()),
    ('${SLOT_PRIV}','${TP}',false, now());
  INSERT INTO public.bookings (slot_id,player_id,status) VALUES ('${SLOT_PRIV}','${P.PL}','confirmed');

  ALTER TABLE public.availability_slots ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

  -- availability_slots: public slots world-visible
  CREATE POLICY "Public slots viewable" ON public.availability_slots
    FOR SELECT TO anon, authenticated USING (is_public = true);
  -- ... and trainers see all their own slots (prod: "Owners and managers can
  -- view all their slots"). References trainer_profiles, not bookings — no cycle.
  CREATE POLICY "Owners view their slots" ON public.availability_slots
    FOR SELECT TO authenticated USING (
      trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid())
    );

  -- bookings: players see own; trainers see bookings for their slots (the
  -- long-standing back-edge that references availability_slots).
  CREATE POLICY "Players view own bookings" ON public.bookings
    FOR SELECT TO authenticated USING (player_id = public.get_profile_id_for_user(auth.uid()));
  CREATE POLICY "Trainers view bookings for their slots" ON public.bookings
    FOR SELECT TO authenticated USING (
      slot_id IN (SELECT id FROM public.availability_slots
        WHERE trainer_id IN (SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()))
    );

  -- The BROKEN policy (verbatim shape of migration 20260613140000): an
  -- availability_slots SELECT policy that queries bookings directly.
  CREATE POLICY "Players can view slots they have booked" ON public.availability_slots
    FOR SELECT TO authenticated USING (
      EXISTS (SELECT 1 FROM public.bookings b
        WHERE b.slot_id = availability_slots.id
          AND b.player_id = public.get_profile_id_for_user(auth.uid())
          AND COALESCE(b.status,'confirmed') NOT IN ('cancelled','cancelled_swap'))
    );
`);

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };

async function asPlayer(sql) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid','${U.PL}',false);`);
  try { return { rows: (await db.query(sql)).rows, error: null }; }
  catch (e) { return { rows: null, error: e }; }
  finally { await db.exec('RESET ROLE'); }
}

// 1) Reproduce the recursion with the broken policy in place.
let r = await asPlayer('SELECT id FROM public.bookings');
ok(r.error && /infinite recursion/i.test(String(r.error.message)),
   'BEFORE FIX: selecting bookings recurses (42P17)', r.error?.message || '(no error!)');
r = await asPlayer('SELECT id FROM public.availability_slots');
ok(r.error && /infinite recursion/i.test(String(r.error.message)),
   'BEFORE FIX: selecting availability_slots recurses (42P17)', r.error?.message || '(no error!)');

// 2) Apply the fix migration.
const mig = readFileSync('supabase/migrations/20260613160000_fix_players_view_booked_slots_recursion.sql', 'utf8');
await db.exec(mig);

// 3) Recursion gone; visibility preserved.
r = await asPlayer('SELECT id FROM public.bookings ORDER BY slot_id');
ok(!r.error, 'AFTER FIX: selecting bookings works (no recursion)', r.error?.message);
ok(r.rows && r.rows.length === 1 && r.rows[0].id, 'AFTER FIX: player sees their own booking', r.rows);

r = await asPlayer('SELECT id FROM public.availability_slots ORDER BY id');
ok(!r.error, 'AFTER FIX: selecting availability_slots works (no recursion)', r.error?.message);
const slotIds = (r.rows || []).map((x) => x.id);
ok(slotIds.includes(SLOT_PUB), 'AFTER FIX: player still sees the public slot', slotIds);
ok(slotIds.includes(SLOT_PRIV), 'AFTER FIX: player sees the PRIVATE slot they booked', slotIds);

// 4) A trainer reading their slots' bookings also works (was broken too).
async function asTrainer(sql) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('test.uid','${U.TR}',false);`);
  try { return { rows: (await db.query(sql)).rows, error: null }; }
  catch (e) { return { rows: null, error: e }; }
  finally { await db.exec('RESET ROLE'); }
}
r = await asTrainer('SELECT id FROM public.bookings');
ok(!r.error && r.rows.length === 1, 'AFTER FIX: trainer reads bookings for their slots', r.error?.message || r.rows);

console.log(fail === 0 ? '\nALL recursion-fix checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
