/**
 * PGlite rehearsal for the registration WRITE RPCs
 * (20260630130000_registration_write_rpcs.sql). Real Postgres in WASM; runs the
 * ACTUAL migration against a synthetic schema and asserts:
 *   - create makes exactly one type='cyclus' cycle + one registration linked by
 *     source_cycle_id, with the FORM-ONLY settings on the registration and the
 *     FULL settings kept on the cycle;
 *   - owner authorization (trainer via trainer_profiles, academy via the helper)
 *     blocks a non-owner;
 *   - update ADOPTS a legacy (no-registration) cycle by creating its row;
 *   - update of an already-split cycle updates in place (no duplicate; the
 *     uq_registrations_source_cycle unique index holds);
 *   - the source_cycle_id == cycle.id invariant.
 *
 * Run: npx tsx scripts/db/rehearse-registration-write.ts
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

const U_TRAINER = '10000000-0000-0000-0000-000000000001'; // auth user owning T1
const U_ACADEMY = '10000000-0000-0000-0000-000000000002'; // auth user managing A1
const U_OTHER = '10000000-0000-0000-0000-000000000003';   // unrelated user
const T1 = '33333333-3333-3333-3333-333333333331';
const A1 = '11111111-1111-1111-1111-111111111111';

const setUid = async (uid: string) => { await db.query(`SELECT set_config('test.uid', $1, false)`, [uid]); };

// ── Synthetic schema + stubs (must exist BEFORE the migration's functions) ──
await db.exec(`
-- Supabase provides these base roles in real db reset; stub for PGlite so the
-- migration's GRANT … TO authenticated applies.
CREATE ROLE authenticated;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
  LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
CREATE TABLE public._academy_mgr (user_id uuid, academy_id uuid);
CREATE TABLE public._club_mgr (user_id uuid, club_id uuid);
CREATE FUNCTION public.get_user_academy_ids(p_user uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$ SELECT academy_id FROM public._academy_mgr WHERE user_id = p_user $$;
CREATE FUNCTION public.get_user_club_ids(p_user uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$ SELECT club_id FROM public._club_mgr WHERE user_id = p_user $$;

CREATE TABLE public.locations (id uuid PRIMARY KEY);

CREATE TABLE public.cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  enrollment_deadline timestamptz,
  is_always_open boolean DEFAULT false,
  status text NOT NULL DEFAULT 'draft',
  type text DEFAULT 'cyclus',
  location_id uuid REFERENCES public.locations(id),
  currency text DEFAULT 'EUR',
  terms text,
  settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_cycle_id uuid NOT NULL REFERENCES public.cycles(id) ON DELETE RESTRICT,
  owner_type text NOT NULL,
  owner_id uuid NOT NULL,
  format text NOT NULL DEFAULT 'registration',
  name text NOT NULL,
  description text,
  start_date date,
  end_date date,
  enrollment_deadline timestamptz,
  status text NOT NULL DEFAULT 'draft',
  total_price numeric(10,2),
  currency text NOT NULL DEFAULT 'EUR',
  price_table jsonb,
  location_id uuid REFERENCES public.locations(id),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_registrations_source_cycle ON public.registrations(source_cycle_id);
CREATE TRIGGER update_registrations_updated_at BEFORE UPDATE ON public.registrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}', '${U_TRAINER}');
INSERT INTO public._academy_mgr (user_id, academy_id) VALUES ('${U_ACADEMY}', '${A1}');
`);

// ── Apply the ACTUAL migration ──
const migration = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260630130000_registration_write_rpcs.sql'),
  'utf8',
);
await db.exec(migration);

// Settings with a mix of FORM-only + TRAINING-only keys.
const SETTINGS = JSON.stringify({
  // form-only
  lesson_types: ['single'], payment_methods: 'both', success_message: 'Thanks!',
  available_days: ['mon', 'wed'], max_participants: 4,
  // training-only (must NOT appear on the registration; MUST stay on the cycle)
  scoring_weights: { rating: 1 }, applicable_trainer_ids: [T1], min_skill_rating: 2,
});

// ── 1. create as the authorized trainer ──
await setUid(U_TRAINER);
const created = await db.query<{ id: string; source_cycle_id: string; format: string; settings: Record<string, unknown> }>(
  `SELECT * FROM public.create_registration_with_cycle(
     'trainer', $1, 'registration', 'Zomer 2026', 'desc', '2026-06-01', '2026-08-01',
     NULL, 'draft', 120.00, 'EUR', NULL, NULL, $2::jsonb, 'terms text', false)`,
  [T1, SETTINGS],
);
const reg = created.rows[0];
const cycleCount = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.cycles`);
const regCount = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.registrations`);
const shell = await db.query<{ type: string; settings: Record<string, unknown> }>(
  `SELECT type, settings FROM public.cycles WHERE id = $1`, [reg.source_cycle_id]);

check('create: exactly one cycle + one registration', cycleCount.rows[0].n === 1 && regCount.rows[0].n === 1,
  { cycles: cycleCount.rows[0].n, regs: regCount.rows[0].n });
check('create: shell cycle is type=cyclus', shell.rows[0]?.type === 'cyclus', shell.rows[0]?.type);
check('create: registration.source_cycle_id == cycle.id', !!reg.source_cycle_id);
check('create: registration has FORM-only settings (payment_methods,success_message)',
  'payment_methods' in reg.settings && 'success_message' in reg.settings && 'available_days' in reg.settings,
  reg.settings);
check('create: registration EXCLUDES training keys (scoring_weights,min_skill_rating)',
  !('scoring_weights' in reg.settings) && !('min_skill_rating' in reg.settings) && !('applicable_trainer_ids' in reg.settings),
  reg.settings);
check('create: cycle KEEPS the full settings (non-destructive)',
  !!shell.rows[0]?.settings && 'scoring_weights' in shell.rows[0].settings && 'payment_methods' in shell.rows[0].settings,
  shell.rows[0]?.settings);

// ── 2. create as a NON-owner → blocked ──
await setUid(U_OTHER);
let blocked = false;
try {
  await db.query(`SELECT public.create_registration_with_cycle(
    'trainer', $1, 'registration', 'Hack', NULL, NULL, NULL, NULL, 'draft', NULL, 'EUR', NULL, NULL, '{}'::jsonb, NULL, false)`, [T1]);
} catch { blocked = true; }
check('create: non-owner is blocked (not_authorized_for_owner)', blocked);

// ── 3. academy create via get_user_academy_ids ──
await setUid(U_ACADEMY);
const acadCreated = await db.query<{ source_cycle_id: string }>(
  `SELECT * FROM public.create_registration_with_cycle(
     'academy', $1, 'event', 'Kids event', NULL, '2026-07-01', '2026-07-01', NULL, 'open',
     25.00, 'EUR', NULL, NULL, '{}'::jsonb, NULL, false)`, [A1]);
check('create: academy owner authorized via get_user_academy_ids', acadCreated.rows.length === 1);

// ── 4. ADOPT — a legacy cycle (type='registration') with NO registration row ──
await setUid(U_TRAINER);
const legacy = await db.query<{ id: string }>(
  `INSERT INTO public.cycles (owner_type, owner_id, name, type, status, settings)
   VALUES ('trainer', $1, 'Legacy form', 'registration', 'open', '{"payment_methods":"cash"}'::jsonb) RETURNING id`, [T1]);
const legacyCycleId = legacy.rows[0].id;
const regsBefore = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.registrations`)).rows[0].n;
await db.query(
  `SELECT public.update_registration_with_cycle($1, 'registration', 'Legacy form (adopted)', NULL,
     NULL, NULL, NULL, 'open', NULL, 'EUR', NULL, NULL, '{"payment_methods":"cash"}'::jsonb, NULL, false)`,
  [legacyCycleId]);
const regsAfterAdopt = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.registrations`)).rows[0].n;
const adopted = await db.query<{ name: string }>(
  `SELECT name FROM public.registrations WHERE source_cycle_id = $1`, [legacyCycleId]);
check('adopt: update of a no-registration legacy cycle CREATES its registration', regsAfterAdopt === regsBefore + 1, { before: regsBefore, after: regsAfterAdopt });
check('adopt: NO new cycle was created (updates the existing source cycle)', adopted.rows[0]?.name === 'Legacy form (adopted)');

// ── 5. update an already-split cycle → updates in place, no duplicate ──
const regsBeforeUpd = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.registrations`)).rows[0].n;
await db.query(
  `SELECT public.update_registration_with_cycle($1, 'registration', 'Renamed', NULL,
     NULL, NULL, NULL, 'open', NULL, 'EUR', NULL, NULL, '{"payment_methods":"online"}'::jsonb, NULL, false)`,
  [legacyCycleId]);
const regsAfterUpd = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.registrations`)).rows[0].n;
const updated = await db.query<{ name: string; settings: Record<string, unknown> }>(
  `SELECT name, settings FROM public.registrations WHERE source_cycle_id = $1`, [legacyCycleId]);
check('update: in-place (no duplicate registration; unique index holds)', regsAfterUpd === regsBeforeUpd, { before: regsBeforeUpd, after: regsAfterUpd });
check('update: registration fields updated', updated.rows[0]?.name === 'Renamed' && updated.rows[0]?.settings?.payment_methods === 'online');

// ── 6. update of an unknown cycle → error ──
let notFound = false;
try {
  await db.query(`SELECT public.update_registration_with_cycle('00000000-0000-0000-0000-0000000000ff',
    'registration', 'x', NULL, NULL, NULL, NULL, 'draft', NULL, 'EUR', NULL, NULL, '{}'::jsonb, NULL, false)`);
} catch { notFound = true; }
check('update: unknown cycle raises', notFound);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
