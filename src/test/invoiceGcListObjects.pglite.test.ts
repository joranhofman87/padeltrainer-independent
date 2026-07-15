// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Theme B / B2: invoice_gc_list_objects is the GC's only window into storage.objects (the storage
// schema is not PostgREST-exposed). Runs the REAL migration and proves: bucket-pinned to
// 'invoices', keyset pagination on name, and the limit clamp — so the GC can never silently walk
// another bucket or fetch unbounded pages.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE storage.objects (
      bucket_id text NOT NULL,
      name text NOT NULL,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('invoices', 'a/INV-001.pdf'),
      ('invoices', 'a/INV-001.html'),
      ('invoices', 'b/INV-002.pdf'),
      ('avatars',  'u1/avatar.png'),   -- other bucket: must never appear
      ('backups',  'db/backup.tar');
  `);
  await db.exec(
    readFileSync(
      join(process.cwd(), 'supabase', 'migrations', '20260826160000_b2_invoice_gc_list_objects.sql'),
      'utf8',
    ),
  );
});

const names = async (after: string | null, limit: number): Promise<string[]> => {
  const { rows } = await db.query<{ name: string }>(
    `SELECT name FROM public.invoice_gc_list_objects($1, $2)`,
    [after, limit],
  );
  return rows.map((r) => r.name);
};

describe('invoice_gc_list_objects (B2)', () => {
  it('lists only the invoices bucket, ordered by name', async () => {
    expect(await names(null, 10)).toEqual(['a/INV-001.html', 'a/INV-001.pdf', 'b/INV-002.pdf']);
  });

  it('keyset-paginates on name', async () => {
    const first = await names(null, 1);
    expect(first).toEqual(['a/INV-001.html']);
    expect(await names(first[0], 10)).toEqual(['a/INV-001.pdf', 'b/INV-002.pdf']);
  });

  it('clamps the limit to sane bounds', async () => {
    expect((await names(null, 0)).length).toBe(1); // floor 1
    expect((await names(null, 999999)).length).toBe(3); // ceiling 1000 (all rows here)
  });
});
