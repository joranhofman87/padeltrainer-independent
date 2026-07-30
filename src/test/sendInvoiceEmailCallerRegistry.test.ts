import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Durable 503-safety pin for the send-invoice-email maintenance gate. Every reviewed caller of the edge function,
// with the number of `functions.invoke('send-invoice-email', …)` sites in each. Each was audited: a maintenance 503
// resolves (functions-js) as { data:null, error } → a failure branch; NO caller stamps the invoice sent on that path;
// there are NO automatic mutation-retry loops. A NEW invoke site — or an added one in a known file — changes this
// set/count and fails CI, forcing a fresh 503-safety review before it ships.
const REGISTERED: Record<string, number> = {
  'src/components/invoices/BulkInvoiceEmailDialog.tsx': 3, // preview, test, bulk
  'src/components/invoices/SendInvoiceEmailDialog.tsx': 1, // preview
  'src/components/trainer/InvoiceList.tsx': 2,             // send, resend
  'src/pages/academy/AcademyInvoices.tsx': 3,             // send, bulk, resend
  'src/pages/trainer/TrainerInvoices.tsx': 3,             // send, bulk, resend
  'supabase/functions/create-rebook-invoice/index.ts': 1, // non-blocking, alerts
};
const EXPECTED_TOTAL = 13;

const INVOKE = /functions\.invoke\(\s*['"]send-invoice-email['"]/g;
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.[tj]sx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('send-invoice-email caller registry (503-safety pin)', () => {
  it('exactly the reviewed invoke sites exist across the repo', () => {
    const root = process.cwd();
    const perFile: Record<string, number> = {};
    let total = 0;
    for (const dir of ['src', 'supabase/functions']) {
      for (const abs of walk(join(root, dir))) {
        const n = (readFileSync(abs, 'utf8').match(INVOKE) ?? []).length;
        if (n > 0) { perFile[relative(root, abs)] = n; total += n; }
      }
    }
    expect(perFile).toEqual(REGISTERED);   // no unreviewed file, and no added invoke in a known file
    expect(total).toBe(EXPECTED_TOTAL);
  });
});
