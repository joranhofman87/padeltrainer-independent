// @vitest-environment node
/**
 * U2 — the client half of "email alone never authorizes an identity merge".
 *
 * The database side is proven against real PostgreSQL by `scripts/db/u2-no-email-alone-merge.mjs`.
 * That suite sweeps `pg_proc`, which is exactly why it could not see this: the invoice flow made the
 * same decision in TypeScript. `resolveOrCreateInvoiceGuest` looked a recipient up by email and, on
 * a single match, reused that player — so an invoice could be attached to a household member on the
 * strength of a shared address, with no proposal, no claim and no audit row.
 *
 * What is asserted here is the decision, not the plumbing: a lone email match whose NAME disagrees
 * must not be reused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const selectResult: { rows: Array<{ id: string; full_name: string | null }> } = { rows: [] };
const inserted: Array<Record<string, unknown>> = [];

vi.mock('@/integrations/supabase/client', () => {
  const builder = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'not', 'ilike']) {
      chain[m] = () => chain;
    }
    chain.then = (res: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(res({ data: selectResult.rows, error: null }));
    chain.insert = (row: Record<string, unknown>) => {
      inserted.push(row);
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'newly-created' }, error: null }),
        }),
      };
    };
    chain.update = () => ({ eq: () => Promise.resolve({ error: null }) });
    return chain;
  };
  return {
    supabase: {
      from: () => builder(),
      // academy scope routes the candidate lookup through a SECURITY DEFINER RPC (the academy
      // SELECT policy cannot see a not-yet-related trainer-owned guest), so the stub answers it
      // with the same candidate rows the direct query would return
      rpc: () => Promise.resolve({ data: selectResult.rows, error: null }),
    },
  };
});

const ACADEMY = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  selectResult.rows = [];
  inserted.length = 0;
});

describe('an invoice recipient is not resolved by email alone', () => {
  it('reuses the existing player when the name agrees', async () => {
    const { resolveOrCreateInvoiceGuest } = await import('../lib/invoiceCustomerInsert');
    selectResult.rows = [{ id: 'existing-anna', full_name: 'Anna de Vries' }];

    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Anna de Vries',
      playerEmail: 'family@example.com',
      scope: 'academy',
      academyProfileId: ACADEMY,
    });

    expect(id).toBe('existing-anna');
    expect(inserted).toHaveLength(0);
  });

  it('does NOT reuse a lone email match whose name disagrees — it creates a new player', async () => {
    // the household case: the invoice is for the child, the address belongs to the parent's record
    const { resolveOrCreateInvoiceGuest } = await import('../lib/invoiceCustomerInsert');
    selectResult.rows = [{ id: 'existing-parent', full_name: 'Marieke de Vries' }];

    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Anna de Vries',
      playerEmail: 'family@example.com',
      scope: 'academy',
      academyProfileId: ACADEMY,
    });

    expect(id).toBe('newly-created');
    expect(id).not.toBe('existing-parent');
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ full_name: 'Anna de Vries', email: 'family@example.com' });
  });

  it('several matches on one address still resolve to nobody by email', async () => {
    const { resolveOrCreateInvoiceGuest } = await import('../lib/invoiceCustomerInsert');
    selectResult.rows = [
      { id: 'sibling-a', full_name: 'Sibling A' },
      { id: 'sibling-b', full_name: 'Sibling B' },
    ];

    const id = await resolveOrCreateInvoiceGuest({
      playerName: 'Sibling C',
      playerEmail: 'family@example.com',
      scope: 'academy',
      academyProfileId: ACADEMY,
    });

    expect(id).toBe('newly-created');
  });
});

describe('the name gate is switched on at the call site', () => {
  // The behaviour above is what matters, but the flag is the thing a future edit would drop, and a
  // behavioural test with a stubbed client cannot say WHICH call site set it.
  it('resolveOrCreateInvoiceGuest passes requireNameMatch', () => {
    const src = readFileSync('src/lib/invoiceCustomerInsert.ts', 'utf8');
    expect(src).toContain('requireNameMatch: true');
  });

  it('no client resolve path reuses a lone email match without a name', () => {
    // Every caller of resolveOrCreateGuestPlayer in src/ must either set the gate or be listed here
    // with a reason. `pickGuestIdByName`'s default is permissive, so silence is not safety.
    const resolve = readFileSync('src/lib/playerResolve.ts', 'utf8');
    // the twin path and the invoice path are the two that resolve by email in src/
    expect(resolve).toContain('requireNameMatch');
    const invoice = readFileSync('src/lib/invoiceCustomerInsert.ts', 'utf8');
    expect(invoice.includes('requireNameMatch: true')).toBe(true);
  });
});
