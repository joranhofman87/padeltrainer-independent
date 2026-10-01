// @vitest-environment node
/**
 * U2 — the client half of "attributes never select an identity", plus the canonical-identity
 * contract of the create flows (owner correction, 2026-08-09).
 *
 * The database side is proven against real PostgreSQL by `scripts/db/u2-no-email-alone-merge.mjs`.
 * That suite sweeps `pg_proc`, which is exactly why it could not see the writers that made the same
 * decision in TypeScript. Those writers are gone; their behaviour is asserted where behaviour
 * belongs — `invoiceCustomerInsert.test.ts`, `playerResolve.test.ts`, and the Deno handler suites
 * under `supabase/functions/_shared/`. What is left here is the thing a behavioural test cannot do:
 * notice a NEW writer, or a listed file quietly regressing.
 *
 * HOW THESE DETECTORS READ SOURCE, and the honest limits of that. There is no comment stripper any
 * more — the homemade lexer this file used to lean on mishandled template-literal interpolation,
 * regex literals and nested SQL comments, which made its output an untrustworthy foundation
 * (round-9 finding). Detectors now read RAW source, which splits them into two safety classes:
 *
 *   * NEGATIVE detectors ("this pattern is ABSENT") fail when a comment quotes the pattern. That
 *     failure mode is SAFE — the test goes red, somebody rewords the prose — and it is the price
 *     of never letting a lexer bug hide a real match. Deliberate.
 *   * POSITIVE detectors ("this file calls the command") could in principle be satisfied by a
 *     comment quoting the exact executable shape. That failure mode is NOT safe, so every positive
 *     detector here is (a) narrowed to an argument-position syntax prose has no reason to contain,
 *     (b) mutation-tested below — each must FAIL on the real source with the call removed — and
 *     (c) backed by a behavioural suite that exercises the real module with a mocked client, which
 *     is the actual proof. The text checks are tripwires, not the evidence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const read = (file: string) => readFileSync(file, 'utf8');

/** The executable shape of a create-command call: the rpc name in call position. */
const CALLS_CREATE_COMMAND = /\.rpc\(\s*["']player_create_command["']/;
/** The executable shape of carrying the caller's attempt id: the argument key, colon-terminated. */
const CARRIES_ATTEMPT_ID = /_creation_request_id\s*[:=]/;

/**
 * Sites that look a person up by email AND could influence identity, kept safe by a property
 * rather than by removal. EMPTY, and that is the finding rather than an oversight: every such
 * writer was deleted rather than guarded, because a guarded lookup is one edit away from being an
 * unguarded one. The list stays so a future exemption has somewhere to go — and a test below
 * asserts it is empty, so adding one has to be a deliberate act somebody reviews.
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
    file: 'src/components/players/AddPlayerForm.tsx',
    why: 'reads same-scope guest NAMES on the typed address to ask the operator whether the new player is a family member — a proposal made to a human, which is exactly what attributes are allowed to do. The create itself is the UUID command.',
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
 *
 * These are NEGATIVE detectors on raw source: a comment quoting one of the patterns turns the test
 * red, and the fix is to reword the comment. Deliberate — see the header.
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
      'no human in the loop. The whole lookup machinery is deleted, not guarded — including the ' +
      'find_guest_twin_for_academy pre-check, whose one remaining hit was a guest under merge review ' +
      'that belongs to a DIFFERENT person',
    absent: [
      /findExistingGuestPlayerIdByEmail/,
      /requireNameMatch/,
      /claim_guest_twin_for_academy/,
      /find_guest_twin_for_academy/,
      /\.ilike\(/,
    ],
  },
];

/**
 * The canonical-identity contract of the CONVERTED create/write flows (owner correction,
 * 2026-08-09): no browser client receives, selects, stores or depends on `guest_player_id`. These
 * files' NEW contracts are person-keyed; the patterns below are the executable shapes by which a
 * legacy id could creep back in — a quoted column/property name, or a legacy-keyed rpc argument.
 *
 * The list names only files whose EVERY legacy reference is gone. Files that still carry
 * pre-existing legacy READ surfaces next to a converted create path (the booking dialogs, the
 * overview lib) are covered by the type system instead: `CreatedPlayer` has no legacy field, so a
 * consumer reaching for one does not compile. The real proof of the rpc payloads and return values
 * is behavioural — invoiceCustomerInsert.test.ts, playerResolve.test.ts, and the Deno suites.
 */
const CANONICAL_ONLY: Array<{ file: string; why: string }> = [
  {
    file: 'src/lib/invoiceCustomerInsert.ts',
    why: 'resolves the invoice recipient as person_id; the INSERT is invoice_create_for_person, server-side. The picker-link presence check reads no value out.',
  },
  {
    file: 'src/lib/playerResolve.ts',
    why: 'the roster twin bridge answers { personId } only; has_trained moved into person_mark_has_trained.',
  },
  {
    file: 'src/components/players/AddPlayerForm.tsx',
    why: 'renders the person_display_for_owner projection instead of re-reading guest_players by the id the command used to return.',
  },
  {
    file: 'src/components/players/ImportPlayersDialog.tsx',
    why: 'collects person ids per imported row; the per-row guest re-read is gone.',
  },
  {
    file: 'src/components/players/AddPlayerDialog.tsx',
    why: 'the create callback carries CreatedPlayer — a person-keyed projection with no legacy field to pass along.',
  },
  {
    file: 'src/components/cycles/AddIntakeRequestDialog.tsx',
    why: 'hands person_id to createManualIntakeRequest; the edge response it consumes no longer contains a guest id.',
  },
  {
    file: 'src/components/cycles/CycleRosterInlinePicker.tsx',
    why: 'a created player is selected by person_id from the refreshed overview rows; the picker no longer fabricates a BookablePerson from the create result.',
  },
];

/**
 * Executable shapes by which a legacy guest id could re-enter a canonical-only file. Quote chars
 * are ' and " only: a backticked `guest_player_id` is how PROSE names the column, and supabase-js
 * call sites never template-literal a column name.
 */
const LEGACY_SHAPES: RegExp[] = [
  /["']guest_player_id["']/, // a quoted column name: .eq('guest_player_id'), { 'guest_player_id': ... }
  /\.guest_player_id\b/,     // property access on a row
  /guest_player_id\s*:/,     // an object key: insert payloads, rpc args
  /\.guestPlayerId\b/,       // property access on a camelCase contract
  /guestPlayerId\s*:/,       // a camelCase object key
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
    // the ONE claim here that is genuinely about documentation, and labelled as such
    const src = read(file);
    // the words a future reviewer needs to find, not a paraphrase they have to reconstruct
    expect(`${file} names the distinction: ${/CONTACT[, ]/i.test(src) && /identity/i.test(src)}`)
      .toBe(`${file} names the distinction: true`);
  });

  it('...and every one CREATES its Player rather than resolving one', () => {
    // The precise property, not a scan: a flow that requires an address for delivery must still
    // reach a Player the same way as everything else — through the UUID command, on the caller's
    // attempt id. The SQL migration calls the execute layer directly (it IS a definer command);
    // the edge functions call the command rpc, directly or through `_shared/guest-players.ts`,
    // which is itself a RETIRED entry above and asserted there to query nothing.
    for (const { file } of CONTACT_REQUIRED) {
      const src = read(file);
      const createsThroughTheCommand =
        CALLS_CREATE_COMMAND.test(src)
        || /player_create_execute\s*\(/.test(src)
        || /resolvePlayerForCheckout/.test(src);
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
    const src = read(file);
    for (const re of absent) {
      expect(`${file} still matches ${re}: ${re.test(src)}`).toBe(`${file} still matches ${re}: false`);
    }
  });

  it('no site is exempted as "matches but is safe" — they were removed, not guarded', () => {
    expect(SITES).toEqual([]);
  });

  it.each(SITES)('$file keeps the property that makes it safe', ({ file, must }) => {
    const src = read(file);
    for (const re of must) {
      expect(`${file} ${re}: ${re.test(src)}`).toBe(`${file} ${re}: true`);
    }
  });

  it('every writer that creates a Player goes through the one command', () => {
    // Tripwire, not evidence: the executable call shape must be present. The proof that the call
    // actually happens (and with which arguments) lives in the behavioural suites listed in the
    // header. The mutation tests below keep this detector honest.
    for (const file of [
      'supabase/functions/create-manual-player/index.ts',
      'supabase/functions/submit-guest-intake/index.ts',
      'supabase/functions/_shared/guest-players.ts',
      'src/lib/invoiceCustomerInsert.ts',
      'src/components/players/AddPlayerForm.tsx',
      'src/components/players/ImportPlayersDialog.tsx',
      'src/lib/playerResolve.ts',
    ]) {
      const src = read(file);
      expect(`${file} calls the command: ${CALLS_CREATE_COMMAND.test(src)}`)
        .toBe(`${file} calls the command: true`);
      expect(`${file} carries an attempt id: ${CARRIES_ATTEMPT_ID.test(src)}`)
        .toBe(`${file} carries an attempt id: true`);
    }
  });
});

describe('the converted flows are canonical-only — no legacy id in their executable shapes', () => {
  it.each(CANONICAL_ONLY)('$file contains no guest-id shape', ({ file }) => {
    const src = read(file);
    for (const re of LEGACY_SHAPES) {
      expect(`${file} matches ${re}: ${re.test(src)}`).toBe(`${file} matches ${re}: false`);
    }
  });

  it('every canonical-only entry carries a written reason', () => {
    for (const { file, why } of CANONICAL_ONLY) {
      expect(`${file}: ${why.length >= 60}`).toBe(`${file}: true`);
    }
  });

  it('the person-keyed projection type itself carries no legacy field to leak through', () => {
    // CreatedPlayer is the compile-time half of the guarantee: consumers of the create callbacks
    // cannot reach for a guest id because the type has none. This pins the type against a quiet
    // re-addition.
    const src = read('src/components/players/guestPlayer.ts');
    const created = src.slice(src.indexOf('interface CreatedPlayer'));
    expect(/guest/i.test(created.slice(0, created.indexOf('}')))).toBe(false);
  });
});

// ── the guard has to be able to FAIL ────────────────────────────────────────────────────────────
// Every load-bearing assertion above is either a negative ("this pattern is absent") or a textual
// positive ("this call shape is present"). A negative that can never fire looks exactly like a
// clean codebase — which is how the rebook RPC deduplicated on `lower(email)` through four review
// rounds — and a positive that fires on anything is no pin at all. So both directions are run
// against MUTATED real source and required to catch the mutation.
describe('the detectors catch what they are for', () => {
  /** The two shapes U2 exists to prevent, injected into real source. */
  const emailReuseTs = `
    const { data } = await supabase.from('guest_players').select('id').eq('email', typed).single();
    if (data) return data.id;`;
  const emailReuseSql = `
    SELECT id INTO v_id FROM public.guest_players WHERE lower(email) = v_email LIMIT 1;`;
  const directWriteTs = `
    await supabase.from("guest_players").insert({ full_name: name, academy_profile_id: id });`;
  const legacyLeakTs = `
    const guestPlayerId = (created as { guest_player_id: string | null }).guest_player_id;
    return { guestPlayerId };`;

  it('a TypeScript site that starts reusing by email is caught', () => {
    const mutated = read('src/lib/invoiceCustomerInsert.ts') + emailReuseTs;
    const looksUp = /from\((["'`])(profiles|guest_players|persons|club_players|intake_requests)\1\)/.test(mutated)
      && /\.(eq|ilike)\((["'`])email\2/.test(mutated);
    expect(looksUp).toBe(true);
    // ...and the RETIRED contract for that file rejects it too
    expect(/\.from\(/.test(mutated)).toBe(true);
  });

  it('a SQL site that starts reusing by email is caught', () => {
    const mutated = read('supabase/migrations/20261124100000_u2_rebook_group_guest_uuid_create.sql')
      + emailReuseSql;
    expect(/lower\(email\)\s*=/.test(mutated)).toBe(true);
    expect(/INSERT INTO public\.guest_players/.test(mutated)).toBe(false);
  });

  it('a site that starts writing an identity row directly is caught', () => {
    const mutated = read('src/components/players/AddPlayerForm.tsx') + directWriteTs;
    expect(/from\((["'`])guest_players\1\)[\s\S]{0,80}?\.insert\(/.test(mutated)).toBe(true);
  });

  it('a converted flow that starts trafficking a guest id again is caught', () => {
    for (const { file } of CANONICAL_ONLY) {
      const mutated = read(file) + legacyLeakTs;
      expect(`${file}: ${LEGACY_SHAPES.some((re) => re.test(mutated))}`).toBe(`${file}: true`);
    }
  });

  it('the POSITIVE detectors fail on real source with the call removed — they cannot pass vacuously', () => {
    // Mutation check for the tripwires: strip the actual rpc call / argument key out of each real
    // file and the detector must stop matching. If it kept matching, prose somewhere in that file
    // satisfies it and the tripwire is decorative — which is precisely the failure mode this file
    // is not allowed to have silently.
    for (const file of [
      'src/lib/invoiceCustomerInsert.ts',
      'src/lib/playerResolve.ts',
      'src/components/players/AddPlayerForm.tsx',
      'src/components/players/ImportPlayersDialog.tsx',
    ]) {
      const src = read(file);
      const withoutCall = src.replace(/\.rpc\(\s*["']player_create_command["']/g, '.rpc("somewhere_else"');
      expect(`${file} detector survives call removal: ${CALLS_CREATE_COMMAND.test(withoutCall)}`)
        .toBe(`${file} detector survives call removal: false`);
      const withoutAttempt = src.replace(/_creation_request_id\s*[:=]/g, '_renamed_key:');
      expect(`${file} detector survives attempt-id removal: ${CARRIES_ATTEMPT_ID.test(withoutAttempt)}`)
        .toBe(`${file} detector survives attempt-id removal: false`);
    }
  });

  it('...and none of the negative patterns fires on the REAL sources, so the catches above mean something', () => {
    for (const file of [
      'src/lib/invoiceCustomerInsert.ts',
      'src/components/players/AddPlayerForm.tsx',
      'src/components/players/ImportPlayersDialog.tsx',
      'supabase/functions/_shared/guest-players.ts',
      'src/lib/cycles.ts',
    ]) {
      const src = read(file);
      expect(`${file} direct write: ${/from\((["'`])guest_players\1\)[\s\S]{0,80}?\.insert\(/.test(src)}`)
        .toBe(`${file} direct write: false`);
    }
    expect(/lower\(email\)\s*=/.test(
      read('supabase/migrations/20261124100000_u2_rebook_group_guest_uuid_create.sql'),
    )).toBe(false);
  });
});

describe('the catalog is complete and reasoned', () => {
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
    // address, because silence is what let two of these ship. It reads RAW source, so a comment
    // that quotes a lookup shape will drag its file into this list — reword the comment or list
    // the file with a reason; both are visible acts.
    const roots = ['src/lib', 'src/components', 'supabase/functions'];
    const listed = new Set([...SITES, ...NOT_IDENTITY, ...RETIRED].map((s) => s.file));
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || /\.test\./.test(entry.name)) continue;
        const src = read(full);
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
