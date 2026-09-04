/**
 * ABC-23 §1 — settlement-caller tripwire.
 *
 * The inventory in docs/ABC23_SETTLEMENT_CALLERS.md is only useful if it cannot silently go
 * stale. This fails when an inventoried caller reverts to a direct paid+occupying update, or
 * when a file acquires that shape without being listed.
 *
 * It is deliberately a SOURCE guard: the thing being prevented is a code shape, and by the time
 * a behavioural test could observe it the oversell has already shipped.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const INVENTORY = readFileSync(join(ROOT, 'docs/ABC23_SETTLEMENT_CALLERS.md'), 'utf8');

/** Files the inventory lists as in-scope settlement callers. */
const IN_SCOPE = [
  'supabase/functions/mollie-webhook/index.ts',
  'supabase/functions/verify-mollie-payment/index.ts',
  'supabase/functions/settle-invoice-manual/index.ts',
  'supabase/functions/_shared/mollie-webhook-payment.ts',
  'supabase/functions/_shared/settlement.ts',
  'src/lib/markInvoicePaid.ts',
  'src/components/trainer/InvoiceList.tsx',
  'src/pages/trainer/TrainerEditInvoice.tsx',
  'src/pages/academy/AcademyEditInvoice.tsx',
];

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const WEBHOOK = read('supabase/functions/mollie-webhook/index.ts');
const VERIFIER = read('supabase/functions/verify-mollie-payment/index.ts');
const MANUAL = read('supabase/functions/settle-invoice-manual/index.ts');
const CLIENT_SHIM = read('src/lib/markInvoicePaid.ts');
const UI = IN_SCOPE.filter((f) => f.startsWith('src/pages') || f.startsWith('src/components'))
  .map((f) => ({ file: f, src: read(f) }));

// ── detectors ────────────────────────────────────────────────────────────────────────────────
// Each returns TRUE when the defect is present. Every one is exercised below against BOTH the
// real source (must be clean) and a mutated copy that reintroduces the defect (must be caught) —
// a detector that cannot fail is not a guard, it is decoration.

/** The classifier used as a settlement DECISION rather than as diagnostics. */
const usesClassifierAsDecision = (src: string) =>
  /expired_holds_over_capacity/.test(src) &&
  /(confirmBookingIds|bookingIds)\s*(=|\.filter)/.test(
    src.slice(Math.max(0, src.indexOf('expired_holds_over_capacity') - 400),
              src.indexOf('expired_holds_over_capacity') + 900));

/** The invoice flipped to paid by its own UPDATE instead of inside the atomic command. */
const flipsInvoicePaidDirectly = (src: string) =>
  /from\(["']invoices["']\)[\s\S]{0,200}?\.update\(\s*\{[^}]{0,300}status:\s*["']paid["']/.test(src);

/** The settlement authority is actually invoked here. */
const invokesAuthority = (src: string) => /settlePaidBookings\s*\(/.test(src);

/** A settlement failure that is caught and then reported as success. */
const swallowsSettlementFailure = (src: string) =>
  invokesAuthority(src) && !/settlementError\s*\)\s*\{[\s\S]{0,600}?status:\s*500/.test(src);

/** A browser file writing a paid settlement itself. */
const browserSettles = (src: string) =>
  /from\(['"](bookings|invoices)['"]\)[\s\S]{0,200}?\.update\(\s*\{[^}]{0,300}(payment_status:\s*['"]paid['"]|status:\s*['"]paid['"])/
    .test(src);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

/**
 * A direct settlement shape: one write that sets payment_status='paid' AND an occupying status
 * TOGETHER. Both must appear in the SAME object literal — a file that merely contains each
 * somewhere is not a settlement (src/lib/bookings.ts records external payment with no status
 * write, and matching file-wide flagged it falsely on the first pass). A tripwire that cries
 * wolf gets muted, so the shape it detects has to be the shape that actually oversells.
 */
function hasDirectSettlementShape(src: string): boolean {
  const paid = /payment_status\s*[:=]\s*["']paid["']/;
  const occupying = /\bstatus\s*[:=]\s*["'](confirmed|pending|completed)["']/;
  // scan brace-delimited object literals rather than the whole file
  for (const m of src.matchAll(/\{[^{}]{0,600}\}/g)) {
    if (paid.test(m[0]) && occupying.test(m[0])) return true;
  }
  return false;
}

describe('ABC-23 · settlement-caller tripwire', () => {
  it('every in-scope caller is named in the inventory', () => {
    for (const f of IN_SCOPE) {
      expect({ file: f, listed: INVENTORY.includes(f.split('/').pop()!) })
        .toMatchObject({ listed: true });
    }
  });

  it('no NEW file acquires a direct paid+occupying settlement shape unlisted', () => {
    const offenders: string[] = [];
    for (const dir of ['supabase/functions', 'src/lib']) {
      for (const full of walk(join(ROOT, dir))) {
        const rel = full.slice(ROOT.length + 1);
        if (IN_SCOPE.includes(rel)) continue;
        const src = readFileSync(full, 'utf8');
        if (!hasDirectSettlementShape(src)) continue;
        // listed as an exclusion with a recorded reason?
        if (INVENTORY.includes(rel.split('/').pop()!)) continue;
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  // ── the five individual mutation proofs ────────────────────────────────────────────────
  it('MUTATION: restoring the classifier as a settlement decision is caught', () => {
    expect(usesClassifierAsDecision(WEBHOOK)).toBe(false);
    const mutant = WEBHOOK.replace(
      '// ABC-23 §3: the oversell decision is NO LONGER made here.',
      `const { data: oversoldRows } = await supabase.rpc("expired_holds_over_capacity", { _booking_ids: bookingIds });
       confirmBookingIds = bookingIds.filter((id) => !oversoldRows.includes(id));
       //`);
    expect(usesClassifierAsDecision(mutant)).toBe(true);
  });

  it('MUTATION: restoring an invoice-first paid UPDATE is caught', () => {
    expect(flipsInvoicePaidDirectly(WEBHOOK)).toBe(false);
    const mutant = WEBHOOK.replace(
      'const { data: invoiceData, error: linkedReadErr } = await supabase',
      `await supabase.from("invoices").update({ status: "paid", paid_at: now }).eq("id", invoiceIdFromMetadata);
       const { data: invoiceData, error: linkedReadErr } = await supabase`);
    expect(flipsInvoicePaidDirectly(mutant)).toBe(true);
  });

  it.each([
    ['webhook', () => WEBHOOK],
    ['verifier', () => VERIFIER],
    ['manual boundary', () => MANUAL],
  ])('MUTATION: deleting the authority call in the %s is caught', (_label, get) => {
    const src = get();
    expect(invokesAuthority(src)).toBe(true);
    const mutant = src.replace(/settlePaidBookings\s*\(/g, 'legacyWriteback(');
    expect(invokesAuthority(mutant)).toBe(false);
  });

  it('MUTATION: swallowing a verifier settlement failure is caught', () => {
    expect(swallowsSettlementFailure(VERIFIER)).toBe(false);
    // the exact historical defect: catch it, log it, return paid anyway
    const mutant = VERIFIER.replace(/if \(settlementError\) \{[\s\S]*?\n {6}\}/, 'if (settlementError) { /* ignored */ }');
    expect(swallowsSettlementFailure(mutant)).toBe(true);
  });

  it.each(UI.map((u) => [u.file, u.src] as const))(
    'MUTATION: restoring browser raw settlement in %s is caught', (_file, src) => {
      expect(browserSettles(src)).toBe(false);
      const mutant = src + `
        async function legacyMarkPaid(id) {
          await supabase.from('invoices').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', id);
        }`;
      expect(browserSettles(mutant)).toBe(true);
    });

  it('the client shim asks the server and never settles locally', () => {
    expect(browserSettles(CLIENT_SHIM)).toBe(false);
    expect(CLIENT_SHIM).toMatch(/functions\.invoke\(\s*['"]settle-invoice-manual['"]/);
  });

  it('no caller invents a Mollie id for a manual settlement', () => {
    expect(MANUAL).not.toMatch(/tr_|mollie_payment_id\s*:/);
    expect(MANUAL).toMatch(/settlementSource:\s*["']manual["']/);
  });

  it('the atomic command exists and is the documented authority', () => {
    const mig = readFileSync(
      join(ROOT, 'supabase/migrations/20261118110000_abc16_abc17_relationship_evidence_containment.sql'),
      'utf8');
    expect(mig).toMatch(/FUNCTION public\.settle_paid_bookings/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.settle_paid_bookings[\s\S]{0,120}service_role/);
  });
});
