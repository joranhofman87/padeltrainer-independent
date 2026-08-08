#!/usr/bin/env node
/**
 * U1c prerequisite 3 — academy deletion, against REAL local PostgreSQL.
 *
 * WHY NOT PGLITE. Two reasons, and both are load-bearing.
 *
 * 1. The catalogue-drift guard pins a fingerprint of the REAL schema. A PGlite fixture built from
 *    stubs has a different shape, so every confirmation would refuse with CATALOG_DRIFT and the
 *    suite would prove nothing about the paths underneath it.
 * 2. The lock plan's whole purpose is to make a concurrent writer WAIT. PGlite is a single
 *    connection; it cannot stage a second session, so it cannot witness blocking at all.
 *
 * So this runs against the local Supabase database — the same one `supabase db reset` manages.
 * LOCAL ONLY: the connection string is hardcoded to 127.0.0.1:54322, there is no environment
 * override, and nothing here reads a credential or touches a remote database.
 *
 * Fixtures are COMMITTED rather than rolled back, and cleaned up at the end. That is not laziness:
 * `xmin` is the transaction that last wrote the row, so a row inserted and then updated inside ONE
 * transaction keeps the same `xmin`. Testing revision-sensitivity inside a single transaction would
 * quietly prove nothing — the edit has to be a separate committed transaction, exactly as it is in
 * life. Every id created is tracked and removed in the final cleanup.
 */
import pg from 'pg';

const CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let failures = 0;
const ok = (msg, cond, extra) => {
  if (cond) console.log('PASS', msg);
  else { failures++; console.error('FAIL', msg, extra === undefined ? '' : JSON.stringify(extra)); }
};

const client = async () => { const c = new pg.Client({ connectionString: CONN }); await c.connect(); return c; };
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

/** A minimal but REAL academy: a profile, a guest with a person, and a metadata overlay row. */
const CREATED = [];
async function seedAcademy(c, { withInvoice = false, withCycle = false } = {}) {
  const { id: academy } = await one(c,
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-prereq3-fixture', 'u1c-p3-' || replace(gen_random_uuid()::text, '-', '')) RETURNING id`);
  CREATED.push(academy);
  const { id: guest } = await one(c,
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('Fixture Guest', $1) RETURNING id`,
    [academy]);
  // The shipped `mint_person_for_guest` trigger already links a person — read it rather than making
  // a second one, which would violate person_links_guest_player_id_key.
  const { person_id: person } = await one(c,
    `SELECT person_id FROM public.person_links WHERE guest_player_id = $1`, [guest]);
  const { id: meta } = await one(c,
    `INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, person_id, notes)
     VALUES ($1, $2, $3, 'fixture') RETURNING id`, [academy, guest, person]);

  if (withInvoice) {
    await c.query(
      `INSERT INTO public.invoices (academy_profile_id, invoice_number, due_date, player_name, status)
       VALUES ($1::uuid, 'U1C-P3-' || substr($1::uuid::text, 1, 8), current_date, 'Fixture', 'draft')`, [academy]);
  }
  if (withCycle) {
    await c.query(
      `INSERT INTO public.cycles (owner_type, owner_id, name, type) VALUES ('academy', $1, 'fixture', 'cyclus')`,
      [academy]);
  }
  return { academy, person, guest, meta };
}

const preview = async (c, academy) =>
  (await one(c, `SELECT public.academy_deletion_preview($1) AS p`, [academy])).p;

async function startAudit(c, academy, actor, p) {
  const { id } = await one(c,
    `INSERT INTO public.academy_deletion_audit (academy_profile_id, actor_user_id, preview_version, digest)
     VALUES ($1, $2, $3, $4) RETURNING id`, [academy, actor, p.preview_version, p.digest]);
  return id;
}

const confirm = (c, academy, p, auditId, actor) =>
  c.query(`SELECT public.academy_delete_confirmed($1, $2, $3, $4, $5) AS r`,
    [academy, p.digest, p.preview_version, auditId, actor]);

const ACTOR = '00000000-0000-4000-8000-0000000000aa';

// ══ 1. PREVIEW SHAPE ═══════════════════════════════════════════════════════════════════════════
{
  const c = await client();
  const { academy } = await seedAcademy(c);
  const p = await preview(c, academy);

  ok('preview labels deleted / detached / blockers separately',
    p.deleted !== undefined && p.detached !== undefined && Array.isArray(p.blockers), p);
  ok('availability_slots appears ONLY under detached',
    p.detached.availability_slots !== undefined && p.deleted.availability_slots === undefined);
  ok('the overlay tables are counted as deleted',
    p.deleted.academy_player_metadata === 1 && p.deleted.academy_player_locations === 0, p.deleted);
  ok('the payload carries no identities — counts, codes and a digest only',
    !JSON.stringify(p).includes('"id"') && /^[0-9a-f]{64}$/.test(p.digest));
  await c.end();
}

// ══ 2. REVISION SENSITIVITY — the point of the whole digest ════════════════════════════════════
for (const [label, mutate] of [
  ['an OVERLAY row', async (c, f) => c.query(`UPDATE public.academy_player_metadata SET notes = 'edited' WHERE id = $1`, [f.meta])],
  ['a CASCADE CHILD', async (c, f) => c.query(`UPDATE public.guest_players SET full_name = 'edited' WHERE id = $1`, [f.guest])],
  ['a BLOCKER row', async (c, f) => c.query(`UPDATE public.invoices SET status = 'sent' WHERE academy_profile_id = $1`, [f.academy])],
]) {
  const c = await client();
  const f = await seedAcademy(c, { withInvoice: label === 'a BLOCKER row' });
  const before = await preview(c, f.academy);
  await mutate(c, f);
  const after = await preview(c, f.academy);
  ok(`editing ${label} in place — same id, same count — makes the digest stale`,
    before.digest !== after.digest, { before: before.digest.slice(0, 12), after: after.digest.slice(0, 12) });
  await c.end();
}

{
  // Equal counts, different ids.
  const c = await client();
  const f = await seedAcademy(c);
  const before = await preview(c, f.academy);
  await c.query(`DELETE FROM public.academy_player_metadata WHERE id = $1`, [f.meta]);
  await c.query(
    `INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, person_id, notes)
     VALUES ($1, $2, $3, 'fixture')`, [f.academy, f.guest, f.person]);
  const after = await preview(c, f.academy);
  ok('equal counts with different ids are stale',
    before.deleted.academy_player_metadata === after.deleted.academy_player_metadata
    && before.digest !== after.digest);
  await c.end();
}

{
  // The encoding itself: composite/delimiter-containing values must not collide. This is the reason
  // the tuple is length-prefixed rather than pre-hashed or joined with a separator.
  const c = await client();
  const r = await one(c,
    `SELECT (public.u1c_ns('x:1') || public.u1c_ns('2')) AS a,
            (public.u1c_ns('x') || public.u1c_ns('1:2')) AS b,
            (public.u1c_ns('') ) AS empty, (public.u1c_ns(NULL)) AS nul`);
  ok('length-prefixed encoding distinguishes delimiter-containing composite tuples', r.a !== r.b, r);
  ok('NULL and empty string encode differently', r.empty !== r.nul, r);
  await c.end();
}

// ══ 2b. DEEP CASCADE DESCENDANTS — the rows with no academy_profile_id of their own ════════════
// `session_player_notes` cascades from `guest_players`, not from the academy, so it has no
// academy column. An earlier version skipped every such relation: those rows were destroyed by a
// confirmation that never counted them, and editing one afterwards did not make the digest stale.
{
  const c = await client();
  const f = await seedAcademy(c);
  // THE TRIGGER-DRIVEN ROOT. `notification_contacts` hangs off `persons`, and a person is destroyed
  // not by any foreign key from the academy but by the shipped guest-delete trigger when the dying
  // guest was its last link. Nothing in the FK graph rooted at academy_profiles can see this row.
  const { id: contact } = await one(c,
    `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_scope)
     VALUES ($1, 'email', 'deep@example.com', 'd***@example.com', 'global') RETURNING id`,
    [f.person]);

  const p = await preview(c, f.academy);
  ok('a cascade descendant with no academy column is COUNTED in the preview',
    p.deleted.person_links === 1, { person_links: p.deleted.person_links });
  ok('the person the guest-delete TRIGGER will destroy is counted', p.deleted.persons === 1, p.deleted.persons);
  ok('a row reachable ONLY through that dying person is counted too',
    p.deleted.notification_contacts === 1, p.deleted.notification_contacts);

  // ...and it is in the digest: editing it in place must go stale.
  await c.query(`UPDATE public.notification_contacts SET destination_redacted = 'x***@example.com' WHERE id = $1`, [contact]);
  ok('editing that trigger-reachable row makes the digest stale',
    p.digest !== (await preview(c, f.academy)).digest);

  // and it is genuinely destroyed by a successful confirmation
  const p4 = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p4);
  await confirm(c, f.academy, p4, auditId, ACTOR);
  const leftPerson = await one(c, `SELECT count(*)::int AS n FROM public.persons WHERE id = $1`, [f.person]);
  const leftContact = await one(c, `SELECT count(*)::int AS n FROM public.notification_contacts WHERE id = $1`, [contact]);
  ok('the trigger deleted the person, as previewed', leftPerson.n === 0);
  ok('the row reachable only through it is gone, and it WAS previewed', leftContact.n === 0);
  await c.end();
}

// ══ 3. BLOCKERS ════════════════════════════════════════════════════════════════════════════════
for (const [label, seed, code] of [
  ['HAS_INVOICES', { withInvoice: true }, 'HAS_INVOICES'],
  ['HAS_PROGRAMS', { withCycle: true }, 'HAS_PROGRAMS'],
]) {
  const c = await client();
  const f = await seedAcademy(c, seed);
  const p = await preview(c, f.academy);
  ok(`${label} is reported as a blocker`, p.blockers.some((b) => b.code === code), p.blockers);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok(`${label} refuses the confirmation`, refused !== null && refused.includes('BLOCKED'), { refused });

  // The transaction is poisoned after the exception; verify in a fresh one that nothing went.
  // The refusal rolled back its own transaction, so the academy — and everything under it — survives.
  const still = await one(c, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [f.academy]);
  const metaStill = await one(c, `SELECT count(*)::int AS n FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [f.academy]);
  ok(`${label}: the academy and its overlay are untouched`, still.n === 1 && metaStill.n === 1, { still, metaStill });
  await c.end();
}

{
  // SHARED_PERSON_IDENTITY — the guard that must never destroy identity belonging elsewhere.
  const c = await client();
  const f = await seedAcademy(c);
  const { id: otherAcademy } = await one(c,
    `INSERT INTO public.academy_profiles (name) VALUES ('u1c-prereq3-other') RETURNING id`);
  await c.query(
    `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1, $2)`,
    [otherAcademy, f.person]);

  const p = await preview(c, f.academy);
  ok('a person reachable from another academy blocks',
    p.blockers.some((b) => b.code === 'SHARED_PERSON_IDENTITY'), p.blockers);

  // ...and a person with another surviving link is NOT a blocker: the cascade would not destroy it.
  const f2 = await seedAcademy(c);
  // A SECOND source for the same person — a guest outside this academy. The cascade therefore does
  // not destroy the person, so this must NOT be a blocker.
  // guest_players_owner_check requires an owner; a DIFFERENT academy keeps it outside the cascade.
  const { id: outsideAcademy } = await one(c,
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-p3-outside', 'u1c-p3-out-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  CREATED.push(outsideAcademy);
  const { id: outsideGuest } = await one(c,
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('Outside Guest', $1) RETURNING id`,
    [outsideAcademy]);
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`,
    [f2.person, outsideGuest]);
  await c.query(
    `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1, $2)`,
    [otherAcademy, f2.person]);
  const p2 = await preview(c, f2.academy);
  ok('a person with another surviving link is NOT blocked (the guard is not over-broad)',
    !p2.blockers.some((b) => b.code === 'SHARED_PERSON_IDENTITY'), p2.blockers);
  await c.end();
}

// ══ 4. HAPPY PATH + AUDIT ══════════════════════════════════════════════════════════════════════
{
  const c = await client();
  const f = await seedAcademy(c);
  await c.query(`INSERT INTO public.academy_mollie_accounts (academy_profile_id, mollie_organization_id)
                 VALUES ($1, 'org_fixture')`, [f.academy]).catch(() => {});
  const p = await preview(c, f.academy);
  ok('a clean academy has no blockers', p.blockers.length === 0, p.blockers);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  const res = await confirm(c, f.academy, p, auditId, ACTOR);
  ok('confirmation succeeds', res.rows[0].r !== null);

  const gone = await one(c, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [f.academy]);
  ok('the academy is deleted', gone.n === 0);
  const meta = await one(c, `SELECT count(*)::int AS n FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [f.academy]);
  ok('the overlay no cascade reaches is deleted too (H3)', meta.n === 0);
  const mollie = await one(c, `SELECT count(*)::int AS n FROM public.academy_mollie_accounts WHERE academy_profile_id = $1`, [f.academy]);
  ok('Mollie credentials went with it — after every check, in the same transaction', mollie.n === 0);

  const audit = await one(c, `SELECT status, deleted_counts, detached_counts, finished_at FROM public.academy_deletion_audit WHERE id = $1`, [auditId]);
  ok('the audit is completed, atomically with the delete', audit.status === 'completed' && audit.finished_at !== null, audit);
  ok('the audit carries SERVER-recomputed counts', audit.deleted_counts.academy_player_metadata === 1, audit.deleted_counts);
  ok('the audit contains no PII', !JSON.stringify(audit).includes('@'));
  await c.end();
}

// ══ 5. AUDIT BINDING ═══════════════════════════════════════════════════════════════════════════
for (const [label, mutateAudit] of [
  ['a different actor', (id, c) => c.query(`UPDATE public.academy_deletion_audit SET actor_user_id = gen_random_uuid() WHERE id = $1`, [id])],
  ['a terminal status', (id, c) => c.query(`UPDATE public.academy_deletion_audit SET status='failed', finished_at=now(), failure_reason='x' WHERE id = $1`, [id])],
  ['a mismatched digest', (id, c) => c.query(`UPDATE public.academy_deletion_audit SET digest = 'deadbeef' WHERE id = $1`, [id])],
]) {
  const c = await client();
  const f = await seedAcademy(c);
  const p = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p);
  await mutateAudit(auditId, c);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok(`audit binding refuses ${label}`, refused !== null && refused.includes('AUDIT_BINDING_MISMATCH'), { refused });
  await c.end();
}

// ══ 6. STALE PREVIEW ═══════════════════════════════════════════════════════════════════════════
{
  const c = await client();
  const f = await seedAcademy(c);
  const p = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p);
  await c.query(`UPDATE public.academy_player_metadata SET notes = 'changed after preview' WHERE id = $1`, [f.meta]);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok('an edit after the preview refuses PREVIEW_STALE', refused !== null && refused.includes('PREVIEW_STALE'), { refused });
  await c.end();
}

// ══ 7. CATALOGUE DRIFT ═════════════════════════════════════════════════════════════════════════
{
  const c = await client();
  const f = await seedAcademy(c);
  const p = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p);
  // Add a CASCADE child inside the transaction: the live shape no longer matches the pinned manifest.
  await c.query(`CREATE TABLE public.u1c_drift_probe (
                   id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                   academy_profile_id uuid REFERENCES public.academy_profiles(id) ON DELETE CASCADE)`);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok('a new CASCADE relation refuses ACADEMY_DELETION_CATALOG_DRIFT',
    refused !== null && refused.includes('ACADEMY_DELETION_CATALOG_DRIFT'), { refused });

  // Drop it immediately: this probe is real DDL, and leaving it behind would make the pinned
  // fingerprint mismatch for every later run — the guard would fire forever on a phantom.
  await c.query(`DROP TABLE public.u1c_drift_probe`);
  ok('the drift probe is removed, so the fingerprint matches again',
    (await one(c, `SELECT public.academy_deletion_catalog_fingerprint() = public.academy_deletion_expected_fingerprint() AS m`)).m === true);
  await c.end();
}

// ══ 8. TWO-SESSION CONCURRENCY — the proof PGlite cannot give ══════════════════════════════════
{
  // Session A runs the REAL `academy_delete_confirmed` and is held after its locks are acquired by a
  // test-local trigger that waits on an advisory lock session C holds. No sleeps: B's writes are
  // proven blocked by `lock_timeout` raising 55P03, which is deterministic.
  const setup = await client();
  const { rows: [{ id: academy }] } = await setup.query(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-p3-concurrency', 'u1c-p3-cc-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { rows: [{ id: ccGuest }] } = await setup.query(
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('CC Guest', $1) RETURNING id`, [academy]);
  await setup.query(
    `INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
     VALUES ($1, $2, 'hold')`, [academy, ccGuest]);
  await setup.query(`
    CREATE FUNCTION pg_temp_hold() RETURNS trigger LANGUAGE plpgsql AS
      $fn$ BEGIN PERFORM pg_advisory_xact_lock(919191); RETURN OLD; END $fn$;
    CREATE TRIGGER u1c_p3_hold BEFORE DELETE ON public.academy_player_metadata
      FOR EACH ROW EXECUTE FUNCTION pg_temp_hold();`);

  const holder = await client();
  await holder.query(`SELECT pg_advisory_lock(919191)`);   // makes A wait inside its own transaction

  const p = await preview(setup, academy);
  const { rows: [{ id: auditId }] } = await setup.query(
    `INSERT INTO public.academy_deletion_audit (academy_profile_id, actor_user_id, preview_version, digest)
     VALUES ($1, $2, $3, $4) RETURNING id`, [academy, ACTOR, p.preview_version, p.digest]);

  const a = await client();
  const aRun = a.query('BEGIN')
    .then(() => a.query(`SELECT public.academy_delete_confirmed($1,$2,$3,$4,$5)`,
      [academy, p.digest, p.preview_version, auditId, ACTOR]))
    .then(() => a.query('COMMIT').then(() => 'committed'))
    .catch((e) => { a.query('ROLLBACK').catch(() => {}); return `failed: ${e.message}`; });

  // Give A time to reach the trigger and be parked there, holding its locks.
  await new Promise((r) => setTimeout(r, 800));

  const b = await client();
  await b.query(`SET lock_timeout = '600ms'`);
  let overlayErr = null, identityErr = null;
  try {
    await b.query(`INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
                   VALUES ($1, $2, 'racer')`, [academy, ccGuest]);
  } catch (e) { overlayErr = e.code; }
  try {
    await b.query(`INSERT INTO public.persons DEFAULT VALUES`);
  } catch (e) { identityErr = e.code; }

  ok('a concurrent OVERLAY write blocks while the deletion holds its locks (55P03)', overlayErr === '55P03', { overlayErr });
  ok('a concurrent IDENTITY write blocks too (55P03)', identityErr === '55P03', { identityErr });

  await holder.query(`SELECT pg_advisory_unlock(919191)`);
  const aResult = await aRun;
  ok('the held deletion then resolves', typeof aResult === 'string', { aResult });

  // After A resolves, a retried writer proceeds and observes the committed result.
  await b.query(`SET lock_timeout = '5s'`);
  const after = await one(b, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [academy]);
  ok('a retried writer sees the committed outcome, not a half-state',
    (aResult === 'committed' && after.n === 0) || (aResult !== 'committed' && after.n === 1),
    { aResult, remaining: after.n });

  // No unpreviewed row can have committed INTO the window: B's overlay insert never landed.
  const leaked = await one(b, `SELECT count(*)::int AS n FROM public.academy_player_metadata WHERE academy_profile_id = $1 AND notes = 'racer'`, [academy]);
  ok('no unpreviewed row committed into the deletion window', leaked.n === 0, leaked);

  // cleanup — the fixture academy is committed, so remove whatever survived
  await b.query(`DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [academy]);
  await b.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [academy]).catch(() => {});
  await b.query(`DELETE FROM public.academy_deletion_audit WHERE academy_profile_id = $1`, [academy]);
  await setup.query(`DROP TRIGGER IF EXISTS u1c_p3_hold ON public.academy_player_metadata`);
  await setup.query(`DROP FUNCTION IF EXISTS pg_temp_hold()`);
  await Promise.all([a.end(), b.end(), holder.end(), setup.end()]);
}

// ══ cleanup — every fixture this script committed ══════════════════════════════════════════════
{
  const c = await client();
  for (const academy of CREATED) {
    await c.query(`DELETE FROM public.academy_deletion_audit WHERE academy_profile_id = $1`, [academy]);
    await c.query(`DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [academy]);
    await c.query(`DELETE FROM public.academy_player_locations WHERE academy_profile_id = $1`, [academy]);
    await c.query(`DELETE FROM public.invoices WHERE academy_profile_id = $1`, [academy]);
    await c.query(`DELETE FROM public.cycles WHERE owner_type='academy' AND owner_id = $1`, [academy]);
    await c.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [academy]).catch(() => {});
  }
  await c.end();
}

// ══ 9. LOCK ORDERING — locks BEFORE the authoritative recomputation ════════════════════════════
// The blocking test above passes under either ordering, because by the time A reaches the overlay
// DELETE it holds its locks either way. THIS is the scenario that discriminates:
//
//   B opens an UNCOMMITTED overlay insert, then A runs the confirmation.
//     locks first  → A blocks BEFORE recomputing; B commits; A then recomputes, SEES the new row,
//                    and refuses PREVIEW_STALE.
//     locks after  → A recomputes while B's row is still invisible, matches the digest, and goes on
//                    to delete a row it never previewed.
{
  const setup = await client();
  const { rows: [{ id: academy }] } = await setup.query(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-p3-ordering', 'u1c-p3-ord-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { rows: [{ id: g }] } = await setup.query(
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('Ord Guest', $1) RETURNING id`, [academy]);
  const p = await preview(setup, academy);
  const { rows: [{ id: auditId }] } = await setup.query(
    `INSERT INTO public.academy_deletion_audit (academy_profile_id, actor_user_id, preview_version, digest)
     VALUES ($1, $2, $3, $4) RETURNING id`, [academy, ACTOR, p.preview_version, p.digest]);

  const b = await client();
  await b.query('BEGIN');
  await b.query(`INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
                 VALUES ($1, $2, 'unpreviewed')`, [academy, g]);   // held UNCOMMITTED

  const a = await client();
  const { pg_backend_pid: aPid } = await one(a, `SELECT pg_backend_pid()`);
  const aRun = a.query('BEGIN')
    .then(() => a.query(`SELECT public.academy_delete_confirmed($1,$2,$3,$4,$5)`,
      [academy, p.digest, p.preview_version, auditId, ACTOR]))
    .then(() => a.query('COMMIT').then(() => 'committed'))
    .catch((e) => { a.query('ROLLBACK').catch(() => {}); return `refused: ${e.message}`; });

  // Wait until A is DEMONSTRABLY blocked acquiring the overlay lock — not a sleep. A fixed delay
  // could let A sail past the lock plan before B commits, and then a locks-after-recompute mutant
  // would also see B's row and produce PREVIEW_STALE: a false pass on the very property under test.
  const waiter = await client();
  let blocked = false;
  for (let i = 0; i < 100 && !blocked; i++) {
    // filtered to A's own backend: any ungranted lock would otherwise satisfy this, including one
    // belonging to an unrelated session, which would prove nothing about A at all.
    const r = await one(waiter, `
      SELECT count(*)::int AS n FROM pg_locks l
       WHERE l.locktype = 'relation' AND NOT l.granted
         AND l.mode = 'ShareRowExclusiveLock'
         AND l.pid = $1
         AND l.relation = 'public.academy_player_metadata'::regclass`, [aPid]);
    blocked = r.n > 0;
    if (!blocked) await new Promise((r2) => setTimeout(r2, 50));
  }
  ok('session A is provably WAITING on the overlay lock before the recomputation', blocked);
  await waiter.end();

  await b.query('COMMIT');                         // now B's row becomes visible
  const aResult = await aRun;

  ok('a row committed during the lock wait is SEEN by the recomputation (locks precede it)',
    String(aResult).includes('PREVIEW_STALE'), { aResult });
  const survived = await one(b, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [academy]);
  ok('...and the academy therefore survives, unpreviewed row intact', survived.n === 1, survived);

  await b.query(`DELETE FROM public.academy_deletion_audit WHERE academy_profile_id = $1`, [academy]);
  await b.query(`DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [academy]);
  await b.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [academy]).catch(() => {});
  await Promise.all([a.end(), b.end(), setup.end()]);
}

if (failures > 0) {
  console.error(`\n❌ academy-deletion integration FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ academy-deletion integration passed');
