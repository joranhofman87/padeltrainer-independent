// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Expenses is money data, so this runs the REAL migration (20260718100000) against Postgres
// (PGlite) UNDER the `authenticated` role (RLS enforced) and proves: the owner-XOR + amount
// CHECKs hold; an academy manager sees/creates only their own academy's expenses; a trainer
// sees/creates only their own; and cross-tenant read/write is blocked.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const ACAD_A = 'c0000000-0000-0000-0000-0000000000a0';
const ACAD_B = 'c0000000-0000-0000-0000-0000000000b0';
const MGR_A = 'e0000000-0000-0000-0000-0000000000a0'; // manages ACAD_A
const MGR_B = 'e0000000-0000-0000-0000-0000000000b0'; // manages ACAD_B
const TRAINER_A = 'fa000000-0000-0000-0000-0000000000a0';
const TRAINER_B = 'fb000000-0000-0000-0000-0000000000b0';
const TUSER_A = 'd0000000-0000-0000-0000-0000000000a0'; // trainer A's auth user
const TUSER_B = 'd0000000-0000-0000-0000-0000000000b0';

// Run a block as the `authenticated` role with auth.uid() = uid (RLS applies).
async function asUser<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`RESET ROLE; SET test.uid = '';`);
  }
}
const failed = async (p: Promise<unknown>): Promise<boolean> =>
  p.then(() => false, () => true);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid
    $fn$;

    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid, role text);

    -- Prod-shaped SECURITY DEFINER gates the migration's policies call.
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM public.academy_managers
        WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id
      )
    $fn$;
    CREATE OR REPLACE FUNCTION public.is_admin(_uid uuid)
    RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ SELECT false $fn$;
    CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;

    INSERT INTO public.academy_profiles (id) VALUES ('${ACAD_A}'), ('${ACAD_B}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TRAINER_A}','${TUSER_A}'), ('${TRAINER_B}','${TUSER_B}');
    INSERT INTO public.academy_managers (user_id, academy_profile_id, role) VALUES
      ('${MGR_A}','${ACAD_A}','owner'), ('${MGR_B}','${ACAD_B}','owner');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260718100000_expenses.sql'), 'utf8'));
  await db.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO authenticated;
    GRANT SELECT ON public.trainer_profiles TO authenticated;
  `);
});

const insertAcademy = (acad: string, amount = 100) =>
  db.query(
    `INSERT INTO public.expenses (academy_profile_id, expense_date, amount, category) VALUES ($1, '2026-07-01', $2, 'court_rental') RETURNING id`,
    [acad, amount],
  );
const insertTrainer = (trainer: string, amount = 50) =>
  db.query(
    `INSERT INTO public.expenses (trainer_id, expense_date, amount, category) VALUES ($1, '2026-07-01', $2, 'equipment') RETURNING id`,
    [trainer, amount],
  );

describe('expenses — CHECK constraints (as owner, RLS bypassed)', () => {
  it('rejects a row with BOTH owners set', async () => {
    expect(
      await failed(
        db.query(
          `INSERT INTO public.expenses (academy_profile_id, trainer_id, expense_date, amount, category) VALUES ($1,$2,'2026-07-01',10,'other')`,
          [ACAD_A, TRAINER_A],
        ),
      ),
    ).toBe(true);
  });
  it('rejects a row with NEITHER owner set', async () => {
    expect(await failed(db.query(`INSERT INTO public.expenses (expense_date, amount, category) VALUES ('2026-07-01',10,'other')`))).toBe(true);
  });
  it('rejects a non-positive amount', async () => {
    expect(await failed(insertAcademy(ACAD_A, 0))).toBe(true);
  });
});

describe('expenses — RLS isolation (as authenticated)', () => {
  it('an academy manager creates + sees only their own academy expenses', async () => {
    await asUser(MGR_A, async () => {
      await insertAcademy(ACAD_A);
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.expenses`);
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
      const { rows: mine } = await db.query<{ academy_profile_id: string }>(`SELECT academy_profile_id FROM public.expenses`);
      expect(mine.every((r) => r.academy_profile_id === ACAD_A)).toBe(true);
    });
  });

  it("a manager cannot INSERT an expense for another academy (WITH CHECK)", async () => {
    await asUser(MGR_B, async () => {
      expect(await failed(insertAcademy(ACAD_A))).toBe(true); // MGR_B manages ACAD_B, not ACAD_A
    });
  });

  it('a manager cannot SEE another academy\'s expenses', async () => {
    await asUser(MGR_B, async () => {
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.expenses WHERE academy_profile_id = $1`,
        [ACAD_A],
      );
      expect(rows[0].n).toBe(0); // ACAD_A rows exist but are invisible to MGR_B
    });
  });

  it('a trainer creates + sees only their own expenses, not another trainer\'s', async () => {
    await asUser(TUSER_A, async () => {
      await insertTrainer(TRAINER_A);
      const { rows } = await db.query<{ trainer_id: string }>(`SELECT trainer_id FROM public.expenses`);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.trainer_id === TRAINER_A)).toBe(true);
    });
    await asUser(TUSER_B, async () => {
      expect(await failed(insertTrainer(TRAINER_A))).toBe(true); // can't insert for trainer A
      const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.expenses WHERE trainer_id = $1`, [TRAINER_A]);
      expect(rows[0].n).toBe(0);
    });
  });
});
