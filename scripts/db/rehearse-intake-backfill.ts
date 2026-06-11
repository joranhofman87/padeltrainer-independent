/**
 * PGlite rehearsal for the intake-applicants backfill
 * (20260611180000_backfill_intake_guest_players.sql). Real Postgres in WASM;
 * runs the ACTUAL migration files against a synthetic schema with edge-case
 * data and asserts linking, creation, grouping, scope isolation, club pass,
 * removal respect and idempotency.
 *
 * Run: npx tsx scripts/db/rehearse-intake-backfill.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const db = new PGlite();
let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

await db.exec(`
CREATE TABLE public.guest_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid, academy_profile_id uuid, full_name text NOT NULL,
  first_name text, last_name text, email text, phone text,
  skill_rating numeric, rating_system text DEFAULT 'knltb', notes text,
  birth_date date, source text, has_trained boolean DEFAULT false,
  linked_profile_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
-- the partial unique indexes the inserts must respect
CREATE UNIQUE INDEX idx_gp_trainer_email ON public.guest_players (trainer_id, email)
  WHERE email IS NOT NULL AND email <> '' AND trainer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_gp_academy_email ON public.guest_players (academy_profile_id, email)
  WHERE email IS NOT NULL AND email <> '' AND academy_profile_id IS NOT NULL AND trainer_id IS NULL;

CREATE TABLE public.club_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_profile_id uuid NOT NULL, full_name text NOT NULL, email text NOT NULL,
  phone text, skill_rating numeric, rating_system text DEFAULT 'knltb',
  linked_profile_id uuid, source text, has_trained boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.cycles (id uuid PRIMARY KEY, owner_type text, owner_id uuid);
CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);
CREATE TABLE public.intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid, full_name text, email text, phone text,
  rating numeric, rating_system text, birth_date text,
  player_id uuid, guest_player_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
`);

const T1 = '33333333-3333-3333-3333-333333333331';
const A1 = '11111111-1111-1111-1111-111111111111';
const CLUB = '22222222-2222-2222-2222-222222222221';
const CY_T = '88888888-8888-8888-8888-888888888881';
const CY_A = '88888888-8888-8888-8888-888888888882';
const CY_C = '88888888-8888-8888-8888-888888888883';
const P1 = '44444444-4444-4444-4444-444444444441';
const G_EXISTING = 'aaaaaaaa-0000-0000-0000-000000000001';
const G_ANON = 'aaaaaaaa-0000-0000-0000-000000000002';

await db.exec(`
INSERT INTO public.cycles VALUES
  ('${CY_T}', 'trainer', '${T1}'), ('${CY_A}', 'academy', '${A1}'), ('${CY_C}', 'club', '${CLUB}');
INSERT INTO public.academy_trainers VALUES ('${A1}', '${T1}', 'active');

-- existing trainer guest with a known email (intake should LINK, not duplicate)
INSERT INTO public.guest_players (id, trainer_id, full_name, email)
  VALUES ('${G_EXISTING}', '${T1}', 'Existing Emma', 'emma@test.com');
-- anonymous-path intake already linked (must be untouched)
INSERT INTO public.guest_players (id, trainer_id, full_name, email)
  VALUES ('${G_ANON}', '${T1}', 'Anon Andy', 'andy@test.com');

INSERT INTO public.intake_requests (cycle_id, full_name, email, phone, rating, birth_date, player_id, guest_player_id, created_at) VALUES
  -- 1. trainer cycle, matches existing guest by email (case-insensitive) -> link
  ('${CY_T}', 'Emma Applicant', 'EMMA@test.com', null, null, null, null, null, now() - interval '9 days'),
  -- 2+3. trainer cycle, same NEW person twice (older has no phone, newer has phone) -> ONE guest from latest
  ('${CY_T}', 'Nina New', 'nina@test.com', null, 4.5, '1995-05-05', '${P1}', null, now() - interval '8 days'),
  ('${CY_T}', 'Nina New', 'nina@test.com', '+31612340000', 5.0, '1995-05-05', '${P1}', null, now() - interval '2 days'),
  -- 4. already linked by the anonymous edge-fn path -> untouched
  ('${CY_T}', 'Anon Andy', 'andy@test.com', null, null, null, null, '${G_ANON}', now() - interval '7 days'),
  -- 5. academy cycle, brand-new person -> academy guest created
  ('${CY_A}', 'Academy Alice', 'alice@test.com', '0611111111', 6.5, null, null, null, now() - interval '6 days'),
  -- 6. academy cycle, email matches the TRAINER-owned guest of its active trainer -> link, no new row
  ('${CY_A}', 'Emma Applicant', 'emma@test.com', null, null, null, null, null, now() - interval '5 days'),
  -- 7. club cycle, new person -> club_players row
  ('${CY_C}', 'Club Carl', 'carl@test.com', null, null, null, null, null, now() - interval '4 days'),
  -- 8. blank name + no identifiers -> skipped, stays unlinked but is not "actionable"
  ('${CY_T}', '   ', '', null, null, null, null, null, now() - interval '3 days'),
  -- 9. no email but has player_id -> guest created keyed by profile
  ('${CY_T}', 'Profile Pete', '', null, null, null, '${P1.replace(/1$/, '9')}', null, now() - interval '1 day')
`);

const MIGRATIONS = [
  'supabase/migrations/20260611180000_backfill_intake_guest_players.sql',
  'supabase/migrations/20260611180001_backfill_intake_guest_players_test.sql',
];
console.log('--- RUN 1 ---');
for (const f of MIGRATIONS) await db.exec(readFileSync(join(process.cwd(), f), 'utf8'));

const q = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];

{
  const r = await q(`SELECT guest_player_id::text AS g FROM public.intake_requests WHERE email ILIKE 'emma@test.com' AND cycle_id='${CY_T}'`);
  check('1. trainer intake linked to existing guest (case-insensitive email)', r[0]?.g === G_EXISTING, r);
}
{
  const r = await q(`SELECT count(*)::int AS n FROM public.guest_players WHERE trainer_id='${T1}' AND email='nina@test.com'`);
  check('2. duplicate intakes -> ONE new guest', r[0].n === 1, r);
  const g = await q(`SELECT phone, skill_rating::float AS sr, first_name, last_name, linked_profile_id::text AS lp, source FROM public.guest_players WHERE email='nina@test.com'`);
  check('2b. latest intake wins (phone + rating) + names split + linked + source',
    g[0]?.phone === '+31612340000' && g[0]?.sr === 5 && g[0]?.first_name === 'Nina'
    && g[0]?.last_name === 'New' && g[0]?.lp === P1 && g[0]?.source === 'cycle_registration', g);
  const both = await q(`SELECT count(DISTINCT guest_player_id)::int AS n FROM public.intake_requests WHERE email='nina@test.com'`);
  check('2c. both Nina intakes linked to that one guest', both[0].n === 1, both);
}
{
  const r = await q(`SELECT guest_player_id::text AS g FROM public.intake_requests WHERE full_name='Anon Andy'`);
  check('4. pre-linked (anonymous path) intake untouched', r[0]?.g === G_ANON, r);
}
{
  const r = await q(`SELECT academy_profile_id::text AS a, trainer_id FROM public.guest_players WHERE email='alice@test.com'`);
  check('5. academy guest created (academy-owned, no trainer)', r[0]?.a === A1 && r[0]?.trainer_id === null, r);
}
{
  const r = await q(`SELECT guest_player_id::text AS g FROM public.intake_requests WHERE cycle_id='${CY_A}' AND email='emma@test.com'`);
  check('6. academy intake linked to active-trainer-owned guest (scope union, no duplicate)', r[0]?.g === G_EXISTING, r);
  const dup = await q(`SELECT count(*)::int AS n FROM public.guest_players WHERE lower(email)='emma@test.com'`);
  check('6b. no duplicate Emma guest created', dup[0].n === 1, dup);
}
{
  const r = await q(`SELECT club_profile_id::text AS c, full_name FROM public.club_players WHERE email='carl@test.com'`);
  check('7. club applicant -> club_players row', r[0]?.c === CLUB && r[0]?.full_name === 'Club Carl', r);
}
{
  const r = await q(`SELECT guest_player_id FROM public.intake_requests WHERE btrim(full_name)=''`);
  check('8. nameless intake skipped (stays unlinked)', r[0]?.guest_player_id === null, r);
}
{
  const r = await q(`SELECT count(*)::int AS n FROM public.guest_players WHERE full_name='Profile Pete' AND email IS NULL`);
  check('9. emailless intake with player_id -> emailless guest created', r[0].n === 1, r);
}

// idempotency
const before = (await q(`SELECT count(*)::int AS n FROM public.guest_players`))[0].n;
const beforeClub = (await q(`SELECT count(*)::int AS n FROM public.club_players`))[0].n;
console.log('--- RUN 2 (idempotency) ---');
for (const f of MIGRATIONS) await db.exec(readFileSync(join(process.cwd(), f), 'utf8'));
const after = (await q(`SELECT count(*)::int AS n FROM public.guest_players`))[0].n;
const afterClub = (await q(`SELECT count(*)::int AS n FROM public.club_players`))[0].n;
check('idempotent re-run (guests + club rows unchanged)', before === after && beforeClub === afterClub,
  { before, after, beforeClub, afterClub });

console.log(failures ? `\n*** REHEARSAL FAILED (${failures}) ***` : '\n*** REHEARSAL PASSED ***');
process.exit(failures ? 1 : 0);
