/**
 * PGlite rehearsal for merge_guest_players (20260611200000). Runs the ACTUAL
 * migration against a synthetic schema incl. the partial unique indexes and
 * asserts: relation repointing, metadata union/move, priority-claim dedupe,
 * email keep without unique-index conflict, has_trained OR, linked coalesce,
 * linked-account conflict rejection, scope membership and authorization.
 *
 * Run: npx tsx scripts/db/rehearse-merge-players.ts
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
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS
  $$ SELECT nullif(current_setting('app.uid', true), '')::uuid $$;
CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
CREATE FUNCTION public.is_academy_manager(_user_id uuid, _academy uuid)
RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT EXISTS (SELECT 1 FROM public.academy_managers
                    WHERE academy_profile_id = _academy AND user_id = _user_id) $$;
CREATE TABLE public.academy_trainers (academy_profile_id uuid, trainer_profile_id uuid, status text);

CREATE TABLE public.guest_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid, academy_profile_id uuid, full_name text NOT NULL,
  first_name text, last_name text, email text, phone text,
  skill_rating numeric, rating_system text DEFAULT 'knltb', notes text,
  billing_business_name text, billing_address text, billing_btw_number text,
  birth_date date, source text, has_trained boolean DEFAULT false,
  preferred_location_id uuid, linked_profile_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_gp_trainer_email ON public.guest_players (trainer_id, email)
  WHERE email IS NOT NULL AND email <> '' AND trainer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_gp_academy_email ON public.guest_players (academy_profile_id, email)
  WHERE email IS NOT NULL AND email <> '' AND academy_profile_id IS NOT NULL AND trainer_id IS NULL;

CREATE TABLE public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid,
  player_id uuid, guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
  status text
);
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_player_id uuid REFERENCES public.guest_players(id), player_id uuid
);
CREATE TABLE public.intake_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_player_id uuid REFERENCES public.guest_players(id)
);
CREATE TABLE public.slot_priority_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid, guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX uq_claims_slot_guest ON public.slot_priority_claims (slot_id, guest_player_id);
CREATE TABLE public.academy_player_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_profile_id uuid, trainer_profile_id uuid,
  guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE CASCADE,
  profile_id uuid, notes text, tag_ids uuid[] NOT NULL DEFAULT '{}', removed_at timestamptz
);
CREATE UNIQUE INDEX uq_meta_academy_guest ON public.academy_player_metadata (academy_profile_id, guest_player_id)
  WHERE guest_player_id IS NOT NULL AND academy_profile_id IS NOT NULL;
`);

await db.exec(readFileSync(join(process.cwd(), 'supabase/migrations/20260611200000_merge_guest_players.sql'), 'utf8'));
console.log('migration applied OK');

const A1 = '11111111-1111-1111-1111-111111111111';
const MGR = '99999999-9999-9999-9999-999999999991';
const T1 = '33333333-3333-3333-3333-333333333331';
const T1_USER = '99999999-9999-9999-9999-999999999992';
const SRC = 'aaaaaaaa-0000-0000-0000-000000000001'; // has invoices + email
const TGT = 'aaaaaaaa-0000-0000-0000-000000000002'; // has the cyclus bookings
const OTHER = 'aaaaaaaa-0000-0000-0000-000000000003';
const TAG1 = '77777777-7777-7777-7777-777777777771';
const TAG2 = '77777777-7777-7777-7777-777777777772';
const SLOT_SHARED = '66666666-6666-6666-6666-666666666661';
const SLOT_SRC = '66666666-6666-6666-6666-666666666662';
const P1 = '44444444-4444-4444-4444-444444444441';

await db.exec(`
INSERT INTO public.academy_managers VALUES ('${A1}', '${MGR}');
INSERT INTO public.trainer_profiles VALUES ('${T1}', '${T1_USER}');
INSERT INTO public.academy_trainers VALUES ('${A1}', '${T1}', 'active');

INSERT INTO public.guest_players (id, academy_profile_id, full_name, email, phone, skill_rating, has_trained, linked_profile_id) VALUES
  ('${SRC}', '${A1}', 'Jan Janssen', 'jan@test.com', '+3160001', 4.0, true, '${P1}'),
  ('${TGT}', '${A1}', 'Jan Jansen', null, '+3160002', 5.5, false, null),
  ('${OTHER}', '${A1}', 'Other Player', 'other@test.com', null, null, false, null);

-- source: 2 invoices + 1 intake + claims on shared+own slot + metadata (tags TAG1, notes)
INSERT INTO public.invoices (guest_player_id) VALUES ('${SRC}'), ('${SRC}');
INSERT INTO public.intake_requests (guest_player_id) VALUES ('${SRC}');
INSERT INTO public.slot_priority_claims (slot_id, guest_player_id) VALUES
  ('${SLOT_SHARED}', '${SRC}'), ('${SLOT_SRC}', '${SRC}');
INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes, tag_ids) VALUES
  ('${A1}', '${SRC}', 'src note', ARRAY['${TAG1}','${TAG2}']::uuid[]);

-- target: 3 cyclus bookings + claim on shared slot + metadata (TAG2, notes)
INSERT INTO public.bookings (slot_id, guest_player_id, status) VALUES
  (gen_random_uuid(), '${TGT}', 'confirmed'), (gen_random_uuid(), '${TGT}', 'confirmed'), (gen_random_uuid(), '${TGT}', 'completed');
INSERT INTO public.slot_priority_claims (slot_id, guest_player_id) VALUES ('${SLOT_SHARED}', '${TGT}');
INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes, tag_ids) VALUES
  ('${A1}', '${TGT}', 'tgt note', ARRAY['${TAG2}']::uuid[]);
`);

const rpc = async (uid: string, args: string) => {
  await db.exec(`SET app.uid = '${uid}'`);
  return (await db.query(`SELECT public.merge_guest_players(${args}) AS r`)).rows[0] as { r: Record<string, unknown> };
};
const q = async (sql: string) => (await db.query(sql)).rows as Record<string, unknown>[];

// auth rejection
{
  let denied = false;
  try { await rpc(T1_USER, `'academy','${A1}','${SRC}'::uuid,'${TGT}'::uuid`); }
  catch (e) { denied = String(e).includes('not authorized'); }
  check('authorization: non-manager rejected', denied);
}
// self-merge rejection
{
  let rejected = false;
  try { await rpc(MGR, `'academy','${A1}','${SRC}'::uuid,'${SRC}'::uuid`); }
  catch (e) { rejected = String(e).includes('same player'); }
  check('self-merge rejected', rejected);
}

// the real merge: keep source's email + name, everything combined
{
  const { r } = await rpc(MGR,
    `'academy','${A1}','${SRC}'::uuid,'${TGT}'::uuid,` +
    `'{"email":"jan@test.com","full_name":"Jan Janssen","phone":"+3160001"}'::jsonb`);
  check('result counts: 2 invoices, 1 intake, 1 claim moved + 1 deduped, 1 metadata merged',
    r.invoices_moved === 2 && r.intake_requests_moved === 1
    && r.priority_claims_moved === 1 && r.priority_claims_deduped === 1
    && r.metadata_rows_merged === 1 && r.bookings_moved === 0, r);

  const src = await q(`SELECT 1 FROM public.guest_players WHERE id='${SRC}'`);
  check('source deleted', src.length === 0);

  const tgt = (await q(`SELECT full_name, email, phone, skill_rating::float AS sr, has_trained, linked_profile_id::text AS lp FROM public.guest_players WHERE id='${TGT}'`))[0];
  check('target keeps chosen identity (source email/name/phone) + own rating',
    tgt.full_name === 'Jan Janssen' && tgt.email === 'jan@test.com'
    && tgt.phone === '+3160001' && tgt.sr === 5.5, tgt);
  check('has_trained OR-combined + linked profile coalesced',
    tgt.has_trained === true && tgt.lp === P1, tgt);

  const inv = await q(`SELECT count(*)::int AS n FROM public.invoices WHERE guest_player_id='${TGT}'`);
  const bok = await q(`SELECT count(*)::int AS n FROM public.bookings WHERE guest_player_id='${TGT}'`);
  check('target now owns invoices AND the cyclus bookings', inv[0].n === 2 && bok[0].n === 3, { inv, bok });

  const meta = (await q(`SELECT notes, tag_ids FROM public.academy_player_metadata WHERE guest_player_id='${TGT}'`))[0];
  const tags = meta.tag_ids as string[];
  check('metadata: tags union (2 distinct), notes concatenated',
    tags.length === 2 && tags.includes(TAG1) && tags.includes(TAG2)
    && String(meta.notes).includes('tgt note') && String(meta.notes).includes('src note'), meta);

  const claims = await q(`SELECT slot_id::text AS s FROM public.slot_priority_claims WHERE guest_player_id='${TGT}' ORDER BY s`);
  check('claims: shared slot deduped, source-only slot moved',
    claims.length === 2 && new Set(claims.map(c => c.s)).size === 2, claims);
}

// linked-account conflict
{
  await db.exec(`
    INSERT INTO public.guest_players (id, academy_profile_id, full_name, linked_profile_id) VALUES
      ('bbbbbbbb-0000-0000-0000-000000000001', '${A1}', 'Linked A', '44444444-4444-4444-4444-444444444442'),
      ('bbbbbbbb-0000-0000-0000-000000000002', '${A1}', 'Linked B', '44444444-4444-4444-4444-444444444443');
  `);
  let rejected = false;
  try { await rpc(MGR, `'academy','${A1}','bbbbbbbb-0000-0000-0000-000000000001'::uuid,'bbbbbbbb-0000-0000-0000-000000000002'::uuid`); }
  catch (e) { rejected = String(e).includes('different accounts'); }
  check('two different claimed accounts rejected', rejected);
}

// trainer scope + out-of-scope rejection
{
  await db.exec(`
    INSERT INTO public.guest_players (id, trainer_id, full_name, email) VALUES
      ('cccccccc-0000-0000-0000-000000000001', '${T1}', 'Trainer Dup A', 'dup@test.com'),
      ('cccccccc-0000-0000-0000-000000000002', '${T1}', 'Trainer Dup B', null);
  `);
  const { r } = await rpc(T1_USER,
    `'trainer','${T1}','cccccccc-0000-0000-0000-000000000001'::uuid,'cccccccc-0000-0000-0000-000000000002'::uuid,'{"email":"dup@test.com"}'::jsonb`);
  const tgt = (await q(`SELECT email FROM public.guest_players WHERE id='cccccccc-0000-0000-0000-000000000002'`))[0];
  check('trainer scope merge works, source email kept without unique conflict',
    tgt.email === 'dup@test.com' && typeof r === 'object', { tgt, r });

  let rejected = false;
  try { await rpc(T1_USER, `'trainer','${T1}','${OTHER}'::uuid,'cccccccc-0000-0000-0000-000000000002'::uuid`); }
  catch (e) { rejected = String(e).includes('belong to the trainer'); }
  check('out-of-scope source rejected for trainer', rejected);
}

console.log(failures ? `\n*** REHEARSAL FAILED (${failures}) ***` : '\n*** REHEARSAL PASSED ***');
process.exit(failures ? 1 : 0);
