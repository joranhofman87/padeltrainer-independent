import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Mutation-boundary guard (Codex foundation-verification Finding 3).
 *
 * Dangerous domain writes should live in tested domain owners (`src/lib/*`,
 * SECURITY DEFINER RPCs, edge functions), not scattered across pages/components
 * where a future AI/dev can patch one surface and miss another, or drop a
 * status-gate and hard-delete a paid invoice.
 *
 * This is a SHRINK-ONLY allowlist (like the eslint suppression baseline): the
 * current direct writes to high-risk tables from `src/pages` + `src/components`
 * are frozen in `fixtures/mutationBoundaryAllowlist.json`. A NEW direct write
 * (new file, or more than the allowlisted count in an existing file) fails this
 * test. As writes are moved behind domain owners, regenerate the baseline so it
 * only ever shrinks. `src/lib/**` is the domain layer and is intentionally NOT
 * scanned — that's where these writes belong.
 *
 * See docs/audits/MUTATION_BOUNDARY_AUDIT.md for the classification + move plan.
 */
const HIGH_RISK_TABLES = [
  'bookings',
  'availability_slots',
  'cycles',
  'registrations',
  'invoices',
  'slot_priority_claims',
  'email_campaign_recipients',
];

const WRITE_RE = new RegExp(
  `from\\(\\s*['"](?:${HIGH_RISK_TABLES.join('|')})['"]\\s*\\)\\s*\\.\\s*(?:insert|update|delete|upsert)`,
  'g',
);

const SRC = resolve(__dirname, '..');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|ts)$/.test(entry.name) && !/\.test\./.test(entry.name)) acc.push(p);
  }
  return acc;
}

function scan(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const dir of ['pages', 'components']) {
    for (const file of walk(join(SRC, dir))) {
      const n = (readFileSync(file, 'utf8').match(WRITE_RE) || []).length;
      if (n > 0) counts[`src/${file.slice(SRC.length + 1)}`] = n;
    }
  }
  return counts;
}

const allowlist: Record<string, number> = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/mutationBoundaryAllowlist.json'), 'utf8'),
);

describe('mutation boundary — no new direct high-risk-table writes in pages/components', () => {
  it('every direct write to a high-risk table is allowlisted (shrink-only)', () => {
    const counts = scan();
    const offenders: string[] = [];
    for (const [file, n] of Object.entries(counts)) {
      const allowed = allowlist[file] ?? 0;
      if (n > allowed) {
        offenders.push(`${file}: ${n} direct write(s), allowlisted ${allowed}`);
      }
    }
    expect(
      offenders,
      'New/extra direct writes to high-risk tables (bookings, invoices, cycles, availability_slots, ' +
        'registrations, slot_priority_claims, email_campaign_recipients) found in src/pages or ' +
        'src/components. Route them through a domain owner in src/lib/* (unrestricted) — or, if ' +
        'intentional, regenerate src/test/fixtures/mutationBoundaryAllowlist.json and note it in ' +
        'docs/audits/MUTATION_BOUNDARY_AUDIT.md.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
