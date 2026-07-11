// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Migration 20260807100000: the intake_requests.status CHECK never allowed 'booked'/'notified', so
// the registration "Approve & Book all" flow (finalize_cycle_proposals → status='booked') and the
// schedule-notify step (status='notified') both raised a check_violation in prod and rolled back.
// This proves: (a) the ORIGINAL CHECK rejects 'booked', (b) after the migration 'booked' + 'notified'
// are accepted, (c) the existing values still work, and (d) a genuinely invalid status still fails.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

const insertStatus = async (status: string) =>
  db.exec(`INSERT INTO public.intake_requests (id, cycle_id, status) VALUES (gen_random_uuid(), gen_random_uuid(), '${status}');`);

beforeAll(async () => {
  db = new PGlite();
  // Reproduce the ORIGINAL inline column CHECK (20260123104639) — the restrictive vocabulary.
  await db.exec(`
    CREATE TABLE public.intake_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      cycle_id uuid NOT NULL,
      status text NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'proposed', 'confirmed', 'rejected', 'waitlist'))
    );
  `);
  // Seed the exact prod shape: rows in the allowed set only (so the migration's re-validate passes).
  await insertStatus('new');
  await insertStatus('proposed');
  await insertStatus('rejected');
});

describe('intake_requests.status CHECK widening (booked + notified)', () => {
  it('BEFORE the migration: the "Approve & Book all" write (status=booked) is rejected — the prod bug', async () => {
    await expect(insertStatus('booked')).rejects.toThrow(/check|constraint|violat/i);
  });

  it('applies the migration cleanly against the prod-shaped data (all existing rows are valid)', async () => {
    const sql = readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260807100000_intake_status_allow_booked_notified.sql'), 'utf8');
    await expect(db.exec(sql)).resolves.toBeTruthy();
  });

  it('AFTER the migration: finalize can write "booked" and notify can write "notified"', async () => {
    await expect(insertStatus('booked')).resolves.toBeTruthy();
    await expect(insertStatus('notified')).resolves.toBeTruthy();
  });

  it('AFTER: the original vocabulary still works', async () => {
    await expect(insertStatus('confirmed')).resolves.toBeTruthy();
    await expect(insertStatus('waitlist')).resolves.toBeTruthy();
  });

  it('AFTER: a genuinely invalid status is still rejected (the CHECK is widened, not removed)', async () => {
    await expect(insertStatus('totally_bogus')).rejects.toThrow(/check|constraint|violat/i);
  });

  it('leaves exactly one CHECK constraint on the table (old one dropped, not duplicated)', async () => {
    const rows = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'public.intake_requests'::regclass AND contype = 'c'`,
    )).rows;
    expect(rows[0].n).toBe(1);
  });
});
