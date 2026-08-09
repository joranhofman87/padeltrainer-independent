#!/usr/bin/env node
/**
 * U2 slice 1 — email alone never authorizes an identity merge.
 *
 * Against REAL local PostgreSQL, because what is under test is what a shipped TRIGGER does when a
 * row is inserted. A stub cannot tell you whether `mint_person_for_guest` merged; only inserting a
 * guest and looking at `person_links` can.
 *
 * LOCAL ONLY: the connection string is hardcoded to 127.0.0.1:54322, there is no environment
 * override, and nothing here reads a credential or touches a remote database.
 *
 * Fixtures run inside a transaction and are rolled back. These triggers do not depend on `xmin` or
 * on anything else that needs a commit to be observable — unlike the academy-deletion suite, whose
 * digest forced committed fixtures.
 */
import pg from 'pg';

const CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let failures = 0;
const ok = (msg, cond, extra) => {
  if (cond) console.log('PASS', msg);
  else { failures++; console.error('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
};

const c = new pg.Client({ connectionString: CONN });
await c.connect();
const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await c.query(sql, params)).rows;

/**
 * A real account: auth user → the signup trigger makes the profile, which mints the person.
 *
 * `auth.users.email` is UNIQUE but `profiles.email` is not, which is the whole reason H1 checks the
 * profile count. So the auth address is always distinct and the PROFILE address is the one under
 * test — two accounts really can carry one address in this schema.
 */
async function makeAccount(profileEmail, { distinctAuthEmail = false } = {}) {
  const authEmail = distinctAuthEmail ? `auth-${crypto.randomUUID()}@example.com` : profileEmail;
  const { id: uid } = await one(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $1, '', now(), now()) RETURNING id`, [authEmail]);
  const { id: profileId } = await one(`SELECT id FROM public.profiles WHERE user_id = $1`, [uid]);
  await c.query(`UPDATE public.profiles SET email = $1 WHERE id = $2`, [profileEmail, profileId]);
  return { uid, profileId };
}

const personOfGuest = (g) => one(`SELECT person_id FROM public.person_links WHERE guest_player_id = $1`, [g]);
const personOfProfile = (p) => one(`SELECT person_id FROM public.person_links WHERE profile_id = $1`, [p]);
const reviews = (email) =>
  all(`SELECT kind, status, guest_player_id, profile_id, suggested_profile_id
         FROM public.person_merge_review WHERE lower(email) = lower($1) ORDER BY kind`, [email]);

const EMAIL = () => `u2-${Math.abs(Date.now() % 1e9)}-${Math.floor(process.hrtime()[1] % 1e6)}@example.com`;

// ══ 1. GUEST FIRST, THEN THE ACCOUNT (the shape B2's reverse arm used to collapse) ═════════════
{
  await c.query('BEGIN');
  const email = EMAIL();
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 fixture', 'u2-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Anna Guest', $1, $2) RETURNING id`, [email, academy]);
  const guestPerson = (await personOfGuest(guest)).person_id;

  const { profileId } = await makeAccount(email);
  const profilePerson = (await personOfProfile(profileId)).person_id;

  ok('the guest keeps its OWN person when the account appears', guestPerson !== null);
  ok('...and the account gets a DIFFERENT one — nothing was collapsed',
    profilePerson !== guestPerson, { guestPerson, profilePerson });
  ok('the guest person still exists',
    (await one(`SELECT count(*)::int AS n FROM public.persons WHERE id = $1`, [guestPerson])).n === 1);

  const r = await reviews(email);
  ok('the pair is PROPOSED, pending, never applied',
    r.length === 1 && r[0].kind === 'email_pair_awaiting_claim' && r[0].status === 'pending', r);
  ok('the proposal names both sides, so a claim has something to act on',
    r[0]?.guest_player_id === guest && r[0]?.suggested_profile_id === profileId, r[0]);
  ok('no auto_merged_email_pair row was written',
    !r.some((x) => x.kind === 'auto_merged_email_pair'), r);
  await c.query('ROLLBACK');
}

// ══ 2. ACCOUNT FIRST, THEN THE GUEST (the forward B2 arm) ══════════════════════════════════════
{
  await c.query('BEGIN');
  const email = EMAIL();
  const { profileId } = await makeAccount(email);
  const profilePerson = (await personOfProfile(profileId)).person_id;

  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 fixture 2', 'u2b-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Anna Again', $1, $2) RETURNING id`, [email, academy]);
  const guestPerson = (await personOfGuest(guest)).person_id;

  ok('a new guest matching one account is NOT minted onto that account\'s person',
    guestPerson !== profilePerson, { guestPerson, profilePerson });
  ok('it gets its own person, keyed to itself', guestPerson === guest, { guestPerson, guest });

  const r = await reviews(email);
  ok('and the pair is proposed from this side too',
    r.some((x) => x.kind === 'email_pair_awaiting_claim' && x.status === 'pending'
                  && x.guest_player_id === guest && x.suggested_profile_id === profileId), r);
  await c.query('ROLLBACK');
}

// ══ 3. THE MONEY PATH — no email inference, and no stamping without an explicit link ═══════════
{
  await c.query('BEGIN');
  const email = EMAIL();
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 money', 'u2m-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Anna Money', $1, $2) RETURNING id`, [email, academy]);
  const { id: invoice } = await one(
    `INSERT INTO public.invoices (invoice_number, due_date, player_name, status, guest_player_id)
     VALUES ('U2-' || substr(gen_random_uuid()::text,1,8), current_date, 'Anna Money', 'sent', $1)
     RETURNING id`, [guest]);

  const { profileId } = await makeAccount(email);
  const afterSignup = await one(`SELECT player_id, guest_player_id FROM public.invoices WHERE id = $1`, [invoice]);
  ok('signing up does NOT stamp the guest invoice with the new account',
    afterSignup.player_id === null, afterSignup);
  const g1 = await one(`SELECT linked_profile_id FROM public.guest_players WHERE id = $1`, [guest]);
  ok('...and does not link the guest row either', g1.linked_profile_id === null, g1);

  // calling it directly must ALSO refuse to infer — the arm is gone, not merely unreached
  const direct = await one(`SELECT public.link_guest_data_to_profile($1) AS r`, [profileId]);
  ok('calling link_guest_data_to_profile directly links nothing by email',
    direct.r.bookings_linked === 0 && direct.r.invoices_linked === 0 && direct.r.guest_players_linked === 0,
    direct.r);

  // ...but an ESTABLISHED link is still honoured: that is executing a decision, not making one.
  // (The shipped trg_link_guest_data_on_guest_player_change fires on this UPDATE and does the
  // stamping itself — which is the point: the explicit arm still works, through its own trigger.)
  await c.query(`UPDATE public.guest_players SET linked_profile_id = $1 WHERE id = $2`, [profileId, guest]);
  const afterLink = await one(`SELECT player_id FROM public.invoices WHERE id = $1`, [invoice]);
  ok('an EXPLICITLY linked guest DOES get its invoice stamped', afterLink.player_id === profileId, afterLink);

  const again = await one(`SELECT public.link_guest_data_to_profile($1) AS r`, [profileId]);
  ok('re-running stamps nothing further — it is idempotent', again.r.invoices_linked === 0, again.r);

  // and the explicit arm is genuinely the one doing it: a second guest linked to the same profile
  // is picked up by a direct call, so the function is not merely a no-op now
  const { id: guest2 } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id, linked_profile_id)
     VALUES ('Anna Second Seat', $1, $2, $3) RETURNING id`, [EMAIL(), academy, profileId]);
  await c.query(
    `INSERT INTO public.invoices (invoice_number, due_date, player_name, status, guest_player_id)
     VALUES ('U2B-' || substr(gen_random_uuid()::text,1,8), current_date, 'Anna Second', 'sent', $1)`,
    [guest2]);
  const third = await one(`SELECT public.link_guest_data_to_profile($1) AS r`, [profileId]);
  ok('a directly-called stamp still works for an explicitly linked guest',
    third.r.invoices_linked === 1, third.r);
  await c.query('ROLLBACK');
}

// ══ 4. THE FAMILY EMAIL — two guests on one address were never merged, and still are not ═══════
{
  await c.query('BEGIN');
  const email = EMAIL();
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 family', 'u2f-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: g1 } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Sibling One', $1, $2) RETURNING id`, [email, academy]);
  const { id: g2 } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Sibling Two', $1, $2) RETURNING id`, [email, academy]);
  const { profileId } = await makeAccount(email);

  const p1 = (await personOfGuest(g1)).person_id;
  const p2 = (await personOfGuest(g2)).person_id;
  const pp = (await personOfProfile(profileId)).person_id;
  ok('two guests on one family address stay three distinct people',
    new Set([p1, p2, pp]).size === 3, { p1, p2, pp });

  const r = await reviews(email);
  ok('an ambiguous address proposes nothing — there is no candidate to propose',
    !r.some((x) => x.kind === 'email_pair_awaiting_claim'), r);
  await c.query('ROLLBACK');
}

// ══ 4b. AMBIGUITY IS NOT A CANDIDATE ═══════════════════════════════════════════════════════════
// The proposal needs BOTH counts to be one. The earlier fixtures could not tell either guard from
// its absence: test 1 had a single profile, and the family test inserted both guests before any
// account existed.
{
  await c.query('BEGIN');
  const email = EMAIL();
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 ambiguous', 'u2a-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);

  // TWO accounts carrying one address. `auth.users.email` is unique and `profiles.email` is not,
  // so the second account signs up under its own address and its profile is then moved onto the
  // shared one — which is exactly how two profiles come to share an address in this schema.
  await makeAccount(email);
  await makeAccount(email, { distinctAuthEmail: true });

  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Ambiguous Guest', $1, $2) RETURNING id`, [email, academy]);

  const r = await reviews(email);
  ok('a guest on an address TWO accounts share proposes no claim — there is no single candidate',
    !r.some((x) => x.kind === 'email_pair_awaiting_claim' && x.guest_player_id === guest), r);
  ok('...and the ambiguity is RECORDED rather than passed over',
    r.some((x) => x.kind === 'multi_profile_email' && x.guest_player_id === guest), r);
  await c.query('ROLLBACK');
}

{
  await c.query('BEGIN');
  const email = EMAIL();
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 second guest', 'u2s-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  await makeAccount(email);                                   // one account exists
  const { id: first } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('First Sibling', $1, $2) RETURNING id`, [email, academy]);
  const before = await reviews(email);
  ok('the FIRST guest on an address with one account IS proposed',
    before.some((x) => x.kind === 'email_pair_awaiting_claim' && x.guest_player_id === first), before);

  const { id: second } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Second Sibling', $1, $2) RETURNING id`, [email, academy]);
  const after = await reviews(email);
  ok('a SECOND guest on that address is not — the address stopped being unambiguous',
    !after.some((x) => x.kind === 'email_pair_awaiting_claim' && x.guest_player_id === second), after);
  ok('...and the cluster is recorded instead',
    after.some((x) => x.kind === 'shared_email_cluster' && x.guest_player_id === second), after);
  await c.query('ROLLBACK');
}

// H1's profile-count guard has no reachable fixture: `handle_new_user` copies the UNIQUE auth email
// into the profile, so two profiles cannot be INSERTED carrying one address through the shipped
// signup path. It is fidelity with the body this replaces and defence for any other insert path, so
// it is asserted where it can be — in the shipped definition.
{
  const { d } = await one(
    `SELECT pg_get_functiondef('public.mint_person_for_profile()'::regprocedure) AS d`);
  const guarded = /count\(\*\)\s*FROM public\.profiles p/.test(d) && /=\s*1/.test(d);
  ok('H1 still requires exactly ONE profile on the address before proposing', guarded);
}

// ══ 5. B1 IS KEPT — an explicit, verified assertion is a second signal ═════════════════════════
{
  await c.query('BEGIN');
  const email = EMAIL();
  const { profileId } = await makeAccount(email);
  const profilePerson = (await personOfProfile(profileId)).person_id;
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 twin', 'u2t-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);

  const { id: twin } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id, twin_of_profile_id)
     VALUES ('Twin Seat', $1, $2, $3) RETURNING id`, [email, academy, profileId]);
  const twinPerson = (await personOfGuest(twin)).person_id;
  ok('an EXPLICIT twin assertion whose email verifies still merges — B1 survives',
    twinPerson === profilePerson, { twinPerson, profilePerson });
  ok('and it is recorded as applied',
    (await reviews(email)).some((x) => x.kind === 'auto_merged_twin_trust' && x.status === 'applied'));

  // a twin assertion that does NOT verify still goes to the queue rather than merging.
  // A different academy: twins are unique per (academy, profile).
  const other = EMAIL();
  const { id: academy2 } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 twin 2', 'u2t2-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: mismatch } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id, twin_of_profile_id)
     VALUES ('Wrong Twin', $1, $2, $3) RETURNING id`, [other, academy2, profileId]);
  const mismatchPerson = (await personOfGuest(mismatch)).person_id;
  ok('an unverified twin assertion does not merge', mismatchPerson !== profilePerson);
  ok('...and is queued as twin_trust_failure',
    (await reviews(other)).some((x) => x.kind === 'twin_trust_failure'));
  await c.query('ROLLBACK');
}

// ══ 6. NOTHING IN THE SCHEMA STILL PERFORMS AN EMAIL-ALONE MERGE ═══════════════════════════════
// The decision is "no auto-merge on email", not "no auto-merge on email in the two places we looked".
// So the whole shipped function set is searched for one that both reads an email and collapses.
{
  const suspects = await all(`
    SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND pg_get_functiondef(p.oid) ~* 'lower\\(btrim\\((g|gp|p)?\\.?email\\)\\)|lower\\(trim\\((g|gp|p)?\\.?email\\)\\)'
       AND pg_get_functiondef(p.oid) ~* 'collapse_guest_person_into_reporting|SET player_id|linked_profile_id\\s*=\\s*_profile_id|INSERT INTO public\\.person_links'
     ORDER BY 1`);
  const names = suspects.map((r) => r.proname);

  // Each of these reads an email AND writes identity, and each has been read line by line. The
  // reason matters more than the name — an allow-list of bare names is how the third one nearly got
  // waved through.
  const REVIEWED = new Map([
    ['mint_person_for_profile',
     'B2 retired here: a matching guest is proposed as email_pair_awaiting_claim, never collapsed.'],
    ['mint_person_for_guest',
     'B2 retired here too. B1 twin-trust remains — an explicit twin_of_profile_id assertion, verified against the email rather than derived from it.'],
    ['relink_person_on_twin_change',
     'Collapses ONLY when twin_of_profile_id changes to a non-null value — an explicit operator assertion, with the email used to VERIFY it. Never fires on an email match alone; an email move with no stamp change only files a pending review row.'],
    ['merge_guest_players',
     'The reviewed, operator-invoked merge command. Authorized by the caller, not by a match.'],
    ['collapse_guest_person_into_reporting',
     'The mechanism the above call; it decides nothing on its own.'],
    ['rederive_person',
     'Recomputes one person from its own linked sources. Establishes no link.'],
  ]);
  const unreviewed = names.filter((n) => !REVIEWED.has(n));
  ok('no unreviewed function both matches on an email and writes identity', unreviewed.length === 0,
    { unreviewed, all: names });

  // ...and every reason is written, so an entry cannot be added as a bare name to silence the sweep
  const written = (why) => typeof why === 'string' && why.length >= 40;
  const thin = [...REVIEWED.entries()].filter(([, why]) => !written(why));
  ok('every reviewed identity writer carries a written reason', thin.length === 0, thin.map(([n]) => n));

  // and the rule is asked a question it can fail — otherwise it only ever sees reasons already written
  ok('the written-reason rule actually rejects a bare name',
    !written('') && !written(undefined) && !written('conforms') && written('x'.repeat(40)));
}

await c.end();

if (failures > 0) {
  console.error(`\n❌ u2 email-alone-merge FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ u2 email-alone-merge passed');
