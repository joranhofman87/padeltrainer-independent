// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Theme C (audit R22): cycles/registrations owner_id is polymorphic with no FK — the migration
// adds FK-equivalent invariants via triggers. Runs the REAL migration and proves:
//   * inserting a program with a non-existent owner is BLOCKED (each owner type);
//   * re-pointing owner_id/owner_type at a non-existent owner is BLOCKED;
//   * deleting an owner that still owns programs is BLOCKED (RESTRICT semantics) with the
//     actionable message;
//   * legitimate flows pass: valid inserts, owner deletion after its programs are gone, and the
//     Theme-A trainer-shell anonymize (UPDATE, not DELETE) is unaffected.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const TRAINER = 'aa000000-0000-0000-0000-000000000001';
const CLUB = 'bb000000-0000-0000-0000-000000000001';
const ACADEMY = 'cc000000-0000-0000-0000-000000000001';
const GHOST = '99000000-0000-0000-0000-000000000009'; // exists in no owner table

const failed = async (p: Promise<unknown>): Promise<boolean> => p.then(() => false, () => true);
const failedWith = async (p: Promise<unknown>, needle: string): Promise<boolean> =>
  p.then(
    () => false,
    (e) => String((e as Error).message).includes(needle),
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid, anonymized_at timestamptz);
    CREATE TABLE public.club_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.cycles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type text NOT NULL CHECK (owner_type IN ('trainer','club','academy')),
      owner_id uuid NOT NULL,
      name text
    );
    CREATE TABLE public.registrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type text NOT NULL CHECK (owner_type IN ('trainer','club','academy')),
      owner_id uuid NOT NULL
    );
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${TRAINER}', gen_random_uuid());
    INSERT INTO public.club_profiles (id) VALUES ('${CLUB}');
    INSERT INTO public.academy_profiles (id) VALUES ('${ACADEMY}');
  `);
  await db.exec(
    readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260826170000_c_owner_referential_integrity.sql'),
      'utf8',
    ),
  );
});

describe('program owner referential integrity (R22)', () => {
  it('BLOCKS inserting a cycle/registration whose owner does not exist (every owner type)', async () => {
    for (const t of ['trainer', 'club', 'academy']) {
      expect(await failed(db.query(
        `INSERT INTO public.cycles (owner_type, owner_id, name) VALUES ($1, $2, 'ghost')`, [t, GHOST],
      ))).toBe(true);
      expect(await failed(db.query(
        `INSERT INTO public.registrations (owner_type, owner_id) VALUES ($1, $2)`, [t, GHOST],
      ))).toBe(true);
    }
  });

  it('ALLOWS inserting programs for real owners (every owner type)', async () => {
    for (const [t, id] of [['trainer', TRAINER], ['club', CLUB], ['academy', ACADEMY]] as const) {
      expect(await failed(db.query(
        `INSERT INTO public.cycles (owner_type, owner_id, name) VALUES ($1, $2, 'ok-' || $1)`, [t, id],
      ))).toBe(false);
    }
    expect(await failed(db.query(
      `INSERT INTO public.registrations (owner_type, owner_id) VALUES ('academy', $1)`, [ACADEMY],
    ))).toBe(false);
  });

  it('BLOCKS re-pointing a program at a non-existent owner', async () => {
    expect(await failed(db.query(
      `UPDATE public.cycles SET owner_id = $1 WHERE owner_type = 'academy'`, [GHOST],
    ))).toBe(true);
    expect(await failed(db.query(
      `UPDATE public.cycles SET owner_type = 'club', owner_id = $1 WHERE owner_type = 'academy'`, [GHOST],
    ))).toBe(true);
  });

  it('BLOCKS deleting an owner that still owns programs, with the actionable message', async () => {
    expect(await failedWith(
      db.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [ACADEMY]),
      'still owns',
    )).toBe(true);
    expect(await failedWith(
      db.query(`DELETE FROM public.trainer_profiles WHERE id = $1`, [TRAINER]),
      'still owns',
    )).toBe(true);
    // Owners (and their programs) survive the refused deletes.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.cycles`,
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });

  it('ALLOWS deleting an owner once its programs are gone (deliberate cleanup path)', async () => {
    await db.exec(`DELETE FROM public.cycles WHERE owner_type = 'club' AND owner_id = '${CLUB}'`);
    expect(await failed(db.query(
      `DELETE FROM public.club_profiles WHERE id = $1`, [CLUB],
    ))).toBe(false);
  });

  it('Theme-A trainer-shell anonymize (UPDATE, never DELETE) is unaffected', async () => {
    expect(await failed(db.query(
      `UPDATE public.trainer_profiles SET user_id = NULL, anonymized_at = now() WHERE id = $1`, [TRAINER],
    ))).toBe(false);
  });
});
