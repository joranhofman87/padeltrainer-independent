// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// SECURITY (audit S01): the academy_trainers INSERT policy must require TRAINER consent, not just
// academy ownership. Runs the REAL migration under the `authenticated` role and proves a manager
// can no longer force-link an arbitrary trainer (cross-tenant takeover), while the legitimate paths
// — a manager listing themselves as a coach, and a trainer accepting an invitation addressed to
// them — still succeed. Also proves a manager who FORGES an invitation's acceptance still cannot
// insert the victim's membership (the gate is keyed on the trainer's own profile).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACADEMY_M = 'a0000000-0000-0000-0000-0000000000a1'; // the malicious/legit manager's academy
const ACADEMY_N = 'dd000000-0000-0000-0000-0000000000d1'; // an academy nobody here manages / no invites
const MUSER = 'a0000000-0000-0000-0000-0000000000a0';     // manager's auth user
const MTRAINER = 'a0000000-0000-0000-0000-0000000000a2';  // manager's OWN trainer profile

const VUSER = 'bb000000-0000-0000-0000-0000000000b0';      // victim trainer's auth user
const VTRAINER = 'bb000000-0000-0000-0000-0000000000b2';   // victim trainer profile (target of takeover)

const INV_TRAINER = 'cc000000-0000-0000-0000-0000000000c2'; // an invited trainer's profile
const IUSER = 'cc000000-0000-0000-0000-0000000000c0';       // invited trainer's auth user

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE; SET test.uid = '';`);
  }
}
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);
const countLinks = async (academy: string, trainer: string): Promise<number> => {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.academy_trainers WHERE academy_profile_id=$1 AND trainer_profile_id=$2`,
    [academy, trainer],
  );
  return rows[0].n;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_managers (academy_profile_id uuid, user_id uuid);
    CREATE TABLE public.academy_trainer_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid NOT NULL,
      trainer_profile_id uuid,
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE public.academy_trainers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid NOT NULL,
      trainer_profile_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'active',
      show_on_academy_page boolean NOT NULL DEFAULT false,
      UNIQUE (academy_profile_id, trainer_profile_id)
    );
    ALTER TABLE public.academy_trainers ENABLE ROW LEVEL SECURITY;

    -- Prod-shaped SECURITY DEFINER helper the INSERT policy reuses.
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid)
    RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id
    $fn$;

    -- The pre-existing admin INSERT policy (kept by the migration) — modelled so the test proves
    -- the migration does not disturb it. No admins in this fixture, so it never grants here.
    CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
    CREATE POLICY "Admins can insert academy trainers" ON public.academy_trainers
      FOR INSERT TO authenticated WITH CHECK (public.is_admin(auth.uid()));

    INSERT INTO public.trainer_profiles (id, user_id) VALUES
      ('${MTRAINER}','${MUSER}'), ('${VTRAINER}','${VUSER}'), ('${INV_TRAINER}','${IUSER}');
    -- MUSER manages ACADEMY_M.
    INSERT INTO public.academy_managers (academy_profile_id, user_id) VALUES ('${ACADEMY_M}','${MUSER}');
  `);
  await db.exec(
    readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260826110000_s01_academy_trainers_insert_consent.sql'),
      'utf8',
    ),
  );
  // The INSERT policy's WITH CHECK subqueries read trainer_profiles + academy_trainer_invitations,
  // evaluated as `authenticated` — grant them (mirrors prod, where authenticated has table SELECT
  // gated by each table's own RLS; not enabled here, so the grant alone suffices).
  await db.exec(`
    GRANT SELECT, INSERT ON public.academy_trainers TO authenticated;
    GRANT SELECT ON public.trainer_profiles, public.academy_trainer_invitations TO authenticated;
  `);
});

describe('academy_trainers INSERT consent (S01)', () => {
  it('BLOCKS a manager from force-linking an arbitrary trainer (the takeover)', async () => {
    const blocked = await asUser(MUSER, () =>
      failed(db.query(
        `INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
         VALUES ($1,$2,'active')`,
        [ACADEMY_M, VTRAINER],
      )),
    );
    expect(blocked).toBe(true);
    expect(await countLinks(ACADEMY_M, VTRAINER)).toBe(0);
  });

  it('BLOCKS the takeover even when the manager FORGED an accepted invitation for the victim', async () => {
    // The invitations UPDATE policy lets a manager mark an invitation accepted — model that forged row.
    await db.exec(
      `INSERT INTO public.academy_trainer_invitations (academy_profile_id, trainer_profile_id, status)
       VALUES ('${ACADEMY_M}','${VTRAINER}','accepted')`,
    );
    const blocked = await asUser(MUSER, () =>
      failed(db.query(
        `INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
         VALUES ($1,$2,'active')`,
        [ACADEMY_M, VTRAINER],
      )),
    );
    expect(blocked).toBe(true);
    expect(await countLinks(ACADEMY_M, VTRAINER)).toBe(0);
  });

  it('ALLOWS a manager to add THEMSELVES as a coach of their own academy (self-add)', async () => {
    const ok = await asUser(MUSER, () =>
      db.query(
        `INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
         VALUES ($1,$2,'active')`,
        [ACADEMY_M, MTRAINER],
      ).then(() => true, () => false),
    );
    expect(ok).toBe(true);
    expect(await countLinks(ACADEMY_M, MTRAINER)).toBe(1);
  });

  it('ALLOWS an invited trainer to accept (their own profile + an invitation to them)', async () => {
    await db.exec(
      `INSERT INTO public.academy_trainer_invitations (academy_profile_id, trainer_profile_id, status)
       VALUES ('${ACADEMY_M}','${INV_TRAINER}','accepted')`,
    );
    const ok = await asUser(IUSER, () =>
      db.query(
        `INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
         VALUES ($1,$2,'active')`,
        [ACADEMY_M, INV_TRAINER],
      ).then(() => true, () => false),
    );
    expect(ok).toBe(true);
    expect(await countLinks(ACADEMY_M, INV_TRAINER)).toBe(1);
  });

  it('BLOCKS a trainer self-adding to an academy that never invited them (no public-page spoofing)', async () => {
    // ACADEMY_N has no managers and no invitations here → neither INSERT policy can grant.
    const blocked = await asUser(VUSER, () =>
      failed(db.query(
        `INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status, show_on_academy_page)
         VALUES ($1,$2,'active',true)`,
        [ACADEMY_N, VTRAINER],
      )),
    );
    expect(blocked).toBe(true);
    expect(await countLinks(ACADEMY_N, VTRAINER)).toBe(0);
  });
});
