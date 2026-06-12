/**
 * PGlite rehearsal for the get_players_overview RPC (real Postgres in WASM —
 * no Docker needed). Builds a minimal production-mirroring schema, stubs
 * auth.uid() + is_academy_manager, executes the ACTUAL migration files, seeds
 * edge-case data and asserts the full contract: membership, linked-canonical
 * COALESCE, search (tokens/diacritics/phone digits), every filter, pagination
 * totals, removal, authorization, and the 1500-row no-truncation loop.
 *
 * Run: npm run db:rehearse:players
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = [
  'supabase/migrations/20260611160000_players_overview_indexes.sql',
  'supabase/migrations/20260611160001_get_players_overview.sql',
  'supabase/migrations/20260611160002_get_players_overview_test.sql',
  // P-01 revision: the contract suite below must pass against the split-join version too.
  'supabase/migrations/20260612130000_p01_players_overview_split_meta_join.sql',
  // P-03 revision: filter facts pre-aggregated; same contract suite must pass.
  'supabase/migrations/20260612142000_p03_players_overview_filter_aggregates.sql',
];

const db = new PGlite();
let failures = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

// ---------- synthetic schema (only the columns the RPC touches) ----------
await db.exec(`
-- Supabase roles the migrations GRANT/REVOKE against (absent in bare PGlite)
CREATE ROLE anon;
CREATE ROLE authenticated;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
  $$ SELECT nullif(current_setting('app.uid', true), '')::uuid $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY, user_id uuid, full_name text, email text, phone text,
  skill_rating numeric, rating_system text, billing_business_name text,
  billing_address text, billing_btw_number text, birth_date date
);
CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
CREATE FUNCTION public.is_academy_manager(_user_id uuid, _academy uuid)
RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers
                    WHERE academy_profile_id = _academy AND user_id = _user_id) $$;
CREATE TABLE public.academy_trainers (
  academy_profile_id uuid, trainer_profile_id uuid, status text
);
CREATE TABLE public.guest_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid, academy_profile_id uuid, full_name text NOT NULL,
  first_name text, last_name text, email text, phone text,
  skill_rating numeric, rating_system text DEFAULT 'knltb', notes text,
  billing_business_name text, billing_address text, billing_btw_number text,
  birth_date date, source text, has_trained boolean DEFAULT false,
  linked_profile_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid, location_id uuid, cyclus_id uuid, end_time timestamptz,
  academy_profile_id uuid
);
CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid, player_id uuid, guest_player_id uuid, status text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.academy_player_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid, trainer_profile_id uuid,
  guest_player_id uuid, profile_id uuid,
  notes text, tag_ids uuid[] NOT NULL DEFAULT '{}', removed_at timestamptz
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid, trainer_id uuid, guest_player_id uuid, player_id uuid,
  status text, due_date date, paid_at timestamptz
);
CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
CREATE TABLE public.academy_locations (
  academy_profile_id uuid, location_id uuid, is_active boolean DEFAULT true
);
`);

// ---------- run the REAL migrations ----------
for (const file of MIGRATIONS) {
  await db.exec(readFileSync(join(process.cwd(), file), 'utf8'));
}
console.log('migrations applied OK');

// ---------- seed ----------
const A1 = '11111111-1111-1111-1111-111111111111';
const MGR = '99999999-9999-9999-9999-999999999991';
const T1 = '33333333-3333-3333-3333-333333333331';
const T1_USER = '99999999-9999-9999-9999-999999999992';
const T2 = '33333333-3333-3333-3333-333333333332';
const LOC1 = '55555555-5555-5555-5555-555555555551';
const LOC2 = '55555555-5555-5555-5555-555555555552';
const TAG1 = '77777777-7777-7777-7777-777777777771';
const P_LINKED = '44444444-4444-4444-4444-444444444441';
const P_REG = '44444444-4444-4444-4444-444444444442';
const P_REMOVED = '44444444-4444-4444-4444-444444444443';
const G_LINKED = 'aaaaaaaa-0000-0000-0000-000000000001';
const G_PLAIN = 'aaaaaaaa-0000-0000-0000-000000000002';
const G_TRAINER = 'aaaaaaaa-0000-0000-0000-000000000003';
const G_REMOVED = 'aaaaaaaa-0000-0000-0000-000000000004';
const CYCLE = '88888888-8888-8888-8888-888888888881';

await db.exec(`
INSERT INTO public.academy_managers VALUES ('${A1}', '${MGR}');
INSERT INTO public.trainer_profiles VALUES ('${T1}', '${T1_USER}'), ('${T2}', gen_random_uuid());
INSERT INTO public.academy_trainers VALUES ('${A1}', '${T1}', 'active'), ('${A1}', '${T2}', 'inactive');
INSERT INTO public.locations VALUES ('${LOC1}', 'Center Court'), ('${LOC2}', 'Beach Club');
INSERT INTO public.academy_locations (academy_profile_id, location_id, is_active)
  VALUES ('${A1}', '${LOC1}', true);

INSERT INTO public.profiles (id, full_name, email, phone, skill_rating, rating_system, billing_business_name) VALUES
  ('${P_LINKED}', 'Émilie Fresh-Profile', 'emilie.new@test.com', '+31 6 1234 0000', 7.5, 'knltb', 'Émilie BV'),
  ('${P_REG}', 'Reg Player', 'reg@test.com', null, 5, 'knltb', null),
  ('${P_REMOVED}', 'Removed Reg', 'removedreg@test.com', null, null, 'knltb', null);

INSERT INTO public.guest_players (id, academy_profile_id, trainer_id, full_name, email, phone, skill_rating, notes, linked_profile_id, billing_business_name) VALUES
  ('${G_LINKED}', '${A1}', null, 'Emilie Stale-Guest', 'emilie.old@test.com', '+31600000000', 2, 'guest intake note', '${P_LINKED}', null),
  ('${G_PLAIN}', '${A1}', null, 'Anna Academy', 'anna@test.com', '0612345678', 2.5, null, null, 'Padel Pro BV'),
  ('${G_TRAINER}', null, '${T1}', 'Bart Trainerguest', null, null, null, null, null, null),
  ('${G_REMOVED}', '${A1}', null, 'Gone Guest', 'gone@test.com', null, null, null, null, null);

-- removal metadata (academy scope): one guest + one registered profile
INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, removed_at)
  VALUES ('${A1}', '${G_REMOVED}', now());
INSERT INTO public.academy_player_metadata (academy_profile_id, profile_id, removed_at)
  VALUES ('${A1}', '${P_REMOVED}', now());
-- tags + notes for Anna
INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes, tag_ids)
  VALUES ('${A1}', '${G_PLAIN}', 'academy note about Anna', ARRAY['${TAG1}']::uuid[]);

-- slots: T1 active-cycle slot at LOC1; T1 past slot at LOC2 (not an academy location)
INSERT INTO public.availability_slots (id, trainer_id, location_id, cyclus_id, end_time, academy_profile_id) VALUES
  ('66666666-6666-6666-6666-666666666661', '${T1}', '${LOC1}', '${CYCLE}', now() + interval '30 days', '${A1}'),
  ('66666666-6666-6666-6666-666666666662', '${T1}', '${LOC2}', null, now() - interval '10 days', '${A1}');

-- bookings: registered P_REG confirmed on cycle slot; removed P_REMOVED confirmed;
-- linked profile P_LINKED also has a booking (must stay deduped to the guest);
-- Anna (guest) booked on the past LOC2 slot
INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status) VALUES
  ('66666666-6666-6666-6666-666666666661', '${P_REG}', null, 'confirmed'),
  ('66666666-6666-6666-6666-666666666661', '${P_REMOVED}', null, 'confirmed'),
  ('66666666-6666-6666-6666-666666666661', '${P_LINKED}', null, 'confirmed'),
  ('66666666-6666-6666-6666-666666666662', null, '${G_PLAIN}', 'completed'),
  ('66666666-6666-6666-6666-666666666661', null, '${G_PLAIN}', 'pending');

-- invoices: Anna overdue (past due, unpaid); Reg paid
INSERT INTO public.invoices (academy_profile_id, guest_player_id, status, due_date) VALUES
  ('${A1}', '${G_PLAIN}', 'sent', current_date - 10);
INSERT INTO public.invoices (academy_profile_id, player_id, status, due_date, paid_at) VALUES
  ('${A1}', '${P_REG}', 'paid', current_date - 10, now());
`);

// ---------- helpers ----------
type Row = Record<string, unknown>;
async function rpc(opts: {
  uid?: string; scope?: string; scopeId?: string; search?: string | null;
  filters?: Record<string, unknown>; sort?: string; dir?: string; limit?: number; offset?: number;
}): Promise<Row[]> {
  const {
    uid = MGR, scope = 'academy', scopeId = A1, search = null,
    filters = {}, sort = 'name', dir = 'asc', limit = 50, offset = 0,
  } = opts;
  await db.exec(`SET app.uid = '${uid}'`);
  const res = await db.query(
    `SELECT * FROM public.get_players_overview($1,$2,$3,$4,$5,$6,$7,$8)`,
    [scope, scopeId, search, JSON.stringify(filters), sort, dir, limit, offset],
  );
  return res.rows as Row[];
}
const names = (rows: Row[]) => rows.map((r) => r.full_name);

// ---------- assertions ----------
{
  const rows = await rpc({});
  check('membership: 4 players (3 guests + 1 registered), removed excluded',
    rows.length === 4 && Number(rows[0].total_count) === 4, names(rows));
  check('sorted by name', JSON.stringify(names(rows)) ===
    JSON.stringify(['Anna Academy', 'Bart Trainerguest', 'Reg Player', 'Émilie Fresh-Profile'])
    || JSON.stringify(names(rows)) ===
    JSON.stringify(['Anna Academy', 'Bart Trainerguest', 'Émilie Fresh-Profile', 'Reg Player']), names(rows));

  const linked = rows.find((r) => r.guest_player_id === G_LINKED) as Row;
  check('linked-canonical: profile name/email/phone/skill win over stale guest copy',
    !!linked && linked.full_name === 'Émilie Fresh-Profile'
    && linked.email === 'emilie.new@test.com'
    && Number(linked.skill_rating) === 7.5
    && linked.billing_business_name === 'Émilie BV', linked);
  check('linked-canonical: guest relationship fields survive (notes)',
    !!linked && linked.notes === 'guest intake note', linked?.notes);
  check('linked profile deduped from registered list',
    !rows.some((r) => r.player_key === `p_${P_LINKED}`), names(rows));

  const anna = rows.find((r) => r.guest_player_id === G_PLAIN) as Row;
  check('enrichment: Anna has tag, academy note, overdue payment, no active cyclus (pending booking ignored)',
    !!anna && (anna.tag_ids as string[]).includes(TAG1)
    && anna.academy_notes === 'academy note about Anna'
    && anna.has_overdue_payment === true
    && anna.has_active_cyclus === false, anna);
  check('enrichment: Anna location LOC2 excluded (not an academy location)',
    !!anna && (anna.location_ids as string[]).length === 0, anna?.location_ids);

  const reg = rows.find((r) => r.player_key === `p_${P_REG}`) as Row;
  check('registered: active cyclus + paid (not overdue) + location from academy slot',
    !!reg && reg.has_active_cyclus === true && reg.has_overdue_payment === false
    && (reg.location_names as string[]).includes('Center Court'), reg);
}

{
  check('search: diacritic-insensitive name', names(await rpc({ search: 'emilie' })).length === 1);
  check('search: business name', (await rpc({ search: 'padel pro' })).length === 1);
  check('search: token-AND across fields (name + business)',
    (await rpc({ search: 'anna padel' })).length === 1
    && (await rpc({ search: 'anna xyz' })).length === 0);
  check('search: phone digits across formatting', (await rpc({ search: '1234-0000' })).length === 1);
  check('search: email partial', (await rpc({ search: 'emilie.new@' })).length === 1);
}

{
  check('filter: tag', names(await rpc({ filters: { tag_id: TAG1 } })).length === 1);
  check('filter: untagged', (await rpc({ filters: { tag_id: 'untagged' } })).length === 3);
  check('filter: level band beginner (null,3]', (await rpc({ filters: { level_max: 3 } })).length === 1);
  check('filter: level band advanced (6,9]', (await rpc({ filters: { level_gt: 6, level_max: 9 } })).length === 1);
  check('filter: unrated', (await rpc({ filters: { level_unrated: true } })).length === 1);
  check('filter: active cyclus true (incl. linked guest via profile booking)', (await rpc({ filters: { has_active_cyclus: true } })).length === 2);
  check('filter: payment overdue', (await rpc({ filters: { payment: 'overdue' } })).length === 1);
  check('filter: payment ok', (await rpc({ filters: { payment: 'ok' } })).length === 3);
  check('filter: location LOC1 (reg + linked guest)', (await rpc({ filters: { location_id: LOC1 } })).length === 2);
  check('filter: trainer T1 (owner, booking, or linked-profile booking)',
    (await rpc({ filters: { trainer_id: T1 } })).length === 4);
}

{
  const p1 = await rpc({ limit: 2, offset: 0 });
  const p2 = await rpc({ limit: 2, offset: 2 });
  check('pagination: totals constant, pages disjoint, union complete',
    Number(p1[0].total_count) === 4 && Number(p2[0].total_count) === 4
    && new Set([...p1, ...p2].map((r) => r.player_key)).size === 4, { p1: names(p1), p2: names(p2) });
}

{
  const trainerRows = await rpc({ uid: T1_USER, scope: 'trainer', scopeId: T1 });
  check('trainer scope: own guest only (academy guests not visible)',
    trainerRows.some((r) => r.guest_player_id === G_TRAINER)
    && !trainerRows.some((r) => r.guest_player_id === G_PLAIN), names(trainerRows));
}

{
  let denied = false;
  try {
    await rpc({ uid: T1_USER }); // trainer user asking for academy scope
  } catch (e) {
    denied = String(e).includes('not authorized');
  }
  check('authorization: non-manager rejected for academy scope', denied);
}

{
  // ---- no-truncation: 1500 guests, page-through must return them all ----
  await db.exec(`
    INSERT INTO public.guest_players (academy_profile_id, full_name)
    SELECT '${A1}', 'Bulk Player ' || lpad(i::text, 5, '0') FROM generate_series(1, 1500) i;
  `);
  let offset = 0;
  let total = -1;
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const rows = await rpc({ limit: 200, offset });
    if (rows.length === 0) break;
    total = Number(rows[0].total_count);
    rows.forEach((r) => seen.add(r.player_key as string));
    offset += 200;
    if (offset >= total) break;
  }
  check('scale: 1504 players fully page-through (no 1000-row truncation)',
    total === 1504 && seen.size === 1504, { total, seen: seen.size });
}

console.log(failures ? `\n*** REHEARSAL FAILED (${failures}) ***` : '\n*** REHEARSAL PASSED ***');
process.exit(failures ? 1 : 0);
