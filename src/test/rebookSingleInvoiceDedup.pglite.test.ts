// @vitest-environment node
// PGlite's WASM/data loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// Slice A / A-7 regression: the structural double-pay guard for the no-login single-claim rebook
// invoice. Runs the ACTUAL migration (20260705130000_rebook_single_invoice_dedup.sql) against real
// Postgres (PGlite) and proves the unique partial index allows AT MOST ONE active (non-cancelled)
// rebook invoice per (claimant identity, cyclus) — so a concurrent/re-clicked mint conflicts at the DB.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

function readMigration(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path');
  return readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260705130000_rebook_single_invoice_dedup.sql'),
    'utf8',
  );
}

const P = '10000000-0000-0000-0000-000000000001';
const P2 = '10000000-0000-0000-0000-000000000002';
const G = '40000000-0000-0000-0000-000000000001';
const C = '50000000-0000-0000-0000-000000000001';
const C2 = '50000000-0000-0000-0000-000000000002';

async function insert(player: string | null, guest: string | null, cyclus: string | null, status: string) {
  return db.query(
    `INSERT INTO public.invoices (player_id, guest_player_id, rebook_cyclus_id, status) VALUES ($1,$2,$3,$4)`,
    [player, guest, cyclus, status],
  );
}

beforeAll(async () => {
  db = new PGlite();
  // Minimal invoices shape; the migration ALTERs it to add rebook_cyclus_id + the unique index.
  await db.exec(`
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_id uuid, guest_player_id uuid, status text);
  `);
  await db.exec(readMigration());
});

describe('rebook single-claim invoice dedup index (A-7)', () => {
  it('allows one active rebook invoice per (player, cyclus) and rejects a second', async () => {
    await insert(P, null, C, 'sent');
    await expect(insert(P, null, C, 'sent')).rejects.toThrow(); // unique violation
  });

  it('a CANCELLED invoice does not block a fresh active one (partial index excludes cancelled)', async () => {
    await insert(P, null, C2, 'cancelled');
    await insert(P, null, C2, 'cancelled'); // multiple cancelled allowed
    await expect(insert(P, null, C2, 'sent')).resolves.toBeTruthy(); // one active is fine
    await expect(insert(P, null, C2, 'sent')).rejects.toThrow(); // ...but only one
  });

  it('scopes by identity: a guest and a player can each hold one active invoice for the same cyclus', async () => {
    const cyc = '50000000-0000-0000-0000-0000000000aa';
    await expect(insert(P, null, cyc, 'sent')).resolves.toBeTruthy();
    await expect(insert(null, G, cyc, 'sent')).resolves.toBeTruthy(); // different identity → ok
    await expect(insert(null, G, cyc, 'sent')).rejects.toThrow(); // guest's 2nd → conflict
  });

  it('scopes by cyclus: the same player can hold active invoices in different cycluses', async () => {
    const a = '50000000-0000-0000-0000-0000000000b1';
    const b = '50000000-0000-0000-0000-0000000000b2';
    await expect(insert(P2, null, a, 'sent')).resolves.toBeTruthy();
    await expect(insert(P2, null, b, 'sent')).resolves.toBeTruthy();
  });

  it('non-rebook invoices (rebook_cyclus_id NULL) are unaffected — many allowed', async () => {
    await expect(insert(P, null, null, 'sent')).resolves.toBeTruthy();
    await expect(insert(P, null, null, 'sent')).resolves.toBeTruthy();
    await expect(insert(P, null, null, 'draft')).resolves.toBeTruthy();
  });
});
