// @vitest-environment node
// P1-6 regression: create_invoice_deduped (migration 20260706120300_p1_6_create_invoice_deduped.sql)
// dedups on booking_ids OVERLAP, not just exact-set equality, so [A] then [A,B] for the same
// trainer+recipient returns the first invoice rather than inserting a second (double-charge).
// Runs the REAL deployed SQL loaded from the migration file (REVOKE/GRANT stripped: roles absent in PGlite).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

function readMigrations(): string {
  return ['20260706120300_p1_6_create_invoice_deduped.sql']
    .map((f) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'))
    .join('\n')
    .split('\n')
    .filter((l) => !/^(REVOKE|GRANT)\b/.test(l))
    .join('\n');
}

const TRAINER = '30000000-0000-0000-0000-000000000001';
const PLAYER_A = '40000000-0000-0000-0000-000000000001';
const PLAYER_B = '40000000-0000-0000-0000-000000000002';
const BK_A = '50000000-0000-0000-0000-00000000000a';
const BK_B = '50000000-0000-0000-0000-00000000000b';

const createDeduped = async (payload: Record<string, unknown>) =>
  (await db.query<{ r: { deduped: boolean; id: string } }>(`SELECT public.create_invoice_deduped($1::jsonb) AS r`, [JSON.stringify(payload)]))
    .rows[0].r;

const basePayload = (num: string, player: string, bookingIds: string[]) => ({
  trainer_id: TRAINER,
  invoice_number: num,
  invoice_date: '2026-07-02',
  due_date: '2026-07-16',
  player_id: player,
  player_name: 'Test Player',
  line_items: [{ description: 'x', quantity: 1, unit_price: 10 }],
  subtotal: 10,
  vat_rate: 21,
  vat_amount: 2.1,
  total: 12.1,
  status: 'sent',
  booking_ids: bookingIds,
});

const activeCount = async (): Promise<number> =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.invoices WHERE status <> 'cancelled'`)).rows[0].n);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid NOT NULL,
      academy_profile_id uuid,
      invoice_number text NOT NULL,
      invoice_date date NOT NULL,
      due_date date NOT NULL,
      player_id uuid,
      guest_player_id uuid,
      player_name text NOT NULL,
      player_business_name text,
      player_address text,
      player_btw_number text,
      line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
      subtotal numeric NOT NULL DEFAULT 0,
      vat_rate numeric NOT NULL DEFAULT 21,
      vat_amount numeric NOT NULL DEFAULT 0,
      total numeric NOT NULL DEFAULT 0,
      vat_breakdown jsonb,
      prices_include_vat boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'draft',
      booking_ids uuid[] DEFAULT '{}',
      split_count integer,
      sent_at timestamptz,
      paid_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT unique_invoice_number_per_trainer UNIQUE (trainer_id, invoice_number)
    );
  `);
  await db.exec(readMigrations()); // the REAL migration file — a hotfix to it fails this suite
});

beforeEach(async () => { await db.exec(`DELETE FROM public.invoices;`); });

describe('create_invoice_deduped', () => {
  it('dedups an OVERLAPPING-BUT-UNEQUAL set to the first invoice (no double-charge)', async () => {
    const first = await createDeduped(basePayload('INV-1', PLAYER_A, [BK_A]));
    expect(first.deduped).toBe(false);
    const second = await createDeduped(basePayload('INV-2', PLAYER_A, [BK_A, BK_B]));
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await activeCount()).toBe(1);
  });

  it('does NOT dedup across different recipients', async () => {
    const a = await createDeduped(basePayload('INV-1', PLAYER_A, [BK_A]));
    const b = await createDeduped(basePayload('INV-2', PLAYER_B, [BK_A]));
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(await activeCount()).toBe(2);
  });

  it('does NOT dedup against a cancelled prior invoice', async () => {
    const first = await createDeduped(basePayload('INV-1', PLAYER_A, [BK_A]));
    await db.query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [first.id]);
    const second = await createDeduped(basePayload('INV-2', PLAYER_A, [BK_A, BK_B]));
    expect(second.deduped).toBe(false);
    expect(await activeCount()).toBe(1);
  });
});
