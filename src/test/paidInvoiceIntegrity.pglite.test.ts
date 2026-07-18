// @vitest-environment node
// Audit #4b (migration 20260908100000): the DB-final backstop that a PAID invoice
// cannot be hard-deleted or have its money (total/subtotal/vat_amount) rewritten —
// even by admin / service_role writes that bypass RLS. Status transitions, pdf_url,
// billing, and player_id anonymization (GDPR) on a paid invoice stay allowed, and
// unpaid invoices remain fully editable. Runs the REAL migration file.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const PAID = '10000000-0000-0000-0000-000000000001';
const DRAFT = '10000000-0000-0000-0000-000000000002';

const insert = async (id: string, status: string) =>
  db.query(
    `INSERT INTO public.invoices (id, status, total, subtotal, vat_amount) VALUES ($1, $2, 121, 100, 21)`,
    [id, status],
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text,
      total numeric,
      subtotal numeric,
      vat_amount numeric,
      pdf_url text,
      player_id uuid
    );
  `);
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260908100000_protect_paid_invoice_integrity.sql'), 'utf8'));
});

beforeEach(async () => {
  await db.exec(`TRUNCATE public.invoices`); // TRUNCATE skips the row-level DELETE trigger
  await insert(PAID, 'paid');
  await insert(DRAFT, 'draft');
});

describe('protect_paid_invoice_integrity (Audit #4b)', () => {
  it('BLOCKS hard-deleting a paid invoice', async () => {
    await expect(db.query(`DELETE FROM public.invoices WHERE id = $1`, [PAID]))
      .rejects.toThrow(/paid invoice/i);
  });

  it('ALLOWS deleting a draft invoice', async () => {
    await db.query(`DELETE FROM public.invoices WHERE id = $1`, [DRAFT]);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.invoices WHERE id = $1`, [DRAFT]);
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it('BLOCKS changing total / subtotal / vat_amount on a paid invoice', async () => {
    await expect(db.query(`UPDATE public.invoices SET total = 999 WHERE id = $1`, [PAID]))
      .rejects.toThrow(/amount of paid invoice/i);
    await expect(db.query(`UPDATE public.invoices SET subtotal = 1 WHERE id = $1`, [PAID]))
      .rejects.toThrow(/amount of paid invoice/i);
    await expect(db.query(`UPDATE public.invoices SET vat_amount = 0 WHERE id = $1`, [PAID]))
      .rejects.toThrow(/amount of paid invoice/i);
  });

  it('ALLOWS a paid invoice to transition status (soft-cancel / refund) with amounts unchanged', async () => {
    await db.query(`UPDATE public.invoices SET status = 'cancelled' WHERE id = $1`, [PAID]);
    const { rows } = await db.query(`SELECT status FROM public.invoices WHERE id = $1`, [PAID]);
    expect((rows[0] as { status: string }).status).toBe('cancelled');
  });

  it('ALLOWS non-amount updates on a paid invoice (pdf_url, GDPR player_id anonymization)', async () => {
    await db.query(`UPDATE public.invoices SET pdf_url = 'x' WHERE id = $1`, [PAID]);
    await db.query(`UPDATE public.invoices SET player_id = NULL WHERE id = $1`, [PAID]);
    const { rows } = await db.query(`SELECT pdf_url, player_id FROM public.invoices WHERE id = $1`, [PAID]);
    expect((rows[0] as { pdf_url: string }).pdf_url).toBe('x');
  });

  it('ALLOWS editing amounts on an UNPAID invoice (draft/sent/pending stay mutable)', async () => {
    await db.query(`UPDATE public.invoices SET total = 200, subtotal = 165, vat_amount = 35 WHERE id = $1`, [DRAFT]);
    const { rows } = await db.query(`SELECT total FROM public.invoices WHERE id = $1`, [DRAFT]);
    expect(Number((rows[0] as { total: number }).total)).toBe(200);
  });
});
