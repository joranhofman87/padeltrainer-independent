// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Registration decoupling Phase 2a — the real migration (20260823100000) is applied against a
// minimal but faithful cycles/registrations/intake_requests schema, then we assert its three
// guarantees: (1) registration_id auto-derives from the form overlay on insert, (2) it is NOT NULL
// (an intake on a cycle with no overlay is rejected), (3) (registration_id, player_id) is unique.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260823100000_registration_decouple_2a_intake_registration_link.sql'),
  'utf8',
);

const CYCLE_REG = '10000000-0000-0000-0000-000000000001'; // a cycle shell with an overlay
const CYCLE_NO_OVERLAY = '10000000-0000-0000-0000-000000000002'; // a cycle with NO overlay
const REG = '20000000-0000-0000-0000-000000000001';
const PLAYER = '30000000-0000-0000-0000-000000000001';

const insertIntake = (cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
  return db.query<{ id: string; registration_id: string | null }>(
    `INSERT INTO public.intake_requests (${keys.join(', ')}) VALUES (${vals}) RETURNING id, registration_id`,
    keys.map((k) => cols[k]),
  );
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, type text NOT NULL DEFAULT 'cyclus');
    CREATE TABLE public.registrations (
      id uuid PRIMARY KEY,
      source_cycle_id uuid REFERENCES public.cycles(id)
    );
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id uuid NOT NULL REFERENCES public.cycles(id),
      registration_id uuid REFERENCES public.registrations(id) ON DELETE SET NULL,
      player_id uuid,
      full_name text
    );

    INSERT INTO public.cycles (id, type) VALUES
      ('${CYCLE_REG}', 'cyclus'),
      ('${CYCLE_NO_OVERLAY}', 'cyclus');
    INSERT INTO public.registrations (id, source_cycle_id) VALUES ('${REG}', '${CYCLE_REG}');

    -- A pre-existing intake with a NULL registration_id (the "15 stragglers" case) that the
    -- migration's backfill must fix before it can enforce NOT NULL.
    INSERT INTO public.intake_requests (id, cycle_id, registration_id, full_name)
      VALUES ('40000000-0000-0000-0000-000000000009', '${CYCLE_REG}', NULL, 'straggler');
  `);
  // Apply the real migration (trigger + backfill + FK swap + NOT NULL + unique index).
  await db.exec(MIGRATION);
});

describe('Phase 2a: intake→registration canonical link', () => {
  it('backfilled the pre-existing NULL registration_id from the overlay', async () => {
    const { rows } = await db.query<{ registration_id: string }>(
      `SELECT registration_id FROM public.intake_requests WHERE id = '40000000-0000-0000-0000-000000000009'`,
    );
    expect(rows[0].registration_id).toBe(REG);
  });

  it('auto-derives registration_id on insert when only cycle_id is given', async () => {
    const { rows } = await insertIntake({ cycle_id: CYCLE_REG, full_name: 'derived' });
    expect(rows[0].registration_id).toBe(REG);
  });

  it('keeps an explicitly-provided registration_id (does not overwrite it)', async () => {
    const { rows } = await insertIntake({ cycle_id: CYCLE_REG, registration_id: REG, full_name: 'explicit' });
    expect(rows[0].registration_id).toBe(REG);
  });

  it('rejects an intake whose cycle has no overlay (NOT NULL enforced)', async () => {
    let failed = false;
    try {
      await insertIntake({ cycle_id: CYCLE_NO_OVERLAY, full_name: 'no overlay' });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('enforces one application per (registration, player)', async () => {
    await insertIntake({ cycle_id: CYCLE_REG, player_id: PLAYER, full_name: 'first' });
    let failed = false;
    try {
      await insertIntake({ cycle_id: CYCLE_REG, player_id: PLAYER, full_name: 'dup' });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('still allows multiple guest intakes (NULL player_id) on the same form', async () => {
    await insertIntake({ cycle_id: CYCLE_REG, player_id: null, full_name: 'guest a' });
    const { rows } = await insertIntake({ cycle_id: CYCLE_REG, player_id: null, full_name: 'guest b' });
    expect(rows[0].registration_id).toBe(REG);
  });
});
