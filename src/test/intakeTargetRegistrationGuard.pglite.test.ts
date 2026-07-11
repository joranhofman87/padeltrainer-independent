// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Migration 20260808100000: an intake_requests INSERT may only target a REGISTRATION/EVENT cycle —
// the enforced-by-construction backstop for the paths the edge guards (#479) don't cover (authed
// self-register + manual staff add). Proves: legacy registration/event ✓, split registration (shell
// type='cyclus' + overlay) ✓, but a genuine training cyclus / rebook round ✗ — and that an UPDATE
// (finalize's status flip) is unaffected.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const CY_LEGACY_REG = '10000000-0000-0000-0000-000000000001'; // type='registration'
const CY_LEGACY_EVENT = '10000000-0000-0000-0000-000000000002'; // type='event'
const CY_SPLIT_REG = '10000000-0000-0000-0000-000000000003'; // type='cyclus' WITH overlay
const CY_TRAINING = '10000000-0000-0000-0000-000000000004'; // type='cyclus' NO overlay (a rebook round)

const insertIntake = (cycleId: string) =>
  db.exec(`INSERT INTO public.intake_requests (id, cycle_id, status) VALUES (gen_random_uuid(), '${cycleId}', 'new');`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.cycles (id uuid PRIMARY KEY, type text);
    CREATE TABLE public.registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_cycle_id uuid);
    CREATE TABLE public.intake_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cycle_id uuid NOT NULL, status text);
    INSERT INTO public.cycles (id, type) VALUES
      ('${CY_LEGACY_REG}', 'registration'),
      ('${CY_LEGACY_EVENT}', 'event'),
      ('${CY_SPLIT_REG}', 'cyclus'),
      ('${CY_TRAINING}', 'cyclus');
    -- Only the split registration has an overlay row.
    INSERT INTO public.registrations (source_cycle_id) VALUES ('${CY_SPLIT_REG}');
  `);
  await db.exec(readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260808100000_intake_target_must_be_registration.sql'), 'utf8'));
});

describe('intake_requests target guard (must be a registration/event)', () => {
  it('ALLOWS a legacy type=registration cycle', async () => {
    await expect(insertIntake(CY_LEGACY_REG)).resolves.toBeTruthy();
  });

  it('ALLOWS a legacy type=event cycle', async () => {
    await expect(insertIntake(CY_LEGACY_EVENT)).resolves.toBeTruthy();
  });

  it('ALLOWS a split registration (shell type=cyclus + overlay row)', async () => {
    await expect(insertIntake(CY_SPLIT_REG)).resolves.toBeTruthy();
  });

  it('REJECTS a genuine training cyclus / rebook round (type=cyclus, no overlay)', async () => {
    await expect(insertIntake(CY_TRAINING)).rejects.toThrow(/registration or event|check|violat/i);
  });

  it('does NOT affect UPDATE (finalize_cycle_proposals flips status on an existing row)', async () => {
    const id = 'aa000000-0000-0000-0000-000000000001';
    await db.exec(`INSERT INTO public.intake_requests (id, cycle_id, status) VALUES ('${id}', '${CY_LEGACY_REG}', 'proposed');`);
    await expect(db.exec(`UPDATE public.intake_requests SET status='booked' WHERE id='${id}';`)).resolves.toBeTruthy();
  });
});
