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
import { readFileSync, readdirSync } from 'node:fs';

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

describe('every identity writer that matches on an email also checks the name', () => {
  // The real-Postgres suite sweeps `pg_proc`, so it is structurally blind to TypeScript. Two of the
  // four email-alone writers in this change were found by review rather than by a guard, which is
  // the gap this closes: every SOURCE site that looks a person up by email is enumerated, and each
  // one must either gate on the name or be listed with a reason.
  const SITES: Array<{ file: string; why: string; must: RegExp[] }> = [
    {
      file: 'src/lib/invoiceCustomerInsert.ts',
      why: 'invoice recipient resolution — reused a lone email match, so an invoice could be billed to a household member',
      must: [/requireNameMatch:\s*true/],
    },
    {
      file: 'src/lib/playerResolve.ts',
      why: 'the shared resolver; its twin path must keep asking for the name',
      must: [/requireNameMatch\s*=\s*false/, /requireNameMatch:\s*true/],
    },
    {
      file: 'supabase/functions/create-manual-player/index.ts',
      why: 'staff intake — attached the player to an existing ACCOUNT, and overwrote an existing guest, on the address alone',
      // the CONDITIONAL, not just the variable: computing `profileNameAgrees` and then writing
      // `if (existingProfile)` would leave every one of these strings in place while restoring an
      // email-alone link
      must: [
        /if \(existingProfile && profileNameAgrees\)/,
        /normalizeName\(existingProfile\?\.full_name\) !== ""/,
        /academy_create_player/,
      ],
    },
    {
      file: 'supabase/functions/submit-guest-intake/index.ts',
      why: 'public intake — its name guard treated a NAMELESS profile as a match, and profiles.full_name is nullable',
      must: [
        /normalizeName\(existingProfile\?\.full_name\) !== ""/,
        /if \(existingProfile && matchesExistingProfile\)/,
      ],
    },
    {
      file: 'supabase/functions/_shared/guest-players.ts',
      why: 'the public-booking resolver; already name-gated via matchGuestByName before U2',
      must: [/matchGuestByName/],
    },
  ];

  /**
   * Sites that look a person up by email but do NOT attach a player identity. Each was read; the
   * reason says what it does instead. Listing beats narrowing the detector: a heuristic tuned until
   * it stops complaining is a heuristic that has stopped working.
   */
  const NOT_IDENTITY: Array<{ file: string; why: string }> = [
    {
      file: 'src/lib/academy.ts',
      why: 'invites a TRAINER by an address the inviting operator typed deliberately. It grants a staff role to an existing account; it does not attach a player to a person or merge two of them.',
    },
    {
      file: 'src/lib/club.ts',
      why: 'the same invite-a-trainer/manager-by-address flow for clubs. A role grant on an address the operator chose, not an identity decision about a player.',
    },
    {
      file: 'src/lib/cycles.ts',
      why: 'two reads: a rate limit counting recent intake_requests per address, and a club_players existence check that only avoids inserting the same club row twice. Neither resolves WHO a player is.',
    },
    {
      file: 'supabase/functions/reditus-referral-webhook/index.ts',
      why: 'attributes a marketing referral to an account by address. It writes no person link and no player id; the worst case is a referral credited to the wrong household member.',
    },
    {
      file: 'supabase/functions/send-auth-email/index.ts',
      why: 'reads a name to greet the recipient of an email already being sent to that exact address. It writes nothing at all, and the address is the destination rather than a guess about who someone is.',
    },
    {
      file: 'supabase/functions/send-email/index.ts',
      why: 'resolves whether the destination address belongs to an account, to choose between the account and guest unsubscribe link. Fails CLOSED on a lookup error, writes no identity, and again the address is the destination.',
    },
  ];

  it.each(SITES)('$file gates on the name', ({ file, must }) => {
    const src = readFileSync(file, 'utf8');
    for (const re of must) {
      expect(`${file} ${re}: ${re.test(src)}`).toBe(`${file} ${re}: true`);
    }
  });

  it('the intake dialog names the owner the cycle already knows', () => {
    // Without it the player is created ownerless: invisible in the academy's players list, and it
    // never reaches the scoped idempotent create path at all.
    const src = readFileSync('src/components/cycles/AddIntakeRequestDialog.tsx', 'utf8');
    expect(src).toMatch(/owner_type === 'academy'\) return \{ academyProfileId: c\.owner_id \}/);
    expect(src).toMatch(/owner_type === 'trainer'\) return \{ trainerProfileId: c\.owner_id \}/);
  });

  it('the academy branch of create-manual-player goes through the one command', () => {
    const src = readFileSync('supabase/functions/create-manual-player/index.ts', 'utf8');
    expect(src).toContain('academy_create_player');
    expect(src).toContain('_actor_user_id: userId');
  });

  it('every listed site carries a written reason', () => {
    for (const { file, why } of SITES) {
      expect(`${file}: ${why.length >= 40}`).toBe(`${file}: true`);
    }
  });

  it('every non-identity site carries a written reason too', () => {
    for (const { file, why } of NOT_IDENTITY) {
      expect(`${file}: ${why.length >= 60}`).toBe(`${file}: true`);
    }
  });

  it('no OTHER source file looks a person up by email without appearing here', () => {
    // A crude scan on purpose: it is meant to be noisy when something new starts matching on an
    // address, because silence is what let two of these ship.
    const roots = ['src/lib', 'supabase/functions'];
    const listed = new Set([...SITES, ...NOT_IDENTITY].map((s) => s.file));
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        const src = readFileSync(full, 'utf8');
        // a person-shaped table queried by an email column
        const looksUp = /from\((["'`])(profiles|guest_players|persons|club_players|intake_requests)\1\)/.test(src)
          && /\.(eq|ilike)\((["'`])email\2/.test(src);
        if (looksUp && !listed.has(full)) offenders.push(full);
      }
    };
    for (const r of roots) walk(r);

    expect(offenders).toEqual([]);
  });
});
