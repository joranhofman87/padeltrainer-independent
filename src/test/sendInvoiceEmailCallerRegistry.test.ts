import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// Durable 503-safety pin for the send-invoice-email maintenance gate. An AST inventory across ALL executable roots
// (not just src/supabase) of every `X.invoke('send-invoice-email', …)` site — resolving both string literals AND
// same-file const aliases (`const FN = 'send-invoice-email'; invoke(FN)`). Each reviewed caller is 503-safe: a
// maintenance 503 resolves (functions-js) as { data:null, error } → a failure branch; NO caller stamps the invoice
// sent on that path; there are NO automatic mutation-retry loops. A new/aliased/relocated invoke changes this set and
// fails CI, forcing a fresh 503-safety review before it ships.
const ROOTS = ['src', 'api', 'supabase/functions', 'scripts', 'tests', 'e2e'];
const TARGET = 'send-invoice-email';
const REGISTERED: Record<string, number> = {
  'src/components/invoices/BulkInvoiceEmailDialog.tsx': 3, // preview, test, bulk
  'src/components/invoices/SendInvoiceEmailDialog.tsx': 1, // preview
  'src/components/trainer/InvoiceList.tsx': 2,             // send, resend
  'src/pages/academy/AcademyInvoices.tsx': 3,             // send, bulk, resend
  'src/pages/trainer/TrainerInvoices.tsx': 3,             // send, bulk, resend
  'supabase/functions/create-rebook-invoice/index.ts': 1, // non-blocking, alerts
};
const EXPECTED_TOTAL = 13;

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

// Count `.invoke('send-invoice-email')` sites, resolving string literals AND same-file const/let/var string aliases.
function countInvokes(src: string): number {
  const sf = ts.createSourceFile('f.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const consts = new Map<string, string>();
  const collectConsts = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)) {
      consts.set(n.name.text, n.initializer.text);
    }
    ts.forEachChild(n, collectConsts);
  };
  collectConsts(sf);
  let count = 0;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'invoke' && n.arguments.length) {
      const arg = n.arguments[0];
      const name = ts.isStringLiteralLike(arg) ? arg.text : (ts.isIdentifier(arg) ? consts.get(arg.text) : undefined);
      if (name === TARGET) count++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return count;
}

describe('send-invoice-email caller registry (AST 503-safety pin)', () => {
  it('exactly the reviewed invoke sites exist across ALL executable roots (literal + aliased)', () => {
    const root = process.cwd();
    const found: Record<string, number> = {};
    let total = 0;
    for (const r of ROOTS) {
      for (const abs of walk(join(root, r))) {
        if (/\.(test|spec)\.[tj]sx?$/.test(abs)) continue; // a real caller is never a test file
        const n = countInvokes(readFileSync(abs, 'utf8'));
        if (n > 0) { found[relative(root, abs)] = n; total += n; }
      }
    }
    expect(found).toEqual(REGISTERED);
    expect(total).toBe(EXPECTED_TOTAL);
  });

  it('the detector catches literal, aliased/static, and api-root callers — and ignores non-invoke mentions', () => {
    expect(countInvokes(`supabase.functions.invoke('send-invoice-email');`)).toBe(1);          // literal
    expect(countInvokes(`const FN = "send-invoice-email"; sb.functions.invoke(FN, {});`)).toBe(1); // aliased const
    expect(countInvokes(`supabase.functions.invoke('auto-create-invoice');`)).toBe(0);         // other fn
    expect(countInvokes(`// mirrors send-invoice-email\nconst x = "send-invoice-email";`)).toBe(0); // mention, not invoke
    expect(countInvokes(`notifySlack("send-invoice-email", msg);`)).toBe(0);                   // .notifySlack, not .invoke
  });
});
