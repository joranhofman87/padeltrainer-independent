// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Applies the REAL migration (20260824100000) against a minimal registrations schema and proves:
//  - create_registration persists per-form `terms`;
//  - the settings whitelist now KEEPS the planning match-criteria (min/max group_size + skill_rating)
//    while still stripping non-whitelisted junk;
//  - update_registration updates `terms`.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260824100000_registration_terms_and_match_criteria.sql'),
  'utf8',
);

const createReg = (settings: Record<string, unknown>, terms: string | null) =>
  db.query<{ id: string; terms: string | null; settings: Record<string, unknown> }>(
    `SELECT * FROM public.create_registration(
       'academy', '00000000-0000-0000-0000-0000000000a1'::uuid, 'registration', 'Form', NULL,
       NULL, NULL, NULL, 'open', NULL, 'EUR', NULL, NULL, $1::jsonb, $2)`,
    [JSON.stringify(settings), terms],
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated;
    CREATE TABLE public.registrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_cycle_id uuid,
      owner_type text NOT NULL,
      owner_id uuid NOT NULL,
      format text NOT NULL DEFAULT 'registration',
      name text NOT NULL,
      description text,
      enrollment_deadline timestamptz,
      status text NOT NULL DEFAULT 'draft',
      total_price numeric,
      currency text NOT NULL DEFAULT 'EUR',
      price_table jsonb,
      location_id uuid,
      settings jsonb NOT NULL DEFAULT '{}',
      start_date date,
      end_date date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- Prod-shaped authz gate (stubbed to allow) so the SECURITY DEFINER RPCs run.
    CREATE FUNCTION public._registration_owner_authorized(p_owner_type text, p_owner_id uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT true $fn$;
  `);
  await db.exec(MIGRATION);
});

describe('registration terms + match-criteria persistence', () => {
  it('persists per-form terms', async () => {
    const { rows } = await createReg({ lesson_types: ['duo'] }, 'Betaling binnen 14 dagen.');
    expect(rows[0].terms).toBe('Betaling binnen 14 dagen.');
  });

  it('keeps the match-criteria keys in settings, strips non-whitelisted junk', async () => {
    const { rows } = await createReg(
      { min_group_size: 2, max_group_size: 4, min_skill_rating: 3, max_skill_rating: 5, lesson_types: ['group4'], secret_engine_key: 'nope' },
      null,
    );
    const s = rows[0].settings;
    expect(s.min_group_size).toBe(2);
    expect(s.max_group_size).toBe(4);
    expect(s.min_skill_rating).toBe(3);
    expect(s.max_skill_rating).toBe(5);
    expect(s.lesson_types).toEqual(['group4']);
    expect('secret_engine_key' in s).toBe(false); // still stripped
  });

  it('update_registration updates terms', async () => {
    const created = await createReg({}, 'old');
    const id = created.rows[0].id;
    const { rows } = await db.query<{ terms: string | null }>(
      `SELECT terms FROM public.update_registration(
         $1::uuid, 'registration', 'Form', NULL, NULL, NULL, NULL, 'open', NULL, 'EUR', NULL, NULL, NULL, 'new terms')`,
      [id],
    );
    expect(rows[0].terms).toBe('new terms');
  });
});
