// Rehearsal for get_players_overview Phase-1 location union (migration 110090):
// the players-table location array = trained ∪ preferred club ∪ enrolled-intake,
// with trained gated to ACTIVE academy locations but deliberately-set preferred/intake
// shown even on inactive clubs; merged locations resolve to canonical; the location
// FILTER matches the same set. Standalone schema + the migration's full CREATE OR REPLACE.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let fail = 0;
const ok = (m, c, x) => { c ? console.log('PASS', m) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };

const A = '11111111-1111-1111-1111-111111111111';
const MGR = '99999999-9999-9999-9999-999999999991';
const T = '33333333-3333-3333-3333-333333333331';
const L1 = '55555555-5555-5555-5555-555555555551'; // active academy loc
const L2 = '55555555-5555-5555-5555-555555555552'; // INACTIVE academy loc
const L3 = '55555555-5555-5555-5555-555555555553'; // merged INTO L1
const L4 = '55555555-5555-5555-5555-555555555554'; // not an academy loc
const REG = '44444444-4444-4444-4444-444444444441';
const g = (n) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('app.uid', true), '')::uuid $$;
  CREATE FUNCTION public.fold_search_text(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(btrim(coalesce(t,''))) $$;
  CREATE FUNCTION public.digits_only(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT regexp_replace(coalesce(t,''), '\\D', '', 'g') $$;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
    skill_rating numeric, rating_system text, billing_business_name text, billing_address text, billing_btw_number text, birth_date date);
  CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
  CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
  CREATE FUNCTION public.is_academy_manager(_user_id uuid, _academy uuid) RETURNS boolean LANGUAGE sql STABLE AS
    $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers WHERE academy_profile_id=_academy AND user_id=_user_id) $$;
  CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
  CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trainer_id uuid, academy_profile_id uuid,
    full_name text NOT NULL, first_name text, last_name text, email text, phone text, skill_rating numeric,
    rating_system text DEFAULT 'knltb', notes text, billing_business_name text, billing_address text, billing_btw_number text,
    birth_date date, source text, has_trained boolean DEFAULT false, linked_profile_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(), preferred_location_id uuid);
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trainer_id uuid, location_id uuid,
    cyclus_id uuid, end_time timestamptz, academy_profile_id uuid);
  CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid, player_id uuid,
    guest_player_id uuid, status text, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.academy_player_metadata (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid,
    trainer_profile_id uuid, guest_player_id uuid, profile_id uuid, notes text, tag_ids uuid[] NOT NULL DEFAULT '{}',
    removed_at timestamptz, preferred_location_id uuid);
  CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), academy_profile_id uuid, trainer_id uuid,
    guest_player_id uuid, player_id uuid, status text, due_date date, paid_at timestamptz);
  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, merged_into uuid);
  CREATE TABLE public.academy_locations (academy_profile_id uuid, location_id uuid, is_active boolean DEFAULT true);
  CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid, guest_player_id uuid, location_id uuid);
  CREATE TABLE public.email_address_state (email text, state text);
`);

await db.exec(readFileSync('supabase/migrations/20260615110090_players_overview_location_union.sql', 'utf8'));
// Phase 2: the curated store + the function that reads it (supersedes 110090).
await db.exec(readFileSync('supabase/migrations/20260615110100_academy_player_locations.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260615110110_players_overview_read_manual_locations.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260615110120_get_player_locations.sql', 'utf8'));

// ---- seed ----
await db.exec(`
  INSERT INTO public.academy_managers VALUES ('${A}','${MGR}');
  INSERT INTO public.trainer_profiles VALUES ('${T}', gen_random_uuid());
  INSERT INTO public.academy_trainers VALUES ('${A}','${T}','active');
  INSERT INTO public.locations (id,name,merged_into) VALUES
    ('${L1}','Center Court',null),('${L2}','Side Court',null),('${L3}','Old Court','${L1}'),('${L4}','Foreign Court',null);
  INSERT INTO public.academy_locations (academy_profile_id,location_id,is_active) VALUES
    ('${A}','${L1}',true), ('${A}','${L2}',false);   -- L2 is the academy's but INACTIVE; L3/L4 not academy locations

  -- slots at each location (trainer T = in academy scope)
  INSERT INTO public.availability_slots (id,trainer_id,location_id,academy_profile_id,end_time) VALUES
    ('66666666-0000-0000-0000-000000000001','${T}','${L1}','${A}',now()),
    ('66666666-0000-0000-0000-000000000002','${T}','${L2}','${A}',now()),
    ('66666666-0000-0000-0000-000000000004','${T}','${L4}','${A}',now());

  -- guests (all academy A so they list regardless of bookings)
  INSERT INTO public.guest_players (id,academy_profile_id,full_name,preferred_location_id) VALUES
    ('${g(1)}','${A}','GA trains L1',          null),
    ('${g(2)}','${A}','GB prefers L1',         '${L1}'),
    ('${g(3)}','${A}','GC prefers inactive L2','${L2}'),
    ('${g(4)}','${A}','GD trains L4 foreign',  null),
    ('${g(5)}','${A}','GE intake L1',          null),
    ('${g(6)}','${A}','GF prefers merged L3',  '${L3}'),
    ('${g(7)}','${A}','GG trains inactive L2', null);
  INSERT INTO public.profiles (id,full_name) VALUES ('${REG}','REG meta-pref L1');

  -- bookings: GA→L1, GD→L4, GG→L2(inactive), REG(registered)→L4
  INSERT INTO public.bookings (slot_id,guest_player_id,status) VALUES
    ('66666666-0000-0000-0000-000000000001','${g(1)}','confirmed'),
    ('66666666-0000-0000-0000-000000000004','${g(4)}','confirmed'),
    ('66666666-0000-0000-0000-000000000002','${g(7)}','confirmed');
  INSERT INTO public.bookings (slot_id,player_id,status) VALUES
    ('66666666-0000-0000-0000-000000000004','${REG}','confirmed');

  -- intake (GE) + metadata preferred (REG)
  INSERT INTO public.intake_requests (guest_player_id,location_id) VALUES ('${g(5)}','${L1}');
  INSERT INTO public.academy_player_metadata (academy_profile_id,profile_id,preferred_location_id) VALUES ('${A}','${REG}','${L1}');
`);

await db.exec(`SET app.uid = '${MGR}'`);
const all = (await db.query(`SELECT * FROM public.get_players_overview('academy','${A}',null,'{}'::jsonb,'name','asc',100,0)`)).rows;
const byG = (gid) => all.find((r) => r.guest_player_id === gid);
const reg = all.find((r) => r.profile_id === REG && r.player_type === 'registered');
const locs = (r) => (r?.location_names ?? []).slice().sort();

ok('GA trained at active L1 → [Center Court]', JSON.stringify(locs(byG(g(1)))) === '["Center Court"]', locs(byG(g(1))));
ok('GB preferred L1, no booking → surfaces [Center Court] (the core fix)', JSON.stringify(locs(byG(g(2)))) === '["Center Court"]', locs(byG(g(2))));
ok('GC preferred INACTIVE academy loc L2 → shows [Side Court] (deliberate)', JSON.stringify(locs(byG(g(3)))) === '["Side Court"]', locs(byG(g(3))));
ok('GD trained at non-academy L4 → [] (excluded)', JSON.stringify(locs(byG(g(4)))) === '[]', locs(byG(g(4))));
ok('GE intake L1 → [Center Court]', JSON.stringify(locs(byG(g(5)))) === '["Center Court"]', locs(byG(g(5))));
ok('GF preferred MERGED L3 → resolves to canonical [Center Court]', JSON.stringify(locs(byG(g(6)))) === '["Center Court"]', locs(byG(g(6))));
ok('GG trained at INACTIVE L2 only (no preferred) → [] (trained still needs active)', JSON.stringify(locs(byG(g(7)))) === '[]', locs(byG(g(7))));
ok('REG metadata-preferred L1 (trains foreign L4) → [Center Court]', JSON.stringify(locs(reg)) === '["Center Court"]', locs(reg));

// ---- filter parity: filtering by a club returns exactly the players whose chip shows it ----
const filt = async (loc) => (await db.query(
  `SELECT * FROM public.get_players_overview('academy','${A}',null,$1::jsonb,'name','asc',100,0)`,
  [JSON.stringify({ location_id: loc })])).rows.map((r) => r.full_name).sort();
const f1 = await filt(L1);
ok('filter L1 → GA,GB,GE,GF,REG (trained+preferred+intake), not GC/GD/GG',
  JSON.stringify(f1) === JSON.stringify(['GA trains L1','GB prefers L1','GE intake L1','GF prefers merged L3','REG meta-pref L1']), f1);
const f2 = await filt(L2);
ok('filter L2 (inactive) → only GC (preferred)', JSON.stringify(f2) === JSON.stringify(['GC prefers inactive L2']), f2);

// ---- Phase 2: manual attach / dismiss via the curated store (set_player_location) ----
{
  const GH = g(8);
  // the curated store FKs academy_profile_id -> profiles; add the academy's profile row
  await db.exec(`INSERT INTO public.profiles (id, full_name) VALUES ('${A}', 'RL Academy') ON CONFLICT DO NOTHING`);
  await db.exec(`INSERT INTO public.guest_players (id,academy_profile_id,full_name) VALUES ('${GH}','${A}','GH manual only')`);
  // attach L1 to GH (no booking/preferred/intake); dismiss L1 for GA (who trains there)
  await db.exec(`SELECT public.set_player_location('${A}', null, '${GH}', '${L1}', false)`);
  await db.exec(`SELECT public.set_player_location('${A}', null, '${g(1)}', '${L1}', true)`);
  const r2 = (await db.query(`SELECT * FROM public.get_players_overview('academy','${A}',null,'{}'::jsonb,'name','asc',100,0)`)).rows;
  const Lof = (gid) => (r2.find((r) => r.guest_player_id === gid)?.location_names ?? []).slice().sort();
  ok('manual attach: GH (no other source) → [Center Court]', JSON.stringify(Lof(GH)) === '["Center Court"]', Lof(GH));
  ok('dismiss: GA (trained L1) suppressed → []', JSON.stringify(Lof(g(1))) === '[]', Lof(g(1)));

  // re-attach GA → shows again (idempotent flip)
  await db.exec(`SELECT public.set_player_location('${A}', null, '${g(1)}', '${L1}', false)`);
  const r3 = (await db.query(`SELECT * FROM public.get_players_overview('academy','${A}',null,'{}'::jsonb,'name','asc',100,0)`)).rows;
  ok('re-attach: GA → [Center Court] again',
    JSON.stringify((r3.find((r) => r.guest_player_id === g(1))?.location_names ?? []).slice().sort()) === '["Center Court"]');

  // filter parity: L1 now includes manual GH
  const f = (await db.query(`SELECT full_name FROM public.get_players_overview('academy','${A}',null,$1::jsonb,'name','asc',100,0)`,
    [JSON.stringify({ location_id: L1 })])).rows.map((r) => r.full_name);
  ok('filter L1 includes manually-attached GH', f.includes('GH manual only'), f);

  // RLS/auth: a non-manager cannot write the store
  let denied = false;
  await db.exec(`SET app.uid = '99999999-0000-0000-0000-000000000000'`);
  try { await db.query(`SELECT public.set_player_location('${A}', null, '${GH}', '${L1}', false)`); } catch (e) { denied = String(e).includes('not authorized'); }
  ok('set_player_location: non-manager rejected (42501)', denied);
  await db.exec(`SET app.uid = '${MGR}'`);

  // validation: a location that is not the academy's is rejected
  let badloc = false;
  try { await db.query(`SELECT public.set_player_location('${A}', null, '${GH}', '${L4}', false)`); } catch (e) { badloc = String(e).includes('not an academy location'); }
  ok('set_player_location: non-academy location rejected', badloc);

  // merged-location dismiss: a dismiss row pointing at a CHILD id (L3 merged into L1) must
  // still suppress the canonical L1 (e.g. a location merged AFTER the dismiss row was created).
  await db.exec(`INSERT INTO public.academy_player_locations (academy_profile_id, guest_player_id, location_id, dismissed) VALUES ('${A}','${g(2)}','${L3}', true)`);
  const r5 = (await db.query(`SELECT * FROM public.get_players_overview('academy','${A}',null,'{}'::jsonb,'name','asc',100,0)`)).rows;
  ok('merged dismiss: child-id dismiss (L3→L1) suppresses canonical L1 for GB',
    JSON.stringify((r5.find((r) => r.guest_player_id === g(2))?.location_names ?? []).slice().sort()) === '[]',
    (r5.find((r) => r.guest_player_id === g(2))?.location_names ?? []));
  const f5 = (await db.query(`SELECT full_name FROM public.get_players_overview('academy','${A}',null,$1::jsonb,'name','asc',100,0)`,
    [JSON.stringify({ location_id: L1 })])).rows.map((r) => r.full_name);
  ok('merged dismiss: GB excluded from filter L1 too (display↔filter parity)', !f5.includes('GB prefers L1'), f5);
}

// ---- per-player RPC get_player_locations (drives the profile UI; must equal the table) ----
{
  const gpl = async (gid) => (await db.query(`SELECT location_name FROM public.get_player_locations('${A}', null, '${gid}')`)).rows.map((r) => r.location_name).sort();
  ok('get_player_locations: GE (intake) → [Center Court]', JSON.stringify(await gpl(g(5))) === '["Center Court"]');
  ok('get_player_locations: GD (trained non-academy) → []', JSON.stringify(await gpl(g(4))) === '[]');
  ok('get_player_locations: GB (merged-dismissed) → []', JSON.stringify(await gpl(g(2))) === '[]');
  ok('get_player_locations: GH (manual attach) → [Center Court]', JSON.stringify(await gpl(g(8))) === '["Center Court"]');
  let denied = false;
  await db.exec(`SET app.uid = '99999999-0000-0000-0000-000000000000'`);
  try { await db.query(`SELECT * FROM public.get_player_locations('${A}', null, '${g(5)}')`); } catch (e) { denied = String(e).includes('not authorized'); }
  ok('get_player_locations: non-manager rejected (42501)', denied);
  await db.exec(`SET app.uid = '${MGR}'`);
}

console.log(`\n${fail ? `*** FAILED (${fail}) ***` : '*** PASSED ***'}`);
process.exit(fail ? 1 : 0);
