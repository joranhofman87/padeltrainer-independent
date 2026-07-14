// @vitest-environment node
// PGlite's WASM loader needs Node's fetch/fs, not jsdom — pin this file to the node env.
//
// R01 (MASTER_AUDIT) — bookings.payment_status CHECK omitted 'failed' (written by the
// Mollie webhook on every failed/canceled/expired payment) plus 'invoiced'/'unpaid'
// (read across the earnings/invoice surfaces). The rejected write raised 23514, which
// applyBookingPaymentWriteback re-throws (it only swallows 23505), 500-ing the webhook
// and stranding the seat. This suite reproduces the reject on the ORIGINAL constraint,
// then applies the REAL widen migration and proves the values the code writes are now
// accepted while an unknown value is still rejected.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

// The original constraint, verbatim from migration 20260115213549.
const ORIGINAL_CONSTRAINT = `CHECK (payment_status IN ('pending', 'paid', 'refunded', 'waived'))`;

// The forward-only widen migration, read from disk so it can never silently drift.
const WIDEN_MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '20260822100000_widen_bookings_payment_status_check.sql'),
  'utf8',
);

const insertWithStatus = (status: string) =>
  db.query(`INSERT INTO public.bookings (payment_status) VALUES ($1)`, [status]);

const rejects = async (status: string): Promise<boolean> => {
  try {
    await insertWithStatus(status);
    return false;
  } catch {
    return true;
  }
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      payment_status text NOT NULL DEFAULT 'pending'
    );
    ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_payment_status_check ${ORIGINAL_CONSTRAINT};
  `);
});

describe('R01: bookings.payment_status CHECK before the fix', () => {
  it("rejects 'failed' — the webhook value that 500s every failed payment", async () => {
    expect(await rejects('failed')).toBe(true);
  });

  it("rejects 'invoiced' and 'unpaid' — both read across earnings/invoice surfaces", async () => {
    expect(await rejects('invoiced')).toBe(true);
    expect(await rejects('unpaid')).toBe(true);
  });

  it('still accepts the four original values', async () => {
    for (const s of ['pending', 'paid', 'refunded', 'waived']) {
      expect(await rejects(s)).toBe(false);
    }
  });
});

describe('R01: after applying the widen migration', () => {
  beforeAll(async () => {
    // Apply the real migration SQL (drops + re-adds the constraint).
    await db.exec(WIDEN_MIGRATION);
  });

  it("now accepts 'failed', 'invoiced', and 'unpaid'", async () => {
    for (const s of ['failed', 'invoiced', 'unpaid']) {
      expect(await rejects(s)).toBe(false);
    }
  });

  it('still accepts every original value', async () => {
    for (const s of ['pending', 'paid', 'refunded', 'waived']) {
      expect(await rejects(s)).toBe(false);
    }
  });

  it('still rejects an unknown payment_status (constraint is not dropped, just widened)', async () => {
    expect(await rejects('totally_bogus')).toBe(true);
  });
});
