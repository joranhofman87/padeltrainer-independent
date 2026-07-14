// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// SECURITY: intake_requests owner authorization after the registration↔cycle decouple. Runs the
// REAL RLS migration under the `authenticated` role and proves owner access is keyed on the FORM
// (registration_id → owner), NOT the cycle shell — and that it holds when cycle_id is NULL (the
// planned-into column). Cross-tenant read/write/delete of applicant PII must be blocked.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TRAINER_A = 'aa000000-0000-0000-0000-000000000001';
const TRAINER_B = 'bb000000-0000-0000-0000-000000000001';
const TUSER_A = 'aa000000-0000-0000-0000-0000000000a0'; // trainer A's auth user
const TUSER_B = 'bb000000-0000-0000-0000-0000000000b0';
const REG_A = 'a0000000-0000-0000-0000-000000000001'; // form owned by trainer A
const REG_B = 'b0000000-0000-0000-0000-000000000001'; // form owned by trainer B
const INTAKE_A = 'a1000000-0000-0000-0000-000000000001'; // applicant on A's form (cycle_id NULL)

async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE; SET test.uid = '';`);
  }
}
const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;

    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.registrations (id uuid PRIMARY KEY, owner_type text, owner_id uuid);
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      registration_id uuid NOT NULL REFERENCES public.registrations(id),
      cycle_id uuid,
      player_id uuid,
      full_name text
    );
    ALTER TABLE public.intake_requests ENABLE ROW LEVEL SECURITY;

    -- Prod-shaped authz helper the RLS migration reuses (trainer branch only, enough for this test).
    CREATE OR REPLACE FUNCTION public._registration_owner_authorized(p_owner_type text, p_owner_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT p_owner_type = 'trainer' AND EXISTS (
        SELECT 1 FROM public.trainer_profiles tp WHERE tp.id = p_owner_id AND tp.user_id = auth.uid()
      )
    $fn$;

    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TRAINER_A}','${TUSER_A}'), ('${TRAINER_B}','${TUSER_B}');
    INSERT INTO public.registrations (id, owner_type, owner_id) VALUES
      ('${REG_A}','trainer','${TRAINER_A}'), ('${REG_B}','trainer','${TRAINER_B}');
    -- An applicant on A's form with NO planned cycle yet (cycle_id NULL) — the post-decouple shape.
    INSERT INTO public.intake_requests (id, registration_id, cycle_id, full_name)
      VALUES ('${INTAKE_A}', '${REG_A}', NULL, 'applicant A');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260823130000_registration_decouple_rls_and_counts.sql'), 'utf8'));
  await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.intake_requests TO authenticated; GRANT SELECT ON public.trainer_profiles, public.registrations TO authenticated;`);
});

describe('intake_requests RLS keyed on the registration form owner', () => {
  it('owner sees their own form\'s applicant even with cycle_id NULL', async () => {
    const n = await asUser(TUSER_A, async () =>
      (await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.intake_requests`)).rows[0].n,
    );
    expect(n).toBe(1);
  });

  it("a DIFFERENT owner sees NONE of another form's applicants", async () => {
    const n = await asUser(TUSER_B, async () =>
      (await db.query<{ n: number }>(`SELECT count(*)::int n FROM public.intake_requests`)).rows[0].n,
    );
    expect(n).toBe(0);
  });

  it('owner can insert an applicant onto their own form (cycle_id NULL)', async () => {
    const ok = await asUser(TUSER_A, async () =>
      !(await failed(db.query(
        `INSERT INTO public.intake_requests (registration_id, cycle_id, full_name) VALUES ('${REG_A}', NULL, 'a2')`,
      ))),
    );
    expect(ok).toBe(true);
  });

  it("blocks inserting an applicant onto ANOTHER owner's form", async () => {
    const blocked = await asUser(TUSER_B, async () =>
      failed(db.query(
        `INSERT INTO public.intake_requests (registration_id, cycle_id, full_name) VALUES ('${REG_A}', NULL, 'evil')`,
      )),
    );
    expect(blocked).toBe(true);
  });

  it("cannot update or delete another owner's applicant (RLS filters the row → 0 affected, no leak)", async () => {
    // As the wrong owner, the UPDATE/DELETE run without error but match 0 visible rows.
    await asUser(TUSER_B, async () => {
      await db.query(`UPDATE public.intake_requests SET full_name = 'hacked' WHERE id = '${INTAKE_A}'`);
      await db.query(`DELETE FROM public.intake_requests WHERE id = '${INTAKE_A}'`);
    });
    // The true owner still sees the untouched applicant.
    const row = await asUser(TUSER_A, async () =>
      (await db.query<{ full_name: string }>(`SELECT full_name FROM public.intake_requests WHERE id = '${INTAKE_A}'`)).rows,
    );
    expect(row).toHaveLength(1);
    expect(row[0].full_name).toBe('applicant A');
  });
});
