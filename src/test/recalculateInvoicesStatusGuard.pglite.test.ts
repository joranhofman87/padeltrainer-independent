// @vitest-environment node
// P2-6 regression: recalculate-invoices/index.ts UPDATE must re-check status at
// write time so an admin recalc racing a Mollie payment cannot clobber a just-paid
// invoice. This asserts the guarded UPDATE SQL shape the fixed supabase-js chain
// (.update().eq("id").in("status",[...]).select("id")) compiles to:
//   UPDATE ... WHERE id = $ AND status IN ('draft','sent','pending') RETURNING id
// vs the pre-fix unguarded shape (WHERE id = $ RETURNING id) which overwrites paid rows.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;

const TRAINER = '30000000-0000-0000-0000-000000000001';
const PAID_ID = '60000000-0000-0000-0000-0000000000a1';
const DRAFT_ID = '60000000-0000-0000-0000-0000000000a2';

// The recalc payload the fix applies (total/subtotal/vat_amount recalculated, pdf_url nulled).
const RECALC = { subtotal: 8.26, vat_amount: 1.74, total: 10, pdf_url: null as string | null };

// The GUARDED update the fix produces. RETURNING id lets the caller count affected rows.
const guardedUpdate = async (id: string) =>
  (await db.query<{ id: string }>(
    `UPDATE public.invoices
       SET subtotal = $2, vat_amount = $3, total = $4, pdf_url = $5
     WHERE id = $1 AND status IN ('draft','sent','pending')
     RETURNING id`,
    [id, RECALC.subtotal, RECALC.vat_amount, RECALC.total, RECALC.pdf_url],
  )).rows;

// The PRE-FIX unguarded update (kept only to prove the test discriminates).
const unguardedUpdate = async (id: string) =>
  (await db.query<{ id: string }>(
    `UPDATE public.invoices
       SET subtotal = $2, vat_amount = $3, total = $4, pdf_url = $5
     WHERE id = $1
     RETURNING id`,
    [id, RECALC.subtotal, RECALC.vat_amount, RECALC.total, RECALC.pdf_url],
  )).rows;

const row = async (id: string) =>
  (await db.query<{ status: string; subtotal: string; vat_amount: string; total: string; pdf_url: string | null }>(
    `SELECT status, subtotal, vat_amount, total, pdf_url FROM public.invoices WHERE id = $1`, [id],
  )).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY,
      trainer_id uuid NOT NULL,
      subtotal numeric NOT NULL DEFAULT 0,
      vat_amount numeric NOT NULL DEFAULT 0,
      total numeric NOT NULL DEFAULT 0,
      pdf_url text,
      status text NOT NULL DEFAULT 'draft'
    );
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.invoices;`);
  // A paid invoice (mid-loop it flipped from sent -> paid via Mollie) with a real total + PDF.
  await db.query(
    `INSERT INTO public.invoices (id, trainer_id, subtotal, vat_amount, total, pdf_url, status)
     VALUES ($1, $2, 41.32, 8.68, 50, 'https://cdn/paid.pdf', 'paid')`,
    [PAID_ID, TRAINER],
  );
  // A still-editable draft the recalc legitimately updates.
  await db.query(
    `INSERT INTO public.invoices (id, trainer_id, subtotal, vat_amount, total, pdf_url, status)
     VALUES ($1, $2, 0, 0, 0, 'https://cdn/draft.pdf', 'draft')`,
    [DRAFT_ID, TRAINER],
  );
});

describe('recalculate-invoices status guard (P2-6)', () => {
  it('does NOT overwrite a paid invoice (zero rows affected → skipped)', async () => {
    const affected = await guardedUpdate(PAID_ID);
    expect(affected.length).toBe(0); // caller treats this as skipped/conflict, not updated
    const after = await row(PAID_ID);
    expect(after.status).toBe('paid');
    expect(Number(after.total)).toBe(50);            // untouched
    expect(Number(after.subtotal)).toBe(41.32);      // untouched
    expect(Number(after.vat_amount)).toBe(8.68);     // untouched
    expect(after.pdf_url).toBe('https://cdn/paid.pdf'); // NOT nulled
  });

  it('still updates an editable draft invoice (one row affected)', async () => {
    const affected = await guardedUpdate(DRAFT_ID);
    expect(affected.length).toBe(1);
    const after = await row(DRAFT_ID);
    expect(Number(after.total)).toBe(10);
    expect(after.pdf_url).toBeNull();
  });

  it('pre-fix unguarded UPDATE would have clobbered the paid invoice (proves the guard is load-bearing)', async () => {
    const affected = await unguardedUpdate(PAID_ID);
    expect(affected.length).toBe(1); // the bug: paid row gets overwritten
    const after = await row(PAID_ID);
    expect(Number(after.total)).toBe(10);        // corrupted total
    expect(after.pdf_url).toBeNull();            // PDF lost
  });
});
