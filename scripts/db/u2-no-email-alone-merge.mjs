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
  // pin the profile clause ITSELF: searching the whole body for `= 1` passes while the profile
  // condition says `> 0`, because the guest condition still says `= 1`
  const profileClause = d.match(
    /\(SELECT count\(\*\) FROM public\.profiles p[\s\S]{0,200}?\)\s*(=|>|>=|<)\s*(\d+)/);
  ok('H1 still requires exactly ONE profile on the address before proposing',
    Boolean(profileClause) && profileClause[1] === '=' && profileClause[2] === '1',
    { operator: profileClause?.[1], value: profileClause?.[2] });
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

// ══ 5b. THE CLAIM — the only route from a proposal to one person ═══════════════════════════════
// Slice 1 left two Player records where there used to be one merged pair. This is what joins them,
// and the whole point is WHO may run it: the proposal is made by matching, the claim by the human.
//
// `auth.uid()` is read from the JWT, so these run as `authenticated` with a request-local claim set,
// exactly as PostgREST does it — a claim tested as the superuser would prove nothing about who may
// make one.
const asUser = async (uid, fn) => {
  await c.query('SAVEPOINT au');
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await c.query(`SET LOCAL ROLE authenticated`);
  try {
    const r = await fn();
    await c.query(`RESET ROLE`);
    await c.query(`SELECT set_config('request.jwt.claims', NULL, true)`);
    return { ok: true, value: r };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT au');
    await c.query(`RESET ROLE`);
    return { ok: false, code: e.code, message: e.message };
  }
};

/** guest + later account on one address = one pending proposal, per slice 1. */
async function proposedPair() {
  const email = EMAIL();
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 claim', 'u2c-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Anna Claimant', $1, $2) RETURNING id`, [email, academy]);
  const { id: invoice } = await one(
    `INSERT INTO public.invoices (invoice_number, due_date, player_name, status, guest_player_id)
     VALUES ('U2C-' || substr(gen_random_uuid()::text,1,8), current_date, 'Anna', 'sent', $1)
     RETURNING id`, [guest]);
  const { uid, profileId } = await makeAccount(email);
  const { id: reviewId } = await one(
    `SELECT id FROM public.person_merge_review
      WHERE kind = 'email_pair_awaiting_claim' AND guest_player_id = $1`, [guest]);
  return { email, academy, guest, invoice, uid, profileId, reviewId };
}

{
  await c.query('BEGIN');
  const f = await proposedPair();
  const guestPerson = (await personOfGuest(f.guest)).person_id;
  const profilePerson = (await personOfProfile(f.profileId)).person_id;
  ok('the pair starts as two people', guestPerson !== profilePerson);

  const seen = await asUser(f.uid, async () =>
    (await c.query(`SELECT * FROM public.person_claim_candidates()`)).rows);
  ok('the claimant is offered their own proposal',
    seen.ok && seen.value.length === 1 && seen.value[0].guest_player_id === f.guest, seen);
  ok('...with the name they need to answer "is this you?", and nothing else',
    seen.ok && seen.value[0].guest_name === 'Anna Claimant'
    && !Object.keys(seen.value[0]).some((k) => /email|phone/.test(k)), Object.keys(seen.value?.[0] ?? {}));

  const done = await asUser(f.uid, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  ok('the claim succeeds', done.ok && done.value.ok === true, done);

  const after = (await personOfGuest(f.guest)).person_id;
  ok('the two are now ONE person', after === profilePerson, { after, profilePerson });
  ok('the money the guest owed follows the account',
    (await one(`SELECT player_id FROM public.invoices WHERE id = $1`, [f.invoice])).player_id === f.profileId);
  const r = await one(`SELECT status, details FROM public.person_merge_review WHERE id = $1`, [f.reviewId]);
  ok('the proposal is applied and says WHO claimed it',
    r.status === 'applied' && r.details.resolved_by === 'user_claim' && r.details.claimed_by_user === f.uid, r);

  // idempotent: the second click changes nothing and does not fail
  const again = await asUser(f.uid, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  ok('claiming twice is a no-op, not an error',
    again.ok && again.value.ok === true && again.value.already_applied === true, again);
  await c.query('ROLLBACK');
}

// ══ 5c. A CLAIM IS NOT A ROUTE AROUND THE RULE ═════════════════════════════════════════════════
{
  await c.query('BEGIN');
  const f = await proposedPair();
  const { uid: strangerUid } = await makeAccount(EMAIL());

  const stolen = await asUser(strangerUid, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  ok('someone else cannot claim your pair', !stolen.ok && /CLAIM_NOT_YOURS/.test(stolen.message ?? ''), stolen);

  const hidden = await asUser(strangerUid, async () =>
    (await c.query(`SELECT * FROM public.person_claim_candidates()`)).rows);
  ok('...and cannot even see it offered', hidden.ok && hidden.value.length === 0, hidden);

  const anon = await asUser(null, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  // the SPECIFIC refusal: without the auth check the ownership check would also refuse (a NULL uid
  // matches no profile), so asserting "it failed" would pass with the guard removed
  ok('an unauthenticated caller is refused AS unauthenticated',
    !anon.ok && /CLAIM_NOT_AUTHENTICATED/.test(anon.message ?? ''), anon);

  const stillTwo = (await personOfGuest(f.guest)).person_id;
  ok('after all of that the pair is still two people',
    stillTwo !== (await personOfProfile(f.profileId)).person_id);
  await c.query('ROLLBACK');
}

{
  // the claim executes a PROPOSAL — it cannot be pointed at an arbitrary pair
  await c.query('BEGIN');
  const f = await proposedPair();
  await c.query(`UPDATE public.person_merge_review SET kind = 'shared_email_cluster' WHERE id = $1`,
    [f.reviewId]);
  const wrongKind = await asUser(f.uid, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  ok('a row that is not a claim proposal cannot be claimed',
    !wrongKind.ok && /CLAIM_NOT_YOURS/.test(wrongKind.message ?? ''), wrongKind);
  await c.query('ROLLBACK');
}

{
  // a guest already linked to a DIFFERENT account is not available, proposal or no proposal
  await c.query('BEGIN');
  const f = await proposedPair();
  const { profileId: other } = await makeAccount(EMAIL());
  await c.query(`UPDATE public.guest_players SET linked_profile_id = $1 WHERE id = $2`, [other, f.guest]);
  const taken = await asUser(f.uid, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  ok('a player already linked elsewhere cannot be claimed',
    !taken.ok && /CLAIM_TAKEN/.test(taken.message ?? ''), taken);
  await c.query('ROLLBACK');
}

// ══ 5c-2. THE CLAIM LOCKS THE GUEST ROW, NOT JUST THE PROPOSAL ═════════════════════════════════
// Reading `linked_profile_id` and then writing it is a window: an operator links the guest to
// account B in between, and the claimant overwrites it with A and collapses on top. Locking the
// PROPOSAL does not lock the guest. Proven by holding the guest row from another session — if the
// claim did not lock it, it would sail past and succeed.
{
  await c.query('BEGIN');
  const f = await proposedPair();
  await c.query('COMMIT');                      // the holder needs to see it

  const holder = new pg.Client({ connectionString: CONN });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query(`SELECT linked_profile_id FROM public.guest_players WHERE id = $1 FOR UPDATE`,
    [f.guest]);

  const claimer = new pg.Client({ connectionString: CONN });
  await claimer.connect();
  await claimer.query(`SET lock_timeout = '800ms'`);
  await claimer.query('BEGIN');
  await claimer.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: f.uid, role: 'authenticated' })]);
  await claimer.query(`SET LOCAL ROLE authenticated`);
  let blocked = null;
  try { await claimer.query(`SELECT public.person_claim_confirm($1)`, [f.reviewId]); }
  catch (e) { blocked = e.code; }
  await claimer.query('ROLLBACK').catch(() => {});
  await holder.query('ROLLBACK');

  // HONEST SCOPE: this proves the claim cannot proceed while another session holds the guest row.
  // It does NOT discriminate the `FOR UPDATE` on the read — without it the later UPDATE blocks on
  // the same lock and times out identically. The interleaving that separates them (a commit landing
  // between the read and the write) is not something this harness can stage, so the guarantee does
  // not rest on the lock alone: the claim re-reads `linked_profile_id` after writing it and refuses
  // if it is not ours, which is asserted by the CLAIM_TAKEN case above.
  ok('a claim cannot proceed while another session holds the guest row',
    blocked === '55P03', { blocked });

  await Promise.all([holder.end(), claimer.end()]);
  // committed fixture: clean it up
  await c.query(`DELETE FROM public.person_merge_review WHERE id = $1`, [f.reviewId]);
  await c.query(`DELETE FROM public.invoices WHERE id = $1`, [f.invoice]);
  await c.query(`DELETE FROM public.guest_players WHERE id = $1`, [f.guest]);
  await c.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [f.academy]);
  await c.query(`DELETE FROM auth.users WHERE id = $1`, [f.uid]);
}

// ══ 5d. CREATION IS IDEMPOTENT ON A REQUEST UUID, NOT ON A PERSON'S ATTRIBUTES ═════════════════
// `person_id` is the canonical Player identity; a separate stable UUID identifies the create
// COMMAND. Email, phone and name are mutable attributes and matching signals — never identity, never
// idempotency keys — and knowing a UUID never grants authorization (owner, 2026-08-09).

/** Run as `service_role`, the way an edge function's service key reaches PostgREST. */
const asService = async (fn) => {
  await c.query('SAVEPOINT sv');
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ role: 'service_role' })]);
  await c.query(`SET LOCAL ROLE service_role`);
  try {
    const r = await fn();
    await c.query(`RESET ROLE`);
    await c.query(`SELECT set_config('request.jwt.claims', NULL, true)`);
    return { ok: true, value: r };
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT sv');
    await c.query(`RESET ROLE`);
    return { ok: false, code: e.code, message: e.message };
  }
};

const CREATE_SQL = `SELECT public.player_create_command(
  _creation_request_id => $1, _owner_type => $2, _owner_id => $3,
  _full_name => $4, _email => $5, _phone => $6,
  _select_person_id => $7, _actor_user_id => $8, _origin => $9) AS r`;

/** The command as a signed-in operator. Every argument spelled out, so no default hides a change. */
const runCreate = (client, args) => client.query(CREATE_SQL, [
  args.req, args.ownerType, args.ownerId ?? null, args.name ?? null, args.email ?? null,
  args.phone ?? null, args.selectPerson ?? null, args.actor ?? null, args.origin ?? 'operator',
]);
const create = (uid, args) => asUser(uid, async () => (await runCreate(c, args)).rows[0].r);
const newUuid = async () => (await one(`SELECT gen_random_uuid() AS id`)).id;

{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 create', 'u2cr-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: managerUid } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, managerUid]).catch(async () => {
    await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id)
                   VALUES ($1, $2)`, [academy, managerUid]);
  });
  const seededRole = await one(
    `SELECT role FROM public.academy_managers WHERE academy_profile_id = $1 AND user_id = $2`,
    [academy, managerUid]);
  ok('the create fixture seeds a MANAGER, not an owner', (seededRole?.role ?? 'manager') !== 'owner', seededRole);

  const email = EMAIL();
  const reqA = await newUuid();
  const base = { ownerType: 'academy', ownerId: academy };

  const first = await create(managerUid, { ...base, req: reqA, name: 'Nieuwe Speler', email });
  ok('an academy manager can create a player', first.ok && first.value.created === true, first);
  ok('the answer is the canonical person_id', first.ok && first.value.person_id !== null, first.value);

  const replay = await create(managerUid, { ...base, req: reqA, name: 'Nieuwe Speler', email });
  ok('the SAME request id replays — same Player, nothing created',
    replay.ok && replay.value.created === false && replay.value.replayed === true
    && replay.value.person_id === first.value.person_id, replay);

  // a DIFFERENT attempt for the same human is a different Player, and only a proposal
  const reqB = await newUuid();
  const twin = await create(managerUid, { ...base, req: reqB, name: 'Nieuwe Speler', email });
  ok('a different request id with IDENTICAL name and email is NOT silently the same Player',
    twin.ok && twin.value.person_id !== first.value.person_id, twin);
  ok('...it is proposed for review instead',
    (await one(`SELECT count(*)::int AS n FROM public.person_merge_review
                 WHERE kind = 'possible_duplicate_player' AND person_id = $1`, [twin.value.person_id])).n === 1);

  // ...and the proposal does not need the addresses to agree. A player entered once WITHOUT an
  // address and once with one is the commonest real duplicate there is, and an email-equality
  // requirement would miss exactly it.
  const reqNoAddr = await newUuid();
  const sameNameNoEmail = await create(managerUid, { ...base, req: reqNoAddr, name: 'Nieuwe Speler' });
  ok('a same-name Player with NO address is proposed against the one that has one',
    sameNameNoEmail.ok &&
    (await one(`SELECT count(*)::int AS n FROM public.person_merge_review
                 WHERE kind = 'possible_duplicate_player' AND person_id = $1`,
      [sameNameNoEmail.value.person_id])).n === 1, sameNameNoEmail);

  // reusing an id with different material facts is a caller bug and is told so
  const conflict = await create(managerUid, { ...base, req: reqA, name: 'Andere Naam', email });
  ok('reusing a request id with a CHANGED payload is refused',
    !conflict.ok && /IDEMPOTENCY_CONFLICT/.test(conflict.message ?? ''), conflict);

  const { id: academy2 } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 other', 'u2o-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy2, managerUid]).catch(() => {});
  const crossAcademy = await create(managerUid,
    { ownerType: 'academy', ownerId: academy2, req: reqA, name: 'Nieuwe Speler', email });
  ok('reusing a request id against a DIFFERENT academy is refused',
    !crossAcademy.ok && /IDEMPOTENCY_CONFLICT/.test(crossAcademy.message ?? ''), crossAcademy);

  // email is optional at the architectural level, and still retryable
  const reqC = await newUuid();
  const noEmail1 = await create(managerUid, { ...base, req: reqC, name: 'Zonder Email' });
  const noEmail2 = await create(managerUid, { ...base, req: reqC, name: 'Zonder Email' });
  ok('a Player with NO email is creatable', noEmail1.ok && noEmail1.value.created === true, noEmail1);
  ok('...and retrying it is idempotent, with no email to key on',
    noEmail2.ok && noEmail2.value.created === false
    && noEmail2.value.person_id === noEmail1.value.person_id, noEmail2);
  ok('...and the Player it made really has no address',
    (await one(`SELECT email FROM public.guest_players WHERE id = $1`, [noEmail1.value.guest_player_id])).email === null);

  // authorization is not possession of a uuid
  const { uid: outsiderUid } = await makeAccount(EMAIL());
  const refused = await create(outsiderUid, { ...base, req: await newUuid(), name: 'Sneaky', email: EMAIL() });
  ok('someone who does not manage the academy cannot create players there',
    !refused.ok && /PLAYER_CREATE_FORBIDDEN/.test(refused.message ?? ''), refused);

  const missingReq = await create(managerUid, { ...base, req: null, name: 'No Request Id', email: EMAIL() });
  ok('a create with no request id is refused — it could not be retried safely',
    !missingReq.ok && /REQUEST_ID_REQUIRED/.test(missingReq.message ?? ''), missingReq);

  // Every Player belongs to an academy or a trainer — `guest_players_owner_check` has said so since
  // 2026-02, and a create with no scope used to reach the INSERT and come back as an opaque check
  // violation. Refused up front now, by name.
  const noScope = await create(managerUid,
    { ownerType: 'academy', ownerId: null, req: await newUuid(), name: 'No Scope' });
  ok('a create with no owner id is refused legibly, not at the constraint',
    !noScope.ok && /BAD_SCOPE/.test(noScope.message ?? ''), noScope);
  const badScope = await create(managerUid,
    { ownerType: 'none', ownerId: academy, req: await newUuid(), name: 'Scope Mismatch' });
  ok('...and so is a scope this schema has no column for',
    !badScope.ok && /BAD_SCOPE/.test(badScope.message ?? ''), badScope);

  // selecting an existing Player needs a person this scope may speak for
  const { id: strangerAcademy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 stranger', 'u2st-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: strangerGuest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Someone Elses Player', $1, $2) RETURNING id`, [EMAIL(), strangerAcademy]);
  const strangerPerson = (await personOfGuest(strangerGuest)).person_id;

  const stolen = await create(managerUid,
    { ...base, req: await newUuid(), name: 'Whoever', selectPerson: strangerPerson });
  ok('knowing a person_id does not let a scope select it',
    !stolen.ok && /PERSON_NOT_YOURS/.test(stolen.message ?? ''), stolen);

  const mine = await create(managerUid,
    { ...base, req: await newUuid(), name: 'Whoever', selectPerson: first.value.person_id });
  ok('...but a Player the academy already has can be selected',
    mine.ok && mine.value.person_id === first.value.person_id && mine.value.created === false, mine);

  // the durable record is owner-only
  const peek = await asUser(managerUid, async () =>
    (await c.query(`SELECT count(*) FROM public.player_create_commands`)).rows);
  ok('the command record is not readable by an ordinary client', !peek.ok, peek);

  await c.query('ROLLBACK');
}

// ══ 5d-2. THE SAME RULE FOR A TRAINER, AND FOR NO SCOPE AT ALL ═════════════════════════════════
// A rule that exists for academies and not for trainers is a rule with a hole in it: the staff
// intake function accepts a trainer scope, and before this it kept its own email-and-name match for
// exactly that branch.
{
  await c.query('BEGIN');
  const { uid: trainerUid } = await makeAccount(EMAIL());
  const { id: trainer } = await one(
    `INSERT INTO public.trainer_profiles (user_id) VALUES ($1) RETURNING id`, [trainerUid]);
  // `is_trainer` reads user_roles, not trainer_profiles — the two answer different questions, and
  // the ownerless arm below asks the first one.
  await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'trainer')
                 ON CONFLICT DO NOTHING`, [trainerUid]);
  const { uid: otherTrainerUid } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.trainer_profiles (user_id) VALUES ($1)`, [otherTrainerUid]);

  const own = await create(trainerUid,
    { ownerType: 'trainer', ownerId: trainer, req: await newUuid(), name: 'Trainer Player', email: EMAIL() });
  ok('a trainer can create a Player in their own practice', own.ok && own.value.created === true, own);
  ok('...and it is stamped with that trainer, not left ownerless',
    (await one(`SELECT trainer_id FROM public.guest_players WHERE id = $1`, [own.value.guest_player_id]))
      .trainer_id === trainer);

  const foreign = await create(otherTrainerUid,
    { ownerType: 'trainer', ownerId: trainer, req: await newUuid(), name: 'Not Yours', email: EMAIL() });
  ok('another trainer cannot create Players in it',
    !foreign.ok && /PLAYER_CREATE_FORBIDDEN/.test(foreign.message ?? ''), foreign);

  // the academy back-office creating against its own trainer must still work, or the trainer scope
  // is unreachable for the role that uses it most
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 trainer scope', 'u2ts-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  await c.query(`INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
                 VALUES ($1, $2, 'active')`, [academy, trainer]);
  const { uid: mgrUid } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgrUid]).catch(() => {});
  const viaAcademy = await create(mgrUid,
    { ownerType: 'trainer', ownerId: trainer, req: await newUuid(), name: 'Academy Made', email: EMAIL() });
  ok('an academy manager can create against a trainer the academy works with', viaAcademy.ok, viaAcademy);

  // a person from the trainer's scope is selectable there; one from the academy's is not
  const crossScope = await create(trainerUid, {
    ownerType: 'trainer', ownerId: trainer, req: await newUuid(),
    name: 'Whoever', selectPerson: (await personOfGuest(
      (await one(`INSERT INTO public.guest_players (full_name, academy_profile_id)
                  VALUES ('Academy Only', $1) RETURNING id`, [academy])).id)).person_id,
  });
  ok('a person that belongs to the ACADEMY is not selectable in the TRAINER scope',
    !crossScope.ok && /PERSON_NOT_YOURS/.test(crossScope.message ?? ''), crossScope);

  // ...and an ordinary player controls no scope at all
  const { uid: playerUid } = await makeAccount(EMAIL());
  const notStaff = await create(playerUid,
    { ownerType: 'trainer', ownerId: trainer, req: await newUuid(), name: 'By A Player', email: EMAIL() });
  ok('an ordinary player cannot create Players anywhere',
    !notStaff.ok && /PLAYER_CREATE_FORBIDDEN/.test(notStaff.message ?? ''), notStaff);

  // The schema's own answer to "what about a club?": there is no column for one. The constraint
  // that says so is asserted directly, because the command's refusal is only correct while it holds.
  const ownerlessInsert = await asService(async () => (await c.query(
    `INSERT INTO public.guest_players (full_name) VALUES ('Ownerless') RETURNING id`)).rows[0]);
  ok('the schema itself refuses a Player belonging to nobody',
    !ownerlessInsert.ok && ownerlessInsert.code === '23514', ownerlessInsert);
  await c.query('ROLLBACK');
}

// ══ 5d-3. THE PUBLIC FORM'S CREATE, AND WHAT IT MAY NOT DO ═════════════════════════════════════
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 selfsignup', 'u2ss-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const base = { ownerType: 'academy', ownerId: academy, origin: 'self_signup' };

  const selfSignup = await asService(async () => (await runCreate(c,
    { ...base, req: await newUuid(), name: 'Publieke Aanmelding', email: EMAIL() })).rows[0].r);
  ok('the public endpoint can create a Player with no operator at all',
    selfSignup.ok && selfSignup.value.created === true, selfSignup);
  ok('...recorded as having none, rather than as somebody unverified',
    (await one(`SELECT actor_user_id, origin FROM public.player_create_commands
                 WHERE person_id = $1`, [selfSignup.value.person_id])).actor_user_id === null);

  const { uid: someoneUid } = await makeAccount(EMAIL());
  const impersonated = await create(someoneUid,
    { ...base, req: await newUuid(), name: 'Faked Origin', email: EMAIL() });
  ok('a signed-in client cannot declare itself a self-signup',
    !impersonated.ok && /PLAYER_CREATE_FORBIDDEN/.test(impersonated.message ?? ''), impersonated);

  const withActor = await asService(async () => (await runCreate(c,
    { ...base, req: await newUuid(), name: 'Claimed Actor', email: EMAIL(), actor: someoneUid })).rows[0].r);
  ok('a self-signup that names an operator is refused — the id could not be verified',
    !withActor.ok && /BAD_ORIGIN/.test(withActor.message ?? ''), withActor);

  const { id: someGuest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Existing One', $1) RETURNING id`, [academy]);
  const selecting = await asService(async () => (await runCreate(c, {
    ...base, req: await newUuid(), name: 'Selector',
    selectPerson: (await personOfGuest(someGuest)).person_id,
  })).rows[0].r);
  ok('a self-signup cannot select an existing Player',
    !selecting.ok && /PLAYER_CREATE_FORBIDDEN/.test(selecting.message ?? ''), selecting);
  await c.query('ROLLBACK');
}

// ══ 5d-4. TWO OPERATORS AT ONCE: TWO PLAYERS, AND A PROPOSAL ═══════════════════════════════════
// Keying on the request means two different attempts for one human legitimately make two Players.
// What must NOT happen is that they both look, both see nothing, and neither files the proposal
// that tells a human to look. Proven with real concurrency: the second create BLOCKS while the
// first holds the identity lock, and once the first commits the second sees it.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 concurrent', 'u2cc-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgrUid } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgrUid]).catch(() => {});
  await c.query('COMMIT');                       // the other sessions have to see the fixture

  const email = EMAIL();
  const sessions = [new pg.Client({ connectionString: CONN }), new pg.Client({ connectionString: CONN })];
  await Promise.all(sessions.map((s) => s.connect()));
  const asManager = async (s) => {
    await s.query(`SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: mgrUid, role: 'authenticated' })]);
    await s.query(`SET LOCAL ROLE authenticated`);
  };

  await sessions[0].query('BEGIN');
  await asManager(sessions[0]);
  const firstRow = (await runCreate(sessions[0],
    { ownerType: 'academy', ownerId: academy, req: await newUuid(), name: 'Gelijktijdig', email })).rows[0].r;

  await sessions[1].query(`SET lock_timeout = '800ms'`);
  await sessions[1].query('BEGIN');
  await asManager(sessions[1]);
  let blocked = null;
  try {
    await runCreate(sessions[1],
      { ownerType: 'academy', ownerId: academy, req: await newUuid(), name: 'Gelijktijdig', email });
  } catch (e) { blocked = e.code; }
  await sessions[1].query('ROLLBACK');
  ok('a concurrent create of the same person waits for the first to finish', blocked === '55P03', { blocked });

  await sessions[0].query('COMMIT');

  await sessions[1].query('BEGIN');
  await asManager(sessions[1]);
  const secondRow = (await runCreate(sessions[1],
    { ownerType: 'academy', ownerId: academy, req: await newUuid(), name: 'Gelijktijdig', email })).rows[0].r;
  await sessions[1].query('COMMIT');

  ok('both attempts get their OWN Player — the request id is the key, not the person',
    firstRow.person_id !== secondRow.person_id, { firstRow, secondRow });
  const proposals = await all(
    `SELECT person_id FROM public.person_merge_review
      WHERE kind = 'possible_duplicate_player' AND person_id IN ($1, $2)`,
    [firstRow.person_id, secondRow.person_id]);
  ok('...and the second one is proposed for review, so a human is told',
    proposals.length === 1 && proposals[0].person_id === secondRow.person_id, proposals);

  await Promise.all(sessions.map((s) => s.end()));
  // committed fixture: clean it up
  await c.query(`DELETE FROM public.person_merge_review WHERE guest_player_id IN ($1, $2)`,
    [firstRow.guest_player_id, secondRow.guest_player_id]);
  await c.query(`DELETE FROM public.player_create_commands WHERE person_id IN ($1, $2)`,
    [firstRow.person_id, secondRow.person_id]);
  await c.query(`DELETE FROM public.guest_players WHERE id IN ($1, $2)`,
    [firstRow.guest_player_id, secondRow.guest_player_id]);
  await c.query(`DELETE FROM public.academy_managers WHERE academy_profile_id = $1`, [academy]);
  await c.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [academy]);
  await c.query(`DELETE FROM auth.users WHERE id = $1`, [mgrUid]);
}

// ══ 5d-5. THE MECHANISM IS REACHABLE ONLY THROUGH A DOOR THAT ASKED WHO YOU ARE ════════════════
// `player_create_execute` skips the permission question, because every caller has already answered
// it. That is only safe while nobody else can call it — so the grant is the guarantee, and it is
// asserted rather than assumed.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 mechanism', 'u2mx-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const EXEC_SQL = `SELECT public.player_create_execute(
    _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
    _origin => 'operator', _actor_user_id => $3, _full_name => 'Backdoor') AS r`;

  const { uid } = await makeAccount(EMAIL());
  const asAuthenticated = await asUser(uid, async () =>
    (await one(EXEC_SQL, [await newUuid(), academy, uid])).r);
  ok('a signed-in client cannot reach the create mechanism directly',
    !asAuthenticated.ok && asAuthenticated.code === '42501', asAuthenticated);

  const asServiceRole = await asService(async () =>
    (await one(EXEC_SQL, [await newUuid(), academy, uid])).r);
  ok('...and neither can a service-key caller — the edge functions go through the command',
    !asServiceRole.ok && asServiceRole.code === '42501', asServiceRole);

  const grants = await all(
    `SELECT grantee FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'player_create_execute'
        AND grantee <> current_user`);
  ok('EXECUTE on the mechanism is granted to nobody', grants.length === 0, grants);
  await c.query('ROLLBACK');
}

// ══ 5d-6. THE ATTEMPT ID IS BOUND TO THE FLOW THAT MINTED IT ═══════════════════════════════════
// On the anonymous flows the id comes from the client, so a replay should not be usable outside
// the flow it was made in. The source is part of the fingerprint for exactly that.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 sourcebind', 'u2sb-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgr]).catch(() => {});

  const req = await newUuid();
  const email = EMAIL();
  const withSource = (src) => asUser(mgr, async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Gebonden', _email => $3, _source => $4) AS r`,
    [req, academy, email, src])).r);

  const first = await withSource('intake_form');
  ok('an attempt is recorded with the flow it was made in', first.ok && first.value.created === true, first);
  const replaySame = await withSource('intake_form');
  ok('...replaying it in the SAME flow returns the same Player',
    replaySame.ok && replaySame.value.person_id === first.value.person_id, replaySame);
  const replayElsewhere = await withSource('public_booking');
  ok('...and replaying it in a DIFFERENT flow is refused, identical payload or not',
    !replayElsewhere.ok && /IDEMPOTENCY_CONFLICT/.test(replayElsewhere.message ?? ''), replayElsewhere);
  await c.query('ROLLBACK');
}

// ══ 5d-7. A TWIN STAMP IS AN ASSERTION ABOUT A NEW PLAYER, NEVER ABOUT AN EXISTING ONE ═════════
// `mint_person_for_guest` treats `twin_of_profile_id` as the explicit assertion that authorizes
// joining a guest to an account's person (rule B1). Stamping a Player that ALREADY EXISTS is how an
// attribute-matched row becomes an authorized merge — which is what the roster bridge was doing.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 twinstamp', 'u2tw-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgr]).catch(() => {});
  const { profileId } = await makeAccount(EMAIL());
  const profilePerson = (await personOfProfile(profileId)).person_id;

  // A STRANGER first: an account this academy has no relationship with at all. The earlier version
  // of this section created exactly that and then asserted the stamp SUCCEEDED — enshrining the
  // hole. Knowing a profile uuid must not let a manager attach seats and invoices to that account.
  const strangerStamp = await asUser(mgr, async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Stranger Twin', _source => 'roster_registered_twin',
       _twin_of_profile_id => $3) AS r`,
    [await newUuid(), academy, profileId])).r);
  ok('an account this academy has no relationship with cannot be asserted',
    !strangerStamp.ok && /PERSON_NOT_YOURS/.test(strangerStamp.message ?? ''), strangerStamp);

  // ...now give the academy the relationship its own picker would have shown: a guest of this
  // academy already linked to that person.
  const { id: relatedGuest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Known Here', $1) RETURNING id`, [academy]);
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`,
    [profilePerson, relatedGuest]);

  // The roster bridge's exact shape: no address, source `roster_registered_twin`, which is the
  // arm of B1 that accepts a stamp without an email to verify it against.
  const mintReq = await newUuid();
  const minted = await asUser(mgr, async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Roster Twin', _source => 'roster_registered_twin',
       _twin_of_profile_id => $3) AS r`,
    [mintReq, academy, profileId])).r);
  ok('a NEW Player may be stamped as that account holder', minted.ok, minted);
  ok('...and B1 joins it to their person, because a brand-new row brings nothing with it',
    minted.ok && minted.value.person_id === profilePerson, { minted: minted.value, profilePerson });

  const { id: existingGuest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Already Here', $1) RETURNING id`, [academy]);
  // read the person BEFORE dropping to `authenticated`: person_links is not client-readable
  const existingPerson = (await personOfGuest(existingGuest)).person_id;
  const stampReq = await newUuid();
  const stampExisting = await asUser(mgr, async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Already Here', _select_person_id => $3, _twin_of_profile_id => $4) AS r`,
    [stampReq, academy, existingPerson, profileId])).r);
  ok('a Player that already exists cannot be stamped — there is nothing being created to assert',
    !stampExisting.ok && /BAD_SCOPE/.test(stampExisting.message ?? ''), stampExisting);

  // ...and the assertion is MATERIAL to the attempt: retrying one request id under a different
  // asserted account must be refused, not answered with the first account's Player.
  const { profileId: otherProfile } = await makeAccount(EMAIL());
  const { id: otherGuest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Also Known Here', $1) RETURNING id`, [academy]);
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`,
    [(await personOfProfile(otherProfile)).person_id, otherGuest]);
  const swapped = await asUser(mgr, async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Roster Twin', _source => 'roster_registered_twin',
       _twin_of_profile_id => $3) AS r`,
    [mintReq, academy, otherProfile])).r);
  ok('replaying an attempt under a DIFFERENT asserted account is refused',
    !swapped.ok && /IDEMPOTENCY_CONFLICT/.test(swapped.message ?? ''), swapped);

  const publicReq = await newUuid();
  const selfSignupStamp = await asService(async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Public Claimer', _origin => 'self_signup', _twin_of_profile_id => $3) AS r`,
    [publicReq, academy, profileId])).r);
  ok('and a public self-signup cannot assert who anybody is',
    !selfSignupStamp.ok && /PLAYER_CREATE_FORBIDDEN/.test(selfSignupStamp.message ?? ''), selfSignupStamp);
  await c.query('ROLLBACK');
}

// ══ 5d-8. THE REBOOK GROUP'S NEW MEMBER IS CREATED, NOT FOUND BY ADDRESS ═══════════════════════
// Anon-callable, token-authorized, and it used to return whichever guest shared the typed address
// within the owner scope — no name, LIMIT 1. Two members of one household both landed on one
// Player, and a captain who typed a neighbour's address attached the booking to the neighbour.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 rebook', 'u2rb-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: trainerUid } = await makeAccount(EMAIL());
  const { id: trainer } = await one(
    `INSERT INTO public.trainer_profiles (user_id) VALUES ($1) RETURNING id`, [trainerUid]);
  const { id: slot } = await one(
    `INSERT INTO public.availability_slots (trainer_id, academy_profile_id, start_time, end_time)
     VALUES ($1, $2, now() + interval '7 days', now() + interval '7 days 1 hour') RETURNING id`,
    [trainer, academy]);
  const token = 'tok-' + (await newUuid());
  // the captain: `slot_priority_claims_player_or_guest` requires the claim to name somebody
  const { id: captain } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Captain Rebook', $1, $2) RETURNING id`, [EMAIL(), academy]);
  await c.query(
    `INSERT INTO public.slot_priority_claims (slot_id, guest_player_id, claim_token, rebook_group_id)
     VALUES ($1, $2, $3, gen_random_uuid())`, [slot, captain, token]);

  // the address is already taken by somebody else in this academy — the row the old body returned
  const shared = EMAIL();
  const { id: household } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Ouder Van Der Berg', $1, $2) RETURNING id`, [shared, academy]);

  const addMember = (req, first, last, email) => asUser(null, async () => (await one(
    `SELECT public.create_rebook_group_guest($1, $2, $3, $4, '0612345678', $5) AS id`,
    [token, first, last, email, req])).id);

  const reqA = await newUuid();
  const child = await addMember(reqA, 'Kind', 'Van Der Berg', shared);
  ok('an anonymous captain can still add a member', child.ok && child.value !== null, child);
  ok('...and gets a NEW Player, not the household member who shares the address',
    child.ok && child.value !== household, { got: child.value, household });
  ok('...whose own details are the ones that were typed',
    (await one(`SELECT full_name FROM public.guest_players WHERE id = $1`, [child.value])).full_name
      === 'Kind Van Der Berg');
  ok('...and the household member was not overwritten',
    (await one(`SELECT full_name FROM public.guest_players WHERE id = $1`, [household])).full_name
      === 'Ouder Van Der Berg');
  // A DIFFERENT name on the shared address is not a duplicate, so nothing is proposed for the child
  // — but a member added under the SAME name as the household member is, and that is the assertion
  // worth making. (`n >= 0` was the previous version of this line, which is true of every integer.)
  const twinReq = await newUuid();
  const sameName = await addMember(twinReq, 'Ouder', 'Van Der Berg', shared);
  ok('a member added under an existing name is created, not merged into them',
    sameName.ok && sameName.value !== household, sameName);
  ok('...and proposed for a human to judge',
    (await one(`SELECT count(*)::int AS n FROM public.person_merge_review
                 WHERE kind = 'possible_duplicate_player' AND guest_player_id = $1`,
      [sameName.value])).n === 1);

  const replay = await addMember(reqA, 'Kind', 'Van Der Berg', shared);
  ok('resubmitting the group replays the same member instead of minting a second',
    replay.ok && replay.value === child.value, replay);

  // The limit bounds distinct-guest CREATION from one capability. A group at the cap that has to
  // retry must still be able to: eleven replays of ten members create nobody.
  // two members exist already (the child and the same-name one), so eight more reach the cap of ten
  const capMembers = [];
  for (let i = 0; i < 8; i++) capMembers.push({ req: await newUuid(), email: EMAIL(), name: `Lid${i}` });
  for (const [i, m] of capMembers.entries()) {
    const r = await addMember(m.req, m.name, 'Van Der Berg', m.email);
    ok(`member ${i + 3} of a full group is added`, r.ok && r.value !== null, r);
    m.id = r.value;
  }
  const overCap = await addMember(await newUuid(), 'Elfde', 'Lid', EMAIL());
  ok('a genuinely new member beyond the cap is refused',
    !overCap.ok && /rate_limit_exceeded/.test(overCap.message ?? ''), overCap);

  // ...and the SAME attempt, identical in every respect, still replays: the group whose apply
  // failed can be resubmitted, which is the whole promise of keying on the request.
  const first = capMembers[0];
  const replayAtCap = await addMember(first.req, first.name, 'Van Der Berg', first.email);
  ok('...but the group can still be RETRIED — a replay is not a new guest',
    replayAtCap.ok && replayAtCap.value === first.id, replayAtCap);

  const noReq = await asUser(null, async () => (await one(
    `SELECT public.create_rebook_group_guest($1, 'Zonder', 'Id', $2, '0612345678', NULL) AS id`,
    [token, EMAIL()])).id);
  ok('an add with no attempt id is refused — it could not be retried safely',
    !noReq.ok && /creation_request_id_required/.test(noReq.message ?? ''), noReq);

  const badToken = await asUser(null, async () => (await one(
    `SELECT public.create_rebook_group_guest('nope', 'Geen', 'Token', $1, '0612345678', $2) AS id`,
    [EMAIL(), await newUuid()])).id);
  ok('and the token is still what authorizes the add',
    !badToken.ok && /invalid_token/.test(badToken.message ?? ''), badToken);
  await c.query('ROLLBACK');
}

// ══ 5d-9. THE COMMAND IS THE ONLY DOOR, AND THE DATABASE IS WHAT SAYS SO ═══════════════════════
// Every writer going through the command is a property of the CALLERS, and callers change. These
// are properties of the SCHEMA, which is what makes the invariant survive the next feature.
//
// HOW THESE ARE ASSERTED, and why not by "try it as a manager and watch it fail". A migration-built
// local database gives `authenticated` no table privileges at all (the ACL is `Dxtm`, no `arwd`),
// so every write attempted as that role fails with a bare "permission denied" whatever the policies
// say — an earlier version of this section asserted three refusals that would have passed with the
// migration under test DELETED. Staging the grant only moves the problem to the next relation the
// policies touch. So the closure is asserted where it actually lives: in the catalogue. The one
// guard that CAN be exercised behaviourally is the twin trigger, because it keys on the JWT claim
// rather than on the database role — and it is, in both directions.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 onlydoor', 'u2od-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgr]).catch(() => {});
  const { id: existing } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Already Here', $1) RETURNING id`, [academy]);
  const { profileId } = await makeAccount(EMAIL());

  // ── the catalogue: no client may insert a Player ──
  const insertPolicies = await all(
    `SELECT polname FROM pg_policy
      WHERE polrelid = 'public.guest_players'::regclass AND polcmd = 'a'`);
  ok('no INSERT policy remains on guest_players', insertPolicies.length === 0, insertPolicies);

  const clientInsert = await all(
    `SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = 'guest_players'
        AND privilege_type = 'INSERT' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`);
  ok('...and INSERT is granted to no client role either', clientInsert.length === 0, clientInsert);

  ok('RLS is on, so a missing policy is a refusal rather than a free pass',
    (await one(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.guest_players'::regclass`)).on === true);

  const claimGrants = await all(
    `SELECT grantee FROM information_schema.role_routine_grants
      WHERE routine_schema = 'public' AND routine_name = 'claim_guest_twin_for_academy'
        AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')`);
  ok('the retired claim RPC is reachable from no client role', claimGrants.length === 0, claimGrants);

  // ── the trigger: a client may not assert who an existing Player IS ──
  // The guard keys on `current_user`, so the caller has to genuinely BE the client role — a JWT
  // claim alone would not do it, and keying on the claim is what broke the merge command, which
  // runs as its own owner while the caller's claim is still set. The table grant is staged because
  // a migration-built database gives `authenticated` none.
  // A deployed project grants `authenticated` ordinary DML; a migration-built one grants none, so
  // the privileges are staged to match. SELECT goes to every table because the UPDATE policy reads
  // several others (academy_trainers, trainer_locations, ...) and a privilege error there would
  // masquerade as the guard firing. Transactional, so it rolls back with the fixture.
  await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated`);
  await c.query(`GRANT UPDATE ON public.guest_players TO authenticated`);
  const stamp = await asUser(mgr, async () => (await c.query(
    `UPDATE public.guest_players SET twin_of_profile_id = $1 WHERE id = $2`,
    [profileId, existing])).rowCount);
  ok('a client cannot assert who an existing Player IS by editing the row',
    !stamp.ok && /guest_twin_assertion_not_yours/.test(stamp.message ?? ''), stamp);

  // ...an ordinary edit by the same client is untouched: the guard is about the assertion, not the
  // table. Without this the trigger could refuse everything and still look correct above.
  const ordinary = await asUser(mgr, async () => (await c.query(
    `UPDATE public.guest_players SET phone = '0612345678' WHERE id = $1`, [existing])).rowCount);
  ok('...while an ordinary edit still works', ordinary.ok && ordinary.value === 1, ordinary);

  // ...and the sanctioned path is unaffected: closing the client door must not close the front one.
  const throughTheDoor = await one(
    `SELECT public.player_create_execute(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _origin => 'operator', _actor_user_id => $3, _full_name => 'Front Door') AS r`,
    [await newUuid(), academy, mgr]);
  ok('the command still creates Players, which is the point of shutting the other doors',
    throughTheDoor.r.created === true && throughTheDoor.r.guest_player_id !== null, throughTheDoor.r);

  // and the mechanism's own stamp is not blocked by the guard it installed
  const stampedByCommand = await one(
    `SELECT public.player_create_execute(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _origin => 'operator', _actor_user_id => $3, _full_name => 'Front Door Twin',
       _twin_of_profile_id => $4) AS r`,
    [await newUuid(), academy, mgr, profileId]);
  ok('...including one that carries a twin assertion',
    stampedByCommand.r.guest_player_id !== null, stampedByCommand.r);
  await c.query('ROLLBACK');
}

// ══ 5d-10. THE GUARDS MUST NOT BREAK THE FLOWS THEY SIT IN ════════════════════════════════════
// Both of these are regressions the restrictive half of this change introduced, and neither was
// caught by anything: the twin guard fired inside the operator merge command, and the twin
// authorization refused a registered player the roster picker had just offered.
{
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 notbroken', 'u2nb-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgr]).catch(() => {});
  const { profileId } = await makeAccount(EMAIL());

  // A merge whose SOURCE carries a twin stamp and whose target does not: the survivor hygiene
  // carries the stamp across, which is a change to `twin_of_profile_id` made while the caller's
  // JWT says `authenticated`. Keyed on the claim, the guard rolled this whole merge back.
  const { id: source } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id, twin_of_profile_id)
     VALUES ('Stamped Source', $1, $2, $3) RETURNING id`, [EMAIL(), academy, profileId]);
  const { id: target } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Plain Target', $1, $2) RETURNING id`, [EMAIL(), academy]);

  const merged = await asUser(mgr, async () => (await one(
    `SELECT public.merge_guest_players('academy', $1, $2, $3, '{}'::jsonb) AS r`,
    [academy, source, target])).r);
  ok('an operator merge that carries a twin stamp onto the survivor still works', merged.ok, merged);
  ok('...and the stamp really did move, so the guard was not simply skipped',
    (await one(`SELECT twin_of_profile_id FROM public.guest_players WHERE id = $1`, [target]))
      .twin_of_profile_id === profileId);

  // A registered player the picker offers on the strength of a BOOKING with one of the academy's
  // trainers, and nothing else — no membership, no guest row in scope. The overview admits them;
  // the twin authorization refused them, so adding them to a roster failed on a player the operator
  // could plainly see.
  const { uid: trainerUid } = await makeAccount(EMAIL());
  const { id: trainer } = await one(
    `INSERT INTO public.trainer_profiles (user_id) VALUES ($1) RETURNING id`, [trainerUid]);
  await c.query(`INSERT INTO public.academy_trainers (academy_profile_id, trainer_profile_id, status)
                 VALUES ($1, $2, 'active')`, [academy, trainer]);
  const { id: slot } = await one(
    `INSERT INTO public.availability_slots (trainer_id, start_time, end_time)
     VALUES ($1, now() + interval '3 days', now() + interval '3 days 1 hour') RETURNING id`, [trainer]);
  const { profileId: bookerProfile, uid: bookerUid } = await makeAccount(EMAIL());
  await c.query(
    `INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1, $2, 'confirmed')`,
    [slot, bookerProfile]);
  const bookerPerson = (await personOfProfile(bookerProfile)).person_id;
  ok('the fixture really is picker-visible and nothing else',
    (await one(`SELECT count(*)::int AS n FROM public.person_links pl
                  JOIN public.guest_players g ON g.id = pl.guest_player_id
                 WHERE pl.person_id = $1 AND g.academy_profile_id = $2`, [bookerPerson, academy])).n === 0,
    { bookerUid });

  const rosterTwin = await asUser(mgr, async () => (await one(
    `SELECT public.player_create_command(
       _creation_request_id => $1, _owner_type => 'academy', _owner_id => $2,
       _full_name => 'Booked With Us', _source => 'roster_registered_twin',
       _twin_of_profile_id => $3) AS r`,
    [await newUuid(), academy, bookerProfile])).r);
  ok('a player the academy has only ever BOOKED can still be added to a roster', rosterTwin.ok, rosterTwin);
  await c.query('ROLLBACK');
}

// ══ 5d-11. THE CLUB STUDENT LIST IS KEYED ON THE PLAYER, NOT ON THEIR ADDRESS ══════════════════
// It selected `club_players` by (club, email) and returned on a hit, so two people sharing an
// address produced ONE roster row and the second registrant was never added at all.
{
  await c.query('BEGIN');
  // club_profiles has no name of its own — it hangs off a location, and each club needs its own
  const mkClub = async (label) => {
    const { id: loc } = await one(
      `INSERT INTO public.locations (name, city, slug)
       VALUES ($1, 'Amsterdam', 'u2c-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`,
      [label]);
    return (await one(
      `INSERT INTO public.club_profiles (location_id) VALUES ($1) RETURNING id`, [loc])).id;
  };
  const club = await mkClub('U2 Club');
  const otherClub = await mkClub('U2 Other Club');
  const mkReg = async (owner, type = 'club') => (await one(
    `INSERT INTO public.registrations (name, owner_type, owner_id, format, status)
     VALUES ('Najaar', $1, $2, 'registration', 'open') RETURNING id`, [type, owner])).id;
  const registration = await mkReg(club);

  // two DIFFERENT people on ONE address — the shape the old lookup collapsed
  const shared = EMAIL();
  const { uid: parentUid, profileId: parentProfile } = await makeAccount(shared);
  const { uid: childUid, profileId: childProfile } = await makeAccount(shared, { distinctAuthEmail: true });

  const add = (uid, reg, profile) => asUser(uid, async () =>
    (await one(`SELECT public.club_student_list_add($1, $2) AS id`, [reg, profile])).id);

  const first = await add(parentUid, registration, parentProfile);
  ok('a signed-in registrant is added to the club student list', first.ok && first.value !== null, first);

  const retry = await add(parentUid, registration, parentProfile);
  ok('...and retrying returns THE SAME row, not a second one',
    retry.ok && retry.value === first.value, retry);
  ok('...one row, counted', (await one(
    `SELECT count(*)::int AS n FROM public.club_players WHERE club_profile_id = $1`, [club])).n === 1);

  const sibling = await add(childUid, registration, childProfile);
  ok('a DIFFERENT Player on the same address gets their OWN row',
    sibling.ok && sibling.value !== first.value, sibling);
  ok('...so the club list has both of them', (await one(
    `SELECT count(*)::int AS n FROM public.club_players WHERE club_profile_id = $1`, [club])).n === 2);

  // authorization: a uuid names a subject, it does not grant permission
  const impersonation = await add(childUid, registration, parentProfile);
  ok('a caller cannot add somebody ELSE by knowing their profile uuid',
    !impersonation.ok && /NOT_YOUR_PLAYER/.test(impersonation.message ?? ''), impersonation);

  // the club comes from the registration, so a sign-up cannot be redirected
  const otherReg = await mkReg(otherClub);
  const redirected = await add(parentUid, otherReg, parentProfile);
  ok('registering on one club\'s form cannot write into another club... it writes into ITS club',
    redirected.ok && (await one(
      `SELECT club_profile_id FROM public.club_players WHERE id = $1`, [redirected.value]))
      .club_profile_id === otherClub, redirected);
  ok('...and the first club is untouched by it', (await one(
    `SELECT count(*)::int AS n FROM public.club_players WHERE club_profile_id = $1`, [club])).n === 2);

  const academyReg = await mkReg((await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 not a club', 'u2nc-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`)).id,
    'academy');
  const notAClub = await add(parentUid, academyReg, parentProfile);
  ok('a registration that is not a club\'s writes no club row',
    !notAClub.ok && /NOT_A_CLUB_REGISTRATION/.test(notAClub.message ?? ''), notAClub);

  const anon = await add(null, registration, parentProfile);
  ok('an unauthenticated caller is refused as unauthenticated',
    !anon.ok && /NOT_AUTHENTICATED/.test(anon.message ?? ''), anon);

  // no PII decides reuse: the SAME person under a CHANGED address still replays to their row
  await c.query(`UPDATE public.profiles SET email = $1 WHERE id = $2`, [EMAIL(), parentProfile]);
  const afterEmailChange = await add(parentUid, registration, parentProfile);
  ok('changing the address does not make them a new club student — identity is the person',
    afterEmailChange.ok && afterEmailChange.value === first.value, afterEmailChange);
  await c.query('ROLLBACK');
}

// ══ 5d-12. TWO CONCURRENT ADDS OF ONE PLAYER PRODUCE ONE ROW ═══════════════════════════════════
// There is deliberately no unique index on (club, person) — it could not be proven safe against
// production rows that all carry a NULL person_id — so the advisory lock is the whole guarantee and
// it is worth staging a real race for.
{
  await c.query('BEGIN');
  const { id: location } = await one(
    `INSERT INTO public.locations (name, city, slug)
     VALUES ('U2 Race Hal', 'Utrecht', 'u2race-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { id: club } = await one(
    `INSERT INTO public.club_profiles (location_id) VALUES ($1) RETURNING id`, [location]);
  const { id: registration } = await one(
    `INSERT INTO public.registrations (name, owner_type, owner_id, format, status)
     VALUES ('Race', 'club', $1, 'registration', 'open') RETURNING id`, [club]);
  const { uid, profileId } = await makeAccount(EMAIL());
  await c.query('COMMIT');                      // the other sessions have to see the fixture

  const sessions = [new pg.Client({ connectionString: CONN }), new pg.Client({ connectionString: CONN })];
  await Promise.all(sessions.map((s) => s.connect()));
  const asPlayer = async (s) => {
    await s.query(`SELECT set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await s.query(`SET LOCAL ROLE authenticated`);
  };

  await sessions[0].query('BEGIN'); await asPlayer(sessions[0]);
  const firstId = (await sessions[0].query(
    `SELECT public.club_student_list_add($1, $2) AS id`, [registration, profileId])).rows[0].id;

  await sessions[1].query(`SET lock_timeout = '800ms'`);
  await sessions[1].query('BEGIN'); await asPlayer(sessions[1]);
  let blocked = null;
  try {
    await sessions[1].query(`SELECT public.club_student_list_add($1, $2)`, [registration, profileId]);
  } catch (e) { blocked = e.code; }
  await sessions[1].query('ROLLBACK');
  ok('a concurrent add of the same Player waits for the first to finish', blocked === '55P03', { blocked });

  await sessions[0].query('COMMIT');
  await sessions[1].query('BEGIN'); await asPlayer(sessions[1]);
  const secondId = (await sessions[1].query(
    `SELECT public.club_student_list_add($1, $2) AS id`, [registration, profileId])).rows[0].id;
  await sessions[1].query('COMMIT');

  ok('...and once it has, the second call returns the SAME row', secondId === firstId,
    { firstId, secondId });
  ok('...so the club has exactly one row for them', (await one(
    `SELECT count(*)::int AS n FROM public.club_players WHERE club_profile_id = $1`, [club])).n === 1);

  await Promise.all(sessions.map((s) => s.end()));
  await c.query(`DELETE FROM public.club_players WHERE club_profile_id = $1`, [club]);
  await c.query(`DELETE FROM public.registrations WHERE id = $1`, [registration]);
  await c.query(`DELETE FROM public.club_profiles WHERE id = $1`, [club]);
  await c.query(`DELETE FROM public.locations WHERE id = $1`, [location]);
  await c.query(`DELETE FROM auth.users WHERE id = $1`, [uid]);
}

// ══ 5e. THE COMMAND RECORD FOLLOWS THE PLAYER IT MADE ══════════════════════════════════════════
// A guest source disappears — claimed, merged, anonymized, deleted. If the record died with it, the
// next retry of a long-finished attempt would quietly make a second Player. Where a successor
// exists the record is repointed; where the Player is genuinely gone it says so.

/** Record a finished command naming a person + guest, the way the command itself would. */
const recordCommand = async (academy, actor, person, guest) => {
  const req = await newUuid();
  await c.query(
    `INSERT INTO public.player_create_commands
       (creation_request_id, owner_type, owner_id, origin, actor_user_id,
        payload_fingerprint, person_id, guest_player_id)
     VALUES ($1, 'academy', $2, 'operator', $3, 'fixture', $4, $5)`,
    [req, academy, actor, person, guest]);
  return req;
};
const commandFor = (req) => one(
  `SELECT person_id, guest_player_id FROM public.player_create_commands WHERE creation_request_id = $1`,
  [req]);

{
  await c.query('BEGIN');
  const f = await proposedPair();
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [f.academy, mgr]).catch(() => {});

  const guestPerson = (await personOfGuest(f.guest)).person_id;
  const req = await recordCommand(f.academy, mgr, guestPerson, f.guest);

  const claimed = await asUser(f.uid, async () =>
    (await one(`SELECT public.person_claim_confirm($1) AS r`, [f.reviewId])).r);
  ok('the claim still succeeds with a command record pointing at the guest person', claimed.ok, claimed);

  const after = await commandFor(req);
  const profilePerson = (await personOfProfile(f.profileId)).person_id;
  ok('the command record was REPOINTED to the surviving person, not nulled',
    after.person_id === profilePerson, { after: after.person_id, profilePerson, guestPerson });
  ok('...and its guest column still names the guest, which the claim relinks rather than deletes',
    after.guest_player_id === f.guest, after);
  await c.query('ROLLBACK');
}

{
  // A REFUSED collapse must not move the record. The collapse declines when the guest's person has
  // another source, and the record then names a person that is still alive under its own id — so
  // repointing it would make the next retry answer with somebody else's Player.
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 refuse', 'u2rf-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Not Collapsible', $1) RETURNING id`, [academy]);
  const guestPerson = (await personOfGuest(guest)).person_id;
  // a SECOND source on the same person: exactly the shape the collapse refuses
  const { id: sibling } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Second Source', $1) RETURNING id`, [academy]);
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`,
    [guestPerson, sibling]);

  const { id: targetGuest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('The Target', $1) RETURNING id`, [academy]);
  const targetPerson = (await personOfGuest(targetGuest)).person_id;

  const req = await recordCommand(academy, mgr, guestPerson, guest);
  const refused = await one(
    `SELECT public.collapse_guest_person_into_reporting($1, $2, $3) AS r`,
    [guest, guestPerson, targetPerson]);
  ok('the collapse refuses a person that still has another source', refused.r.ok === false, refused.r);

  const after = await commandFor(req);
  ok('a REFUSED collapse leaves the command record exactly where it was',
    after.person_id === guestPerson, { after: after.person_id, guestPerson, targetPerson });
  await c.query('ROLLBACK');
}

{
  // The operator merge deletes the source guest, which lets the orphan cleanup destroy its person.
  // Both of the record's answers point at things that are about to stop existing.
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 merge', 'u2mg-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgr]).catch(() => {});
  const { id: source } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Merge Source', $1, $2) RETURNING id`, [EMAIL(), academy]);
  const { id: target } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Merge Target', $1, $2) RETURNING id`, [EMAIL(), academy]);
  const sourcePerson = (await personOfGuest(source)).person_id;
  const targetPerson = (await personOfGuest(target)).person_id;
  const req = await recordCommand(academy, mgr, sourcePerson, source);

  const merged = await asUser(mgr, async () => (await one(
    `SELECT public.merge_guest_players('academy', $1, $2, $3, '{}'::jsonb) AS r`,
    [academy, source, target])).r);
  ok('the operator merge succeeds', merged.ok, merged);

  const after = await commandFor(req);
  ok('the command record follows the merge instead of being nulled',
    after.person_id === targetPerson && after.guest_player_id === target,
    { after, targetPerson, target });
  ok('...and the source person really is gone, so this was a repoint and not a coincidence',
    (await one(`SELECT count(*)::int AS n FROM public.persons WHERE id = $1`, [sourcePerson])).n === 0);
  await c.query('ROLLBACK');
}

{
  // RETENTION. The evidence has to outlive its academy — an audit that cascades away with its
  // subject is not an audit. What the Player-shaped columns do is different and deliberate: they go
  // NULL, and a NULL is the record saying the Player it made no longer exists.
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 retention', 'u2rt-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  const { id: guest } = await one(
    `INSERT INTO public.guest_players (full_name, academy_profile_id)
     VALUES ('Doomed', $1) RETURNING id`, [academy]);
  const person = (await personOfGuest(guest)).person_id;
  const req = await recordCommand(academy, mgr, person, guest);

  await c.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [academy]);

  const after = await commandFor(req);
  ok('deleting the academy does NOT delete the command record', after !== undefined, after);
  ok('...it still names the academy it was made for', after !== undefined
    && (await one(`SELECT owner_id FROM public.player_create_commands WHERE creation_request_id = $1`,
      [req])).owner_id === academy);
  ok('...and its answer is NULL, which is how a retry learns the Player is gone',
    after?.person_id === null, after);
  await c.query('ROLLBACK');
}

{
  // The whole point of the record surviving: a retry after the Player is gone REFUSES rather than
  // quietly making a second one.
  await c.query('BEGIN');
  const { id: academy } = await one(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u2 gone', 'u2gn-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { uid: mgr } = await makeAccount(EMAIL());
  await c.query(`INSERT INTO public.academy_managers (academy_profile_id, user_id, role)
                 VALUES ($1, $2, 'manager')`, [academy, mgr]).catch(() => {});
  const req = await newUuid();
  const email = EMAIL();
  const payload = { ownerType: 'academy', ownerId: academy, req, name: 'Vanishing', email };
  const made = await create(mgr, payload);
  ok('the Player is created', made.ok && made.value.created === true, made);

  await c.query(`DELETE FROM public.guest_players WHERE id = $1`, [made.value.guest_player_id]);

  // The SAME payload, so the fingerprint agrees and the refusal under test is the one about the
  // Player being gone — not the idempotency conflict a changed payload would raise first.
  const retry = await create(mgr, payload);
  ok('retrying a command whose Player was deleted refuses as RESULT_GONE',
    !retry.ok && /RESULT_GONE/.test(retry.message ?? ''), retry);
  ok('...and no second Player was made',
    (await one(`SELECT count(*)::int AS n FROM public.guest_players WHERE academy_profile_id = $1`,
      [academy])).n === 0);
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
       -- ANY normalization of an email column, however it is spelled. The narrow version of this
       -- pattern required lower(btrim(...)) and so was blind to create_rebook_group_guest,
       -- which deduplicated on plain lower(email) — anon-callable, no name check, first row wins.
       -- A detector tuned to the writers you already know about only ever finds those, so this one
       -- is deliberately broad and is narrowed only by the identity-WRITE arm below.
       AND pg_get_functiondef(p.oid) ~* '(lower|btrim|trim|u2_norm)[^;]{0,60}email'
       -- ...and writes identity, DIRECTLY or through the shared mechanism. player_create_execute
       -- belongs in this list precisely because it is the sanctioned writer: a function that reaches
       -- it is still creating Players, and still has to be read.
       AND pg_get_functiondef(p.oid) ~* 'collapse_guest_person_into_reporting|SET player_id|linked_profile_id\\s*=\\s*_profile_id|INSERT INTO public\\.person_links|INSERT INTO public\\.guest_players|player_create_execute'
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
    ['player_create_command',
     'The scope-authorized entry point. It answers the permission question and delegates; it selects nobody.'],
    ['player_create_execute',
     'The create mechanism. It reads the address only to PROPOSE a possible_duplicate_player review row; identity comes from the caller\'s creation_request_id, and an existing Player can only be named explicitly by person_id, already authorized by the caller. Granted to nobody, so only a definer function that has answered the permission question can reach it.'],
    ['create_rebook_group_guest',
     'The rebook group\'s add-a-member, authorized by the group claim token and rate-limited per token. Since U2 it CREATES through player_create_execute on the caller\'s creation_request_id; the lookup on lower(email) that used to pick whichever guest shared the address is gone.'],
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
