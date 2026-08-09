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
const SITES: Array<{ file: string; why: string; must: RegExp[] }> = [];

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
  {
    file: 'src/lib/playerResolve.ts',
    why:
      'the roster TWIN bridge. It claimed a guest found by address and exact name, and STAMPED it ' +
      'with twin_of_profile_id — which mint_person_for_guest treats as the operator assertion that ' +
      'authorizes joining that guest to the profile. An attribute match laundered into a merge, with ' +
      'no human in the loop: the roster UI supplies a profile id and nothing else. The whole lookup ' +
      'machinery is deleted, not guarded',
    absent: [/findExistingGuestPlayerIdByEmail/, /requireNameMatch/, /claim_guest_twin_for_academy/, /\.ilike\(/],
  },
];

/**
 * SQL sites, because the TypeScript sweep is structurally blind to them — and that blindness is
 * exactly what let `create_rebook_group_guest` keep deduplicating on `lower(email)`, anon-callable,
 * for the whole of this unit. The real-Postgres suite sweeps `pg_proc` for the same property
 * against the LIVE schema; this catches it in review, before anything is applied.
 */
const SQL_RETIRED: Array<{ file: string; why: string; absent: RegExp[] }> = [
  {
    file: 'supabase/migrations/20261124100000_u2_rebook_group_guest_uuid_create.sql',
    why: 'the rebook group add-a-member: dedup on lower(email) alone, no name, LIMIT 1, reachable by anon holding a group token',
    absent: [/lower\(email\)\s*=/, /INSERT INTO public\.guest_players/],
  },
];

/**
 * The five flows that REQUIRE an address, and why that is not a U2 violation.
 *
 * Two reviews in a row read "a Player may have no email" as "no flow may ask for one" and filed it
 * as a defect. They are different invariants: the PLAYER ENTITY has an optional address, while a
 * WORKFLOW THAT DELIVERS SOMETHING — a pay link, a confirmation — may require one as input. The
 * owner settled this on 2026-08-09 and the rebook requirement is older still (20260705110000,
 * Slice C, owner decision #4).
 *
 * Each site therefore has to carry the distinction in writing, next to its guard, so the next
 * reader can tell which of the two they have found without re-litigating it.
 */
const CONTACT_REQUIRED: Array<{ file: string; why: string }> = [
  {
    file: 'supabase/functions/create-guest-slot-payment/index.ts',
    why: 'anonymous single-slot checkout — the Mollie pay link and the booking confirmation are sent to this address',
  },
  {
    file: 'supabase/functions/create-guest-cart-payment/index.ts',
    why: 'anonymous cart checkout — same delivery, for several sessions at once',
  },
  {
    file: 'supabase/functions/create-guest-cyclus-payment/index.ts',
    why: 'anonymous whole-series checkout — same delivery, for a cyclus',
  },
  {
    file: 'supabase/functions/submit-guest-intake/index.ts',
    why: 'public self-service registration — the confirmation, and for a paid form the pay link, go to this address',
  },
  {
    file: 'supabase/migrations/20261124100000_u2_rebook_group_guest_uuid_create.sql',
    why: 'rebook-group add — Slice C requires a new member to be fully reachable, an owner decision that predates U2',
  },
];

describe('requiring an address to REACH someone is not resolving who they are', () => {
  it.each(CONTACT_REQUIRED)('$file says which invariant its guard serves', ({ file }) => {
    const src = readFileSync(file, 'utf8');
    // the words a future reviewer needs to find, not a paraphrase they have to reconstruct
    expect(`${file} names the distinction: ${/CONTACT[, ]/i.test(src) && /identity/i.test(src)}`)
      .toBe(`${file} names the distinction: true`);
  });

  it('...and every one CREATES its Player rather than resolving one', () => {
    // The precise property, not a scan: a flow that requires an address for delivery must still
    // reach a Player the same way as everything else — through the UUID command, on the caller's
    // attempt id. (A file-level "does it read an email anywhere" heuristic is the wrong tool here
    // and gives false positives: `submit-guest-intake` legitimately reads manager addresses to
    // notify them and counts recent intakes on the submitted address to suppress a double-click.
    // Those are enumerated with reasons in NOT_IDENTITY above.)
    for (const { file } of CONTACT_REQUIRED) {
      const src = readFileSync(file, 'utf8');
      // ...directly, or through `_shared/guest-players.ts`, which is itself a RETIRED entry above
      // and asserted there to call the command and to query nothing.
      const createsThroughTheCommand =
        src.includes('player_create_command')
        || src.includes('player_create_execute')
        || src.includes('resolveOrCreateGuestPlayer');
      expect(`${file} creates through the command: ${createsThroughTheCommand}`)
        .toBe(`${file} creates through the command: true`);
      // and carries the caller's attempt id, without which a retry makes a second Player
      expect(`${file} carries an attempt id: ${/creation_?[rR]equest_?[iI]d/.test(src)}`)
        .toBe(`${file} carries an attempt id: true`);
    }
  });

  it('every one carries a written reason', () => {
    for (const { file, why } of CONTACT_REQUIRED) {
      expect(`${file}: ${why.length >= 40}`).toBe(`${file}: true`);
    }
  });
});

describe('no source site resolves a person from an address', () => {
  it.each([...RETIRED, ...SQL_RETIRED])('$file no longer looks anybody up', ({ file, absent }) => {
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
      'src/lib/playerResolve.ts',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(`${file}: ${src.includes('player_create_command')}`).toBe(`${file}: true`);
      // ...and carries an attempt id, without which a retry makes a second Player
      expect(`${file}: ${src.includes('_creation_request_id')}`).toBe(`${file}: true`);
    }
  });

  it('every listed site carries a written reason', () => {
    for (const { file, why } of [...SITES, ...RETIRED, ...SQL_RETIRED]) {
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
