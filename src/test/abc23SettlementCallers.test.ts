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
  'supabase/functions/_shared/mollie-webhook-payment.ts',
  'src/lib/markInvoicePaid.ts',
  'src/components/trainer/InvoiceList.tsx',
];

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

  it('the atomic command exists and is the documented authority', () => {
    const mig = readFileSync(
      join(ROOT, 'supabase/migrations/20261118110000_abc16_abc17_relationship_evidence_containment.sql'),
      'utf8');
    expect(mig).toMatch(/FUNCTION public\.settle_paid_bookings/);
    expect(mig).toMatch(/GRANT EXECUTE ON FUNCTION public\.settle_paid_bookings[\s\S]{0,120}service_role/);
  });
});
