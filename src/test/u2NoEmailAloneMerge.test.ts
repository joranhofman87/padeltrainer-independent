// @vitest-environment node
/**
 * U2 — the client half of "attributes never select an identity".
 *
 * The database side is proven against real PostgreSQL by `scripts/db/u2-no-email-alone-merge.mjs`.
 * That suite sweeps `pg_proc`, which is exactly why it could not see the writers that made the same
 * decision in TypeScript: the invoice form reused a guest whose address matched, the staff intake
 * function attributed a registration to a `profiles` row it found by address, and the public
 * registration endpoint did both. Those three are gone — their behaviour is now asserted where
 * behaviour belongs, in `src/lib/invoiceCustomerInsert.test.ts` and the two Deno handler suites.
 *
 * What is left here is the thing a behavioural test cannot do: notice a NEW writer. This file
 * enumerates every source site that looks a person up by an email address, and each one must either
 * be an identity writer that has been read and reasoned about, or be listed with a reason why
 * looking up an address there decides nothing about who anybody is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * Sites that look a person-shaped row up by email AND could influence identity. Each is read line by
 * line; `must` pins the property that keeps it honest, so the entry cannot rot into a bare name.
 */
const SITES: Array<{ file: string; why: string; must: RegExp[] }> = [
  {
    file: 'src/lib/playerResolve.ts',
    why:
      'the registered-player TWIN bridge. It resolves by profile id first and only then considers an ' +
      'address, and a lone household-email match is reused only when the name matches exactly — the ' +
      'B1 arm slice 1 deliberately kept, because a twin stamp is an explicit operator assertion.',
    must: [/requireNameMatch\s*=\s*false/, /requireNameMatch:\s*true/, /findGuestTwinByProfileId/],
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
    file: 'supabase/functions/submit-guest-intake/index.ts',
    why: 'one read: the 60-second duplicate-submission window, which counts recent intake_requests on the submitted address. It suppresses a double-click; it never decides which Player a submission belongs to — that is the UUID-keyed command, which this endpoint calls with no candidate at all.',
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

/**
 * The writers U2 removed. Each of these files used to resolve a person from an address and a name;
 * the assertion is that the lookup is GONE, not merely guarded — a guarded lookup is one edit away
 * from being an unguarded one, and both of the guards that shipped here were bypassable.
 */
const RETIRED: Array<{ file: string; why: string; absent: RegExp[] }> = [
  {
    file: 'src/lib/invoiceCustomerInsert.ts',
    why: 'invoice recipient resolution — reused a lone email match, so an invoice could be billed to a household member',
    absent: [/\.from\(/, /findExistingGuestPlayerId/],
  },
  {
    file: 'supabase/functions/create-manual-player/index.ts',
    why: 'staff intake — attached the registration to an existing ACCOUNT found by address, skipping the create command entirely',
    absent: [/from\("profiles"\)/, /from\("guest_players"\)/],
  },
  {
    file: 'supabase/functions/submit-guest-intake/index.ts',
    why: 'public intake — did the same against profiles, and then reused and OVERWROTE a guest row it found by address',
    absent: [/from\("profiles"\)/, /from\("guest_players"\)/],
  },
  {
    file: 'supabase/functions/_shared/guest-players.ts',
    why:
      'the anonymous booking/payment resolver behind create-guest-{slot,cart,cyclus}-payment. It ' +
      'looked the typed address up, took the name match, overwrote that row with what had just been ' +
      'typed, and booked against it — an identity chosen from two attributes by a stranger',
    absent: [/\.from\(/, /matchGuestByName/],
  },
  {
    file: 'src/components/players/AddPlayerForm.tsx',
    why:
      'staff add-a-player — a direct guest_players insert, so a retried save made a second Player ' +
      'and nothing proposed the duplicate. It still READS the address, to ask the operator whether ' +
      'the new player is a family member of the ones already on it; that is a proposal made to a ' +
      'human, which is exactly what attributes are allowed to do',
    absent: [/from\("guest_players"\)\s*\n?\s*\.insert/],
  },
  {
    file: 'src/components/players/ImportPlayersDialog.tsx',
    why: 'CSV import — the same direct insert per row, so re-running a half-failed import duplicated everyone who had already landed',
    absent: [/from\("guest_players"\)\s*\n?\s*\.insert/],
  },
];

describe('no source site resolves a person from an address', () => {
  it.each(RETIRED)('$file no longer looks anybody up', ({ file, absent }) => {
    const src = readFileSync(file, 'utf8');
    for (const re of absent) {
      expect(`${file} still matches ${re}: ${re.test(src)}`).toBe(`${file} still matches ${re}: false`);
    }
  });

  it.each(SITES)('$file keeps the property that makes it safe', ({ file, must }) => {
    const src = readFileSync(file, 'utf8');
    for (const re of must) {
      expect(`${file} ${re}: ${re.test(src)}`).toBe(`${file} ${re}: true`);
    }
  });

  it('every writer that creates a Player goes through the one command', () => {
    for (const file of [
      'supabase/functions/create-manual-player/index.ts',
      'supabase/functions/submit-guest-intake/index.ts',
      'supabase/functions/_shared/guest-players.ts',
      'src/lib/invoiceCustomerInsert.ts',
      'src/components/players/AddPlayerForm.tsx',
      'src/components/players/ImportPlayersDialog.tsx',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(`${file}: ${src.includes('player_create_command')}`).toBe(`${file}: true`);
      // ...and carries an attempt id, without which a retry makes a second Player
      expect(`${file}: ${src.includes('_creation_request_id')}`).toBe(`${file}: true`);
    }
  });

  it('every listed site carries a written reason', () => {
    for (const { file, why } of [...SITES, ...RETIRED]) {
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
    const roots = ['src/lib', 'src/components', 'supabase/functions'];
    const listed = new Set([...SITES, ...NOT_IDENTITY, ...RETIRED].map((s) => s.file));
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
        // ...or a Player minted OUTSIDE the command, which is the other way the rule gets bypassed:
        // two of the sites above were direct inserts that no email-shaped detector could see.
        const mints = /from\((["'`])guest_players\1\)[\s\S]{0,80}?\.insert\(/.test(src);
        if ((looksUp || mints) && !listed.has(full)) offenders.push(full);
      }
    };
    for (const r of roots) walk(r);

    expect(offenders).toEqual([]);
  });
});
