// @vitest-environment node
// One-time promotion of historical quick-generator drafts (migration 20260711100000).
// The carve-out is the point: bulk-rebook-cycle uses status='draft' as its half-built
// rebuild marker — rebook drafts (and any other non-generator draft) must NOT flip.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE cycles (id text PRIMARY KEY, status text, settings jsonb, updated_at timestamptz);
  `);
  await db.query(`INSERT INTO cycles (id, status, settings) VALUES
    ('gen-draft', 'draft', '{"generated_by": "slot_generator", "publish_visibility": "private"}'),
    ('rebook-draft', 'draft', '{"rebook_payment_mode": "upfront"}'),
    ('other-draft', 'draft', '{}'),
    ('null-settings-draft', 'draft', NULL),
    ('gen-open', 'open', '{"generated_by": "slot_generator"}'),
    ('gen-closed', 'closed', '{"generated_by": "slot_generator"}')`);
  await db.exec(
    readFileSync(join(process.cwd(), 'supabase', 'migrations', '20260711100000_open_generator_draft_cycles.sql'), 'utf8'),
  );
});

describe('open_generator_draft_cycles (real migration SQL)', () => {
  const statusOf = async (id: string) =>
    (await db.query<{ status: string }>(`SELECT status FROM cycles WHERE id = $1`, [id])).rows[0].status;

  it('promotes generator drafts to open', async () => {
    expect(await statusOf('gen-draft')).toBe('open');
  });

  it('leaves rebook half-builds and other drafts alone (the rebuild marker)', async () => {
    expect(await statusOf('rebook-draft')).toBe('draft');
    expect(await statusOf('other-draft')).toBe('draft');
    expect(await statusOf('null-settings-draft')).toBe('draft');
  });

  it('never touches non-draft rows', async () => {
    expect(await statusOf('gen-open')).toBe('open');
    expect(await statusOf('gen-closed')).toBe('closed');
  });
});
