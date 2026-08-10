#!/usr/bin/env node
/**
 * U2 — anonymous returning-Player identity continuity, against REAL local PostgreSQL.
 *
 * What is under test is a set of SECURITY-DEFINER RPCs and their triggers/indexes: a first-time
 * contact creates nobody-yet and proceeds; a PII collision refuses to reveal or select anyone and
 * mints ONE challenge; control of the address (proven by the edge token, simulated here by calling
 * the post-verification RPCs) unlocks a minimal candidate list; an explicit person-keyed choice is
 * single-use and drift-checked. The HMAC token itself is the edge module's concern and is proven in
 * supabase/functions/_shared/identity-verify-token.test.ts.
 *
 * LOCAL ONLY: connection string hardcoded to 127.0.0.1:54322, no env override, no remote access.
 * Fixtures run in a transaction and roll back, except where a committed fixture is called out.
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
const newUuid = async () => (await one(`SELECT gen_random_uuid() AS id`)).id;
const EMAIL = () => `u2iv-${Math.abs(Date.now() % 1e9)}-${Math.floor(process.hrtime()[1] % 1e6)}@example.com`;

/** Run fn with an authenticated (non-service) role — to prove the grant boundary. */
const asUser = async (uid, fn) => {
  await c.query('SAVEPOINT au');
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await c.query(`SET LOCAL ROLE authenticated`);
  try { const r = await fn(); await c.query(`RESET ROLE`); await c.query(`SELECT set_config('request.jwt.claims', NULL, true)`); return { ok: true, value: r }; }
  catch (e) { await c.query('ROLLBACK TO SAVEPOINT au'); await c.query(`RESET ROLE`); return { ok: false, code: e.code, message: e.message }; }
};

const personOfProfile = (p) => one(`SELECT person_id FROM public.person_links WHERE profile_id = $1`, [p]);
const mkAcademy = async (label) => (await one(
  `INSERT INTO public.academy_profiles (name, slug)
   VALUES ($1, 'u2iv-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`, [label])).id;
const mkGuest = async (academy, email, name = 'Guest') => {
  const { id } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ($1, $2, $3) RETURNING id`, [name, email, academy]);
  return { guest: id, person: (await one(`SELECT person_id FROM public.person_links WHERE guest_player_id = $1`, [id])).person_id };
};
const resolve = (req, academy, workflow, email, authed = null) =>
  one(`SELECT public.identity_resolve_or_challenge($1,'academy',$2,$3,$4,$5) AS r`, [req, academy, workflow, email, authed]);
const outboxFor = (challengeId) => all(
  `SELECT recipient_person_id, payload, event_type FROM public.notification_outbox
    WHERE idempotency_key LIKE '%identity_verify:' || $1 || '%'`, [challengeId]);

// ══ 1. FIRST-TIME CONTACT: no candidate, proceed_new, nothing minted ══════════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('first-time');
  const req = await newUuid();
  const r = (await resolve(req, academy, 'slot', EMAIL())).r;
  ok('a first-time address proceeds as new', r.status === 'proceed_new', r);
  ok('...and mints no challenge', (await one(
    `SELECT count(*)::int AS n FROM public.identity_verification_challenges WHERE creation_request_id = $1`, [req])).n === 0);
  await c.query('ROLLBACK');
}

// ══ 2. CANDIDATE COLLISION: verify_required, NO leak, one challenge, one enqueue ═══════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('collision');
  const email = EMAIL();
  const { person } = await mkGuest(academy, email, 'Returning Rachel');
  const req = await newUuid();
  const r = (await resolve(req, academy, 'slot', email)).r;
  ok('an existing candidate forces verification', r.status === 'verify_required', r);
  ok('...and the response leaks NO candidate id/name/count/existence detail',
    !('person_id' in r) && !('candidates' in r) && !('name' in r) && !('count' in r)
    && Object.keys(r).sort().join(',') === 'challenge_id,expires_at,key_version,status', Object.keys(r));
  ok('...exactly one challenge exists for the attempt', (await one(
    `SELECT count(*)::int AS n FROM public.identity_verification_challenges WHERE creation_request_id = $1`, [req])).n === 1);
  const box = await outboxFor(r.challenge_id);
  ok('...one verification message enqueued, to the on-file candidate, token-free',
    box.length >= 1 && box[0].recipient_person_id === person
    && box[0].payload.challenge_id === r.challenge_id
    && !('token' in box[0].payload) && !JSON.stringify(box[0].payload).toLowerCase().includes('hmac'), box);

  // retry the SAME attempt: idempotent — same challenge, still one message
  const r2 = (await resolve(req, academy, 'slot', email)).r;
  ok('a resubmission returns the SAME challenge', r2.challenge_id === r.challenge_id, r2);
  ok('...and enqueues no second message', (await one(
    `SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE idempotency_key LIKE '%identity_verify:' || $1 || '%'`, [r.challenge_id])).n === box.length);

  // NOTHING was created: no player, no booking, no invoice keyed to this attempt
  ok('...and no Player was created for the attempt', (await one(
    `SELECT count(*)::int AS n FROM public.player_create_commands WHERE creation_request_id = $1`, [req])).n === 0);
  await c.query('ROLLBACK');
}

// ══ 3. VERIFY → LIST → SELECT A CANDIDATE → resolver now proceeds with that person ════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('select-one');
  const email = EMAIL();
  const { person } = await mkGuest(academy, email, 'Pick Me');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;

  const beforeVerify = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, person])).r;
  ok('selecting before verification is refused', beforeVerify.status === 'not_verified', beforeVerify);

  const list = (await one(`SELECT public.identity_verification_list($1) AS r`, [ch])).r;
  ok('listing after (simulated) token verification returns the candidate',
    list.status === 'ok' && list.candidates.length === 1 && list.candidates[0].person_id === person, list);
  ok('...and marks the challenge verified', (await one(
    `SELECT verified_at IS NOT NULL AS v FROM public.identity_verification_challenges WHERE id = $1`, [ch])).v);

  const sel = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, person])).r;
  ok('selecting the candidate succeeds and returns the CANONICAL person', sel.status === 'ok' && sel.person_id === person, sel);

  const resumed = (await resolve(req, academy, 'slot', email)).r;
  ok('the resumed booking now proceeds with that exact person, no re-challenge',
    resumed.status === 'proceed_person' && resumed.person_id === person, resumed);
  await c.query('ROLLBACK');
}

// ══ 4. SHARED FAMILY EMAIL: multiple candidates, explicit choice still required ════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('shared-email');
  const email = EMAIL();
  const parent = await mkGuest(academy, email, 'Parent Jansen');
  const child = await mkGuest(academy, email, 'Child Jansen');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;
  const list = (await one(`SELECT public.identity_verification_list($1) AS r`, [ch])).r;
  ok('a shared address lists BOTH household members — nobody is guessed',
    list.status === 'ok' && list.candidates.length === 2
    && new Set(list.candidates.map((x) => x.person_id)).size === 2
    && [parent.person, child.person].every((p) => list.candidates.some((x) => x.person_id === p)), list);
  // selecting the child binds the child, not the parent
  const sel = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, child.person])).r;
  ok('choosing one member binds exactly that person', sel.status === 'ok' && sel.person_id === child.person, sel);
  const resumed = (await resolve(req, academy, 'slot', email)).r;
  ok('...and the booking proceeds as the chosen member', resumed.person_id === child.person, resumed);
  await c.query('ROLLBACK');
}

// ══ 5. "SOMEONE NEW" creates a distinct Player intentionally ═══════════════════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('someone-new');
  const email = EMAIL();
  const { person } = await mkGuest(academy, email, 'Namesake');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;
  await one(`SELECT public.identity_verification_list($1) AS r`, [ch]);
  const sel = (await one(`SELECT public.identity_verification_select($1,NULL,true) AS r`, [ch])).r;
  ok('choosing "someone new" is accepted', sel.status === 'ok' && sel.someone_new === true, sel);
  const resumed = (await resolve(req, academy, 'slot', email)).r;
  ok('...and the resumed booking proceeds as NEW, not as the namesake', resumed.status === 'proceed_new', resumed);
  ok('...the namesake was never selected', resumed.person_id === undefined && person !== undefined);
  await c.query('ROLLBACK');
}

// ══ 6. SINGLE-USE + REPLAY semantics ══════════════════════════════════════════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('single-use');
  const email = EMAIL();
  const a = await mkGuest(academy, email, 'Alpha');
  const b = await mkGuest(academy, email, 'Beta');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;
  await one(`SELECT public.identity_verification_list($1) AS r`, [ch]);
  const first = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, a.person])).r;
  ok('the first selection succeeds', first.status === 'ok' && first.person_id === a.person, first);
  const replay = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, a.person])).r;
  ok('replaying the SAME choice returns the same result, no second mutation',
    replay.status === 'ok' && replay.person_id === a.person, replay);
  const switched = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, b.person])).r;
  ok('a DIFFERENT choice after the terminal one is refused', switched.status === 'already_selected', switched);
  await c.query('ROLLBACK');
}

// ══ 7. CROSS-OWNER / NOT-A-CANDIDATE selection is refused ══════════════════════════════════════
{
  await c.query('BEGIN');
  const academyA = await mkAcademy('owner-A');
  const academyB = await mkAcademy('owner-B');
  const email = EMAIL();
  const mine = await mkGuest(academyA, email, 'Mine');
  const foreign = await mkGuest(academyB, email, 'Foreign');   // same address, other tenant
  const req = await newUuid();
  const ch = (await resolve(req, academyA, 'slot', email)).r.challenge_id;
  const list = (await one(`SELECT public.identity_verification_list($1) AS r`, [ch])).r;
  ok('the candidate list is scoped to the owner — the other tenant\'s person is absent',
    list.candidates.length === 1 && list.candidates[0].person_id === mine.person, list);
  await one(`SELECT public.identity_verification_list($1) AS r`, [ch]);
  const cross = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, foreign.person])).r;
  ok('selecting a person outside the owner scope is refused', cross.status === 'not_a_candidate', cross);
  await c.query('ROLLBACK');
}

// ══ 8. CANDIDATE-SET DRIFT fails closed ════════════════════════════════════════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('drift');
  const email = EMAIL();
  await mkGuest(academy, email, 'Original');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;
  await one(`SELECT public.identity_verification_list($1) AS r`, [ch]);   // verify at set size 1
  // a second household member appears AFTER the challenge was minted
  await mkGuest(academy, email, 'Newcomer');
  const list = (await one(`SELECT public.identity_verification_list($1) AS r`, [ch])).r;
  ok('a candidate appearing after mint makes the list STALE (re-verify required)', list.status === 'stale', list);
  const person = (await one(
    `SELECT person_id FROM public.person_links pl JOIN public.guest_players g ON g.id = pl.guest_player_id
      WHERE g.email = $1 ORDER BY pl.person_id LIMIT 1`, [email])).person_id;
  const sel = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, person])).r;
  ok('...and selection fails closed too', sel.status === 'stale', sel);
  await c.query('ROLLBACK');
}

// ══ 9. EXPIRY: an expired challenge is invalid to list or select ═══════════════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('expiry');
  const email = EMAIL();
  const { person } = await mkGuest(academy, email, 'Timed Out');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;
  // expires_at is immutable through the guard (a signed link's expiry must not be extendable), so
  // simulate the passage of time by bypassing the trigger for this fixture manipulation only.
  await c.query(`ALTER TABLE public.identity_verification_challenges DISABLE TRIGGER trg_identity_challenge_guard_immutable`);
  await c.query(`UPDATE public.identity_verification_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [ch]);
  await c.query(`ALTER TABLE public.identity_verification_challenges ENABLE TRIGGER trg_identity_challenge_guard_immutable`);
  const list = (await one(`SELECT public.identity_verification_list($1) AS r`, [ch])).r;
  ok('an expired challenge lists as invalid (uniform, no detail)', list.status === 'invalid', list);
  const sel = (await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, person])).r;
  ok('...and selects as invalid', sel.status === 'invalid', sel);
  // a fresh submission after expiry mints a NEW challenge (the expired one is cleared)
  const r2 = (await resolve(req, academy, 'slot', email)).r;
  ok('a resubmission after expiry mints a fresh challenge', r2.status === 'verify_required' && r2.challenge_id !== ch, r2);
  await c.query('ROLLBACK');
}

// ══ 10. AUTHENTICATED person bypass — only when the owner may act on them ══════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('authed');
  const email = EMAIL();
  const { person } = await mkGuest(academy, email, 'Logged In');
  const req = await newUuid();
  const r = (await resolve(req, academy, 'slot', email, person)).r;
  ok('an authenticated person the owner may act on bypasses the challenge', r.status === 'proceed_person' && r.person_id === person, r);
  ok('...and no challenge was minted for them', (await one(
    `SELECT count(*)::int AS n FROM public.identity_verification_challenges WHERE creation_request_id = $1`, [req])).n === 0);

  // a person from ANOTHER tenant passed as authed is NOT trusted here — it falls through to PII
  const other = await mkAcademy('authed-other');
  const foreignPerson = (await mkGuest(other, EMAIL(), 'Foreign')).person;
  const req2 = await newUuid();
  const r2 = (await resolve(req2, academy, 'slot', email, foreignPerson)).r;
  ok('a foreign authed person is NOT trusted — it still verifies against PII', r2.status === 'verify_required', r2);
  await c.query('ROLLBACK');
}

// ══ 11. GRANT BOUNDARY: ordinary authenticated clients cannot call the RPCs ════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('grants');
  const { uid } = await (async () => {
    const authEmail = `auth-${await newUuid()}@example.com`;
    const u = await one(
      `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
       VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '', now(), now()) RETURNING id`, [authEmail]);
    return { uid: u.id };
  })();
  const req = await newUuid();
  const resolveDenied = await asUser(uid, async () =>
    one(`SELECT public.identity_resolve_or_challenge($1,'academy',$2,'slot',$3) AS r`, [req, academy, EMAIL()]));
  ok('authenticated cannot call the resolver', !resolveDenied.ok && resolveDenied.code === '42501', resolveDenied);
  const listDenied = await asUser(uid, async () =>
    one(`SELECT public.identity_verification_list($1) AS r`, [await newUuid()]));
  ok('authenticated cannot call list', !listDenied.ok && listDenied.code === '42501', listDenied);
  const selectDenied = await asUser(uid, async () =>
    one(`SELECT public.identity_verification_select($1,NULL,true) AS r`, [await newUuid()]));
  ok('authenticated cannot call select', !selectDenied.ok && selectDenied.code === '42501', selectDenied);
  const candDenied = await asUser(uid, async () =>
    one(`SELECT * FROM public.identity_candidate_persons('academy',$1,'x@y.com')`, [academy]));
  ok('authenticated cannot call the candidate helper', !candDenied.ok && candDenied.code === '42501', candDenied);
  await c.query('ROLLBACK');
}

// ══ 12. KEY-STATE floor is monotonic ═══════════════════════════════════════════════════════════
{
  await c.query('BEGIN');
  let lowered = null;
  try { await c.query(`UPDATE public.identity_verify_key_state SET min_mintable_version = 0 WHERE id = true`); }
  catch (e) { lowered = e.message; }
  ok('min_mintable_version cannot be lowered below 1 (CHECK)', lowered !== null, { lowered });
  await c.query('ROLLBACK');

  await c.query('BEGIN');
  await c.query(`UPDATE public.identity_verify_key_state SET current_version = 2, min_mintable_version = 2 WHERE id = true`);
  let back = null;
  try { await c.query(`UPDATE public.identity_verify_key_state SET min_mintable_version = 1 WHERE id = true`); }
  catch (e) { back = e.message; }
  ok('...and cannot be lowered from a raised floor (guard trigger)', back !== null && /monotonic/.test(back), { back });
  let del = null;
  try { await c.query(`DELETE FROM public.identity_verify_key_state WHERE id = true`); }
  catch (e) { del = e.message; }
  ok('...and the single row cannot be deleted', del !== null, { del });
  await c.query('ROLLBACK');
}

// ══ 13. RESUME with a DIFFERENT address is refused (Codex r1 f2) ═══════════════════════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('resume-bind');
  const email = EMAIL();
  const { person } = await mkGuest(academy, email, 'Bound Betty');
  const req = await newUuid();
  const ch = (await resolve(req, academy, 'slot', email)).r.challenge_id;
  await one(`SELECT public.identity_verification_list($1) AS r`, [ch]);
  await one(`SELECT public.identity_verification_select($1,$2,false) AS r`, [ch, person]);
  // legitimate resume with the SAME address → proceed_person
  const good = (await resolve(req, academy, 'slot', email)).r;
  ok('a resume with the same address proceeds as the chosen person', good.status === 'proceed_person', good);
  // resume with a DIFFERENT address under the same creation_request_id → refused
  let mismatch = null;
  try { await resolve(req, academy, 'slot', EMAIL()); } catch (e) { mismatch = e.message; }
  ok('a resume with a DIFFERENT address is refused (selection is bound to the verified address)',
    mismatch !== null && /SELECTION_SCOPE_MISMATCH/.test(mismatch), { mismatch });
  await c.query('ROLLBACK');
}

// ══ 14. A CLAIMED person with an in-scope guest is still a candidate (Codex r1 f6) ═════════════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('claimed-candidate');
  const email = EMAIL();
  const { guest, person } = await mkGuest(academy, email, 'Claimed Chris');
  // give this person an account too (a profile link) — they claimed at some point
  const authEmail = `auth-${await newUuid()}@example.com`;
  const { id: uid } = await one(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '', now(), now()) RETURNING id`, [authEmail]);
  const { id: profileId } = await one(`SELECT id FROM public.profiles WHERE user_id = $1`, [uid]);
  // the signup trigger already minted a person for the profile; simulate a completed claim by
  // repointing the profile's link onto the guest's person and dropping the now-orphan person, so one
  // canonical person carries BOTH the guest and the account.
  const profilePerson = (await personOfProfile(profileId)).person_id;
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE profile_id = $2`, [person, profileId]);
  await c.query(`DELETE FROM public.persons WHERE id = $1`, [profilePerson]);

  const req = await newUuid();
  const r = (await resolve(req, academy, 'slot', email)).r;
  ok('a returning player who later CLAIMED an account is still a candidate, not a duplicate',
    r.status === 'verify_required', r);
  const list = (await one(`SELECT public.identity_verification_list($1) AS r`, [r.challenge_id])).r;
  ok('...and they are the disclosed candidate', list.status === 'ok'
    && list.candidates.some((x) => x.person_id === person), list);
  // the derived legacy source for this owner is still the guest (so the booking is guest-keyed)
  const src = await one(`SELECT * FROM public.person_legacy_source($1, 'academy', $2)`, [person, academy]);
  ok('...and person_legacy_source yields their in-scope guest', src.guest_player_id === guest, src);
  await c.query('ROLLBACK');
}

// ══ 15. Candidate scope is tied to the MATCHING guest, not a side relationship (Codex r1 f3b) ══
{
  await c.query('BEGIN');
  const academyA = await mkAcademy('scope-A');
  const academyB = await mkAcademy('scope-B');
  const email = EMAIL();
  // one person: an in-scope guest for A with a DIFFERENT address, and the email-matching guest in B
  const aGuest = await mkGuest(academyA, EMAIL(), 'In A, other address');
  const person = aGuest.person;
  const { guest: bGuest } = await one(
    `INSERT INTO public.guest_players (full_name, email, academy_profile_id)
     VALUES ('Matches in B', $1, $2) RETURNING id AS guest`, [email, academyB]).then((row) => ({ guest: row.guest }));
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`, [person, bGuest]);
  // person is selectable by A (via aGuest) and has a B-guest matching the email. It must NOT be an
  // A-candidate for `email`: the matching guest belongs to B, not A.
  const req = await newUuid();
  const r = (await resolve(req, academyA, 'slot', email)).r;
  ok('a person whose EMAIL-matching guest is another owner\'s is NOT a candidate here',
    r.status === 'proceed_new', r);
  await c.query('ROLLBACK');
}

// ══ 16. Drift re-mints a fresh challenge rather than reusing the stale one (Codex r1 f10) ══════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('drift-remint');
  const email = EMAIL();
  await mkGuest(academy, email, 'First');
  const req = await newUuid();
  const first = (await resolve(req, academy, 'slot', email)).r;
  await mkGuest(academy, email, 'Second');   // the set drifts
  const second = (await resolve(req, academy, 'slot', email)).r;
  ok('a drifted set re-mints a NEW challenge for the same attempt (not stuck till expiry)',
    second.status === 'verify_required' && second.challenge_id !== first.challenge_id, { first, second });
  ok('...and the stale challenge is gone', (await one(
    `SELECT count(*)::int AS n FROM public.identity_verification_challenges WHERE id = $1`, [first.challenge_id])).n === 0);
  await c.query('ROLLBACK');
}

// ══ 17. Per-address hourly email cap (Codex r1 f5) — rotating request ids can't spam emails ════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('email-cap');
  const email = EMAIL();
  await mkGuest(academy, email, 'Popular');
  // 8 attempts with DIFFERENT request ids all target the same on-file address
  for (let i = 0; i < 8; i++) await resolve(await newUuid(), academy, 'slot', email);
  const outboxCount = (await one(
    `SELECT count(*)::int AS n FROM public.notification_outbox
      WHERE event_type = 'identity_verification_requested'
        AND destination_normalized = $1`, [email])).n;
  ok('rotating request ids cannot exceed the per-address hourly email cap', outboxCount <= 6, { outboxCount });
  await c.query('ROLLBACK');
}

// ══ 18. The edge key_version RPC returns the challenge generation, service-role only (f1) ══════
{
  await c.query('BEGIN');
  const academy = await mkAcademy('keyver');
  const email = EMAIL();
  await mkGuest(academy, email, 'KV');
  const ch = (await resolve(await newUuid(), academy, 'slot', email)).r.challenge_id;
  const kv = (await one(`SELECT public.identity_challenge_key_version($1) AS v`, [ch])).v;
  ok('identity_challenge_key_version returns the stored generation', kv === 1, { kv });
  const { uid } = await (async () => {
    const u = await one(
      `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
       VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, '', now(), now()) RETURNING id`,
      [`auth-${await newUuid()}@example.com`]);
    return { uid: u.id };
  })();
  const denied = await asUser(uid, async () => one(`SELECT public.identity_challenge_key_version($1) AS v`, [ch]));
  ok('...and an authenticated client cannot call it', !denied.ok && denied.code === '42501', denied);
  await c.query('ROLLBACK');
}

await c.end();
if (failures > 0) { console.error(`\n❌ u2 identity-verification FAILED (${failures})`); process.exit(1); }
console.log('\n✅ u2 identity-verification passed');
