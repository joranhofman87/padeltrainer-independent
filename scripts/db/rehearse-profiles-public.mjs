import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const U = { PT: '10000000-0000-0000-0000-000000000001', TR2: '10000000-0000-0000-0000-000000000002',
  PL1: '10000000-0000-0000-0000-000000000003', PL2: '10000000-0000-0000-0000-000000000004',
  AM: '10000000-0000-0000-0000-000000000005' };
const P = { PT: '20000000-0000-0000-0000-000000000001', TR2: '20000000-0000-0000-0000-000000000002',
  PL1: '20000000-0000-0000-0000-000000000003', PL2: '20000000-0000-0000-0000-000000000004',
  AM: '20000000-0000-0000-0000-000000000005' };
const TP = { PT: '30000000-0000-0000-0000-000000000001', TR2: '30000000-0000-0000-0000-000000000002' };
const ACAD = '40000000-0000-0000-0000-000000000001';
const SLOT = '50000000-0000-0000-0000-000000000001';

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE FUNCTION auth.uid() RETURNS uuid AS $f$
    SELECT NULLIF(current_setting('test.uid', true), '')::uuid $f$ LANGUAGE sql STABLE;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, avatar_url text, bio text,
    location text, skill_rating numeric, rating_system text, rating_member_id text, created_at timestamptz default now(), updated_at timestamptz default now());
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid, is_public boolean);
  CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
  CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
  CREATE TABLE public.academy_trainers (trainer_profile_id uuid, academy_profile_id uuid, status text);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY default gen_random_uuid(), slot_id uuid, player_id uuid, status text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY default gen_random_uuid(), linked_profile_id uuid, academy_profile_id uuid);
  CREATE TABLE public.club_profiles (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.club_managers (club_profile_id uuid, user_id uuid);
  CREATE TABLE public.trainer_locations (trainer_id uuid, location_id uuid);
  CREATE TABLE public.admins (user_id uuid);

  CREATE FUNCTION public.get_profile_id_for_user(u uuid) RETURNS uuid AS $f$ SELECT id FROM public.profiles WHERE user_id = u $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_admin(u uuid) RETURNS boolean AS $f$ SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = u) $f$ LANGUAGE sql STABLE;
  CREATE FUNCTION public.is_player_of_trainer(pid uuid) RETURNS boolean AS $f$
    SELECT EXISTS (SELECT 1 FROM public.bookings b JOIN public.availability_slots s ON s.id=b.slot_id
      JOIN public.trainer_profiles tp ON tp.id=s.trainer_id WHERE b.player_id=pid AND tp.user_id=auth.uid()) $f$ LANGUAGE sql STABLE;

  INSERT INTO public.profiles (id,user_id,full_name) VALUES
    ('${P.PT}','${U.PT}','Public Trainer'),('${P.TR2}','${U.TR2}','Private Trainer'),
    ('${P.PL1}','${U.PL1}','Player One'),('${P.PL2}','${U.PL2}','Player Two'),('${P.AM}','${U.AM}','Academy Mgr');
  INSERT INTO public.trainer_profiles (id,user_id,is_public) VALUES ('${TP.PT}','${U.PT}',true),('${TP.TR2}','${U.TR2}',false);
  INSERT INTO public.academy_profiles (id) VALUES ('${ACAD}');
  INSERT INTO public.academy_managers (academy_profile_id,user_id) VALUES ('${ACAD}','${U.AM}');
  INSERT INTO public.academy_trainers (trainer_profile_id,academy_profile_id,status) VALUES ('${TP.TR2}','${ACAD}','active');
  INSERT INTO public.availability_slots (id,trainer_id,academy_profile_id) VALUES ('${SLOT}','${TP.TR2}','${ACAD}');
  INSERT INTO public.bookings (slot_id,player_id,status) VALUES ('${SLOT}','${P.PL1}','confirmed');
`);

const mig = readFileSync('supabase/migrations/20260613150000_profiles_public_restrict_rows.sql', 'utf8');
await db.exec(mig.slice(mig.indexOf('CREATE OR REPLACE VIEW')).replace(/GRANT SELECT[\s\S]*$/,''));

let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? '')); };
const visibleAs = async (uid) => {
  await db.exec(`SELECT set_config('test.uid', '${uid ?? ''}', false)`);
  const rows = (await db.query(`SELECT full_name FROM public.profiles_public ORDER BY full_name`)).rows.map((r) => r.full_name);
  return new Set(rows);
};

let v = await visibleAs(null); // anonymous
ok(v.has('Public Trainer') && !v.has('Player One') && !v.has('Player Two') && !v.has('Private Trainer'),
   'ANON: sees only the public trainer; NO players, NO private trainer', [...v]);

v = await visibleAs(U.PL2); // unrelated player
ok(v.has('Public Trainer') && v.has('Player Two') && !v.has('Player One') && !v.has('Private Trainer'),
   'UNRELATED PLAYER: sees public trainer + self only; NOT other players or private trainers', [...v]);

v = await visibleAs(U.PL1); // player at academy A, books private trainer TR2
ok(v.has('Public Trainer') && v.has('Player One') && v.has('Private Trainer') && !v.has('Player Two'),
   'PLAYER PL1: sees public trainer + self + the (private) trainer they book; NOT other players', [...v]);

v = await visibleAs(U.AM); // academy manager
ok(v.has('Private Trainer') && v.has('Player One') && !v.has('Player Two'),
   'ACADEMY MANAGER: sees their trainer + their player; NOT an unrelated player', [...v]);

v = await visibleAs(U.TR2); // the private trainer
ok(v.has('Private Trainer') && v.has('Player One') && !v.has('Player Two'),
   'TRAINER: sees self + their booked player; NOT an unrelated player', [...v]);

console.log(fail === 0 ? '\nALL profiles_public visibility checks passed' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
