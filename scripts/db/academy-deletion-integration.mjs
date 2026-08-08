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

// ══ 3b. TWO GUESTS OF THE SAME ACADEMY, ONE PERSON ═════════════════════════════════════════════
// The predicate that decides "this person dies" used to read "the person has exactly one link".
// That is wrong whenever an academy holds two guests for the same human — a routine duplicate. The
// person has two links, both dying, so it IS destroyed; the old test said one-link-only and so the
// preview under-counted `persons` and everything hanging off it, and the confirmation then destroyed
// rows it had never announced. The right question is whether EVERY current link belongs to a guest
// of this academy.
{
  const c = await client();
  const f = await seedAcademy(c);
  const { id: twin } = await one(c,
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('Same Human, Again', $1) RETURNING id`,
    [f.academy]);
  // the mint trigger gave the twin its own person; point it at the first and drop the orphan
  const { person_id: twinPerson } = await one(c,
    `SELECT person_id FROM public.person_links WHERE guest_player_id = $1`, [twin]);
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`, [f.person, twin]);
  await c.query(`DELETE FROM public.persons WHERE id = $1`, [twinPerson]);

  // something reachable ONLY through that person, to prove the undercount is not merely cosmetic
  const { id: contact } = await one(c,
    `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_scope)
     VALUES ($1, 'email', 'twin@example.com', 't***@example.com', 'global') RETURNING id`, [f.person]);

  const p = await preview(c, f.academy);
  ok('two links, both to guests of this academy: the person is counted as dying',
    p.deleted.persons === 1, { persons: p.deleted.persons, person_links: p.deleted.person_links });
  ok('both links are counted', p.deleted.person_links === 2, p.deleted.person_links);
  ok('and what hangs off that person is counted with it',
    p.deleted.notification_contacts === 1, p.deleted.notification_contacts);
  ok('a person whose every link dies with the academy is NOT a shared-identity blocker',
    !p.blockers.some((b) => b.code === 'SHARED_PERSON_IDENTITY'), p.blockers);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  await confirm(c, f.academy, p, auditId, ACTOR);
  const left = await one(c, `SELECT
      (SELECT count(*)::int FROM public.persons WHERE id = $1) AS persons,
      (SELECT count(*)::int FROM public.notification_contacts WHERE id = $2) AS contacts`, [f.person, contact]);
  ok('confirmation destroyed exactly what the preview announced', left.persons === 0 && left.contacts === 0, left);
  await c.end();
}

// ══ 3c. THE GUEST TRIGGER'S OTHER SIDE EFFECT — person_merge_review ════════════════════════════
// Deleting a guest also drops that guest's PENDING review rows and scrubs the identifying payload
// off its APPLIED ones. Neither is reachable by a foreign key from the academy, so both were
// invisible: a pending review destroyed unannounced, an applied one materially altered.
{
  const c = await client();
  const f = await seedAcademy(c);
  const { id: pending } = await one(c,
    `INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, person_id, details)
     VALUES ('no_email_guest', 'pending', 'p@example.com', $1, $2, '{"guest_name":"Fixture Guest"}'::jsonb)
     RETURNING id`, [f.guest, f.person]);
  const { id: applied } = await one(c,
    `INSERT INTO public.person_merge_review (kind, status, email, guest_player_id, person_id, details)
     VALUES ('auto_merged_email_pair', 'applied', 'a@example.com', $1, $2, '{"guest_name":"Fixture Guest"}'::jsonb)
     RETURNING id`, [f.guest, f.person]);

  const p = await preview(c, f.academy);
  ok('a PENDING review row is announced as deleted', p.deleted.person_merge_review === 1, p.deleted.person_merge_review);
  ok('an APPLIED review row is announced as MUTATED — a scrub is not a deletion',
    p.mutated.person_merge_review === 1, p.mutated);
  ok('mutated is a category of its own, not folded into deleted or detached',
    p.detached.person_merge_review === undefined);

  // both arms are in the digest: editing either must invalidate the preview
  await c.query(`UPDATE public.person_merge_review SET details = details || '{"note":"x"}'::jsonb WHERE id = $1`, [applied]);
  ok('editing the applied (mutated) row makes the digest stale',
    p.digest !== (await preview(c, f.academy)).digest);
  await c.query(`UPDATE public.person_merge_review SET details = details || '{"note":"y"}'::jsonb WHERE id = $1`, [pending]);
  const p2 = await preview(c, f.academy);

  const auditId = await startAudit(c, f.academy, ACTOR, p2);
  await confirm(c, f.academy, p2, auditId, ACTOR);
  const after = await one(c, `SELECT
      (SELECT count(*)::int FROM public.person_merge_review WHERE id = $1) AS pending_left,
      (SELECT count(*)::int FROM public.person_merge_review WHERE id = $2) AS applied_left,
      (SELECT email FROM public.person_merge_review WHERE id = $2) AS applied_email,
      (SELECT details ? 'guest_name' FROM public.person_merge_review WHERE id = $2) AS applied_has_name`,
    [pending, applied]);
  ok('the pending review row is gone, exactly as previewed', after.pending_left === 0, after);
  ok('the applied row SURVIVES — the merge fact is not a casualty of the deletion',
    after.applied_left === 1, after);
  ok('...but its identifying payload was scrubbed, which is what "mutated" promised',
    after.applied_email === null && after.applied_has_name === false, after);

  const audit = await one(c, `SELECT detached_counts FROM public.academy_deletion_audit WHERE id = $1`, [auditId]);
  ok('the audit records the mutation too', audit.detached_counts?.mutated?.person_merge_review === 1, audit);

  await c.query(`DELETE FROM public.person_merge_review WHERE id = $1`, [applied]);
  await c.end();
}

// ══ 3d. THE SET NULL SIDE OF KILLING A PERSON ══════════════════════════════════════════════════
// A person can be referenced by rows this academy does not own. `invoices.person_id` is ON DELETE
// SET NULL, so destroying the person CHANGES a trainer's invoice — it survives with its reference
// cleared. That is not a deletion and not nothing, and the operator has to be shown it. (The
// HAS_INVOICES blocker does not cover this: it scopes to invoices OF this academy, and this one
// belongs to someone else.)
{
  const c = await client();
  const f = await seedAcademy(c);
  const { id: outsideInvoice } = await one(c,
    `INSERT INTO public.invoices (invoice_number, due_date, player_name, status, person_id)
     VALUES ('U1C-P3-OUT-' || substr(gen_random_uuid()::text,1,8), current_date, 'Someone Else', 'sent', $1)
     RETURNING id`, [f.person]);

  const p = await preview(c, f.academy);
  ok('a foreign row whose person reference will be CLEARED is announced as detached',
    p.detached['invoices.person_id'] === 1, p.detached);
  ok('...and never as deleted — the invoice is not being destroyed',
    p.deleted.invoices === undefined && !p.blockers.some((b) => b.code === 'HAS_INVOICES'), p.blockers);
  ok('each person-keyed COLUMN is reported separately (bookings has two)',
    p.detached['bookings.person_id'] === 0 && p.detached['bookings.paid_by_person_id'] === 0, p.detached);

  // in the digest: editing the row that is about to be detached must invalidate the preview
  await c.query(`UPDATE public.invoices SET player_name = 'Renamed' WHERE id = $1`, [outsideInvoice]);
  ok('editing a to-be-detached row makes the digest stale',
    p.digest !== (await preview(c, f.academy)).digest);

  const p2 = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p2);
  await confirm(c, f.academy, p2, auditId, ACTOR);
  const after = await one(c,
    `SELECT count(*)::int AS n, bool_and(person_id IS NULL) AS cleared FROM public.invoices WHERE id = $1`,
    [outsideInvoice]);
  ok('the invoice SURVIVES the deletion, with its person reference cleared', after.n === 1 && after.cleared === true, after);

  await c.query(`DELETE FROM public.invoices WHERE id = $1`, [outsideInvoice]);
  await c.end();
}

// ══ 3e. THE PERSON THAT DOES NOT DIE IS STILL CHANGED ══════════════════════════════════════════
// When a link survives elsewhere the trigger takes the ELSE branch: it drops the dying link and
// calls `rederive_person`, which recomputes the surviving row's identity fields from the sources
// that remain. The person belongs to someone else and is not destroyed — but it IS altered, so it
// is announced as mutated and hashed like everything else.
{
  const c = await client();
  const f = await seedAcademy(c);
  const { id: outsideAcademy } = await one(c,
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-p3-survivor-home', 'u1c-p3-sv-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  CREATED.push(outsideAcademy);
  const { id: outsideGuest } = await one(c,
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('Elsewhere', $1) RETURNING id`,
    [outsideAcademy]);
  const { person_id: orphan } = await one(c,
    `SELECT person_id FROM public.person_links WHERE guest_player_id = $1`, [outsideGuest]);
  await c.query(`UPDATE public.person_links SET person_id = $1 WHERE guest_player_id = $2`, [f.person, outsideGuest]);
  await c.query(`DELETE FROM public.persons WHERE id = $1`, [orphan]);

  const p = await preview(c, f.academy);
  ok('a person that survives is NOT counted as deleted', p.deleted.persons === 0, p.deleted.persons);
  ok('...but IS announced as mutated — rederive_person will rewrite it', p.mutated.persons === 1, p.mutated);
  ok('only the dying link is counted as deleted, not the surviving one',
    p.deleted.person_links === 1, p.deleted.person_links);

  // the surviving person is in the digest: editing it must go stale
  await c.query(`UPDATE public.persons SET full_name = 'Edited Elsewhere' WHERE id = $1`, [f.person]);
  const auditId = await startAudit(c, f.academy, ACTOR, p);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok('editing the surviving person after the preview refuses PREVIEW_STALE',
    refused !== null && refused.includes('PREVIEW_STALE'), { refused });

  const p2 = await preview(c, f.academy);
  const { xmin: before } = await one(c, `SELECT xmin::text FROM public.persons WHERE id = $1`, [f.person]);
  const auditId2 = await startAudit(c, f.academy, ACTOR, p2);
  await confirm(c, f.academy, p2, auditId2, ACTOR);
  const survivor = await one(c,
    `SELECT count(*)::int AS n, max(xmin::text) AS rev FROM public.persons WHERE id = $1`, [f.person]);
  ok('the surviving person is still there', survivor.n === 1, survivor);
  ok('...and it was genuinely rewritten, exactly as "mutated" promised', survivor.rev !== before, { before, after: survivor.rev });

  await c.query(`DELETE FROM public.guest_players WHERE id = $1`, [outsideGuest]);
  await c.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [outsideAcademy]);
  await c.end();
}

// ══ 3f. THE DRIFT GUARD REACHES THE TRIGGER'S HELPERS ══════════════════════════════════════════
// Hashing a trigger's own body is not enough: what happens to a surviving person is decided by
// `rederive_person`, which the trigger merely CALLS. A migration could change it without touching a
// trigger definition, and this flow would go on claiming a coverage it no longer has.
{
  const c = await client();
  const f = await seedAcademy(c);
  const p = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p);
  const { d: original } = await one(c,
    `SELECT pg_get_functiondef('public.rederive_person(uuid)'::regprocedure) AS d`);
  ok('rederive_person is inside the fingerprinted helper closure',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_deletion_trigger_helper_defs()
                    WHERE sig LIKE 'rederive_person(%'`)).n === 1);

  await c.query(original.replace('$function$', '$function$ -- drift probe'));
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok('changing a helper the trigger calls is ACADEMY_DELETION_CATALOG_DRIFT',
    refused !== null && refused.includes('ACADEMY_DELETION_CATALOG_DRIFT'), { refused });

  await c.query(original);   // restore, or every later run fires on a phantom
  ok('restoring it makes the fingerprint match again',
    (await one(c, `SELECT public.academy_deletion_catalog_fingerprint() = public.academy_deletion_expected_fingerprint() AS m`)).m === true);
  await c.end();
}

// ══ 3g. ONE ROW, ONE CATEGORY ══════════════════════════════════════════════════════════════════
// An overlay row can be owned by a TRAINER (academy_profile_id NULL — the owner check forbids both)
// or by ANOTHER academy, and still die with this academy because it hangs off one of its guests.
// Such a row is deleted AND its person reference is a dying one, so while the deleted scope and the
// detach subtraction had separate definitions it was announced under both. Two true statements
// about one row is still a wrong preview.
{
  const c = await client();
  const f = await seedAcademy(c);
  const { id: uid } = await one(c,
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             'u1c-p3-trainer-' || replace(gen_random_uuid()::text,'-','') || '@example.com', '', now(), now())
     RETURNING id`);
  // the shipped signup trigger already made the profile — reading it beats a duplicate-key insert
  const { id: profileId } = await one(c, `SELECT id FROM public.profiles WHERE user_id = $1`, [uid]);
  const { id: trainer } = await one(c,
    `INSERT INTO public.trainer_profiles (user_id) VALUES ($1) RETURNING id`, [uid]);
  await c.query(
    `INSERT INTO public.academy_player_metadata (trainer_profile_id, guest_player_id, person_id, notes)
     VALUES ($1, $2, $3, 'trainer-owned, dies with the guest')`, [trainer, f.guest, f.person]);

  const p = await preview(c, f.academy);
  ok('a trainer-owned overlay row dying with the guest is counted as deleted',
    p.deleted.academy_player_metadata === 2, p.deleted.academy_player_metadata);
  ok('...and NOT a second time as detached', p.detached['academy_player_metadata.person_id'] === 0,
    p.detached['academy_player_metadata.person_id']);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  await confirm(c, f.academy, p, auditId, ACTOR);
  ok('every overlay row keyed to the dying guest is gone',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_player_metadata WHERE guest_player_id = $1`, [f.guest])).n === 0);

  // THE CASE THAT ACTUALLY DOUBLE-COUNTED. Another academy's overlay row, keyed to one of THIS
  // academy's guests: it dies with that guest, and `NOT (academy_profile_id = $1)` is plainly true
  // for it, so a subtraction that knew only the academy-value arm announced it under both headings.
  // (The trainer-owned row above conceals that bug rather than exposing it — its academy_profile_id
  // is NULL, so the subtraction evaluates to NULL and three-valued logic quietly drops the row.
  // That is why the subtraction coalesces to false rather than trusting NOT alone.)
  //
  // This preview is BLOCKED — another academy's overlay row is exactly what SHARED_PERSON_IDENTITY
  // refuses — but a blocked preview is still shown to an operator, so its counts must still be true.
  const f2 = await seedAcademy(c);
  const { id: otherAcademy } = await one(c,
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-p3-other-owner', 'u1c-p3-oo-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  CREATED.push(otherAcademy);
  await c.query(
    `INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, person_id, notes)
     VALUES ($1, $2, $3, 'another academy, this academy''s guest')`, [otherAcademy, f2.guest, f2.person]);

  const p2 = await preview(c, f2.academy);
  ok('another academy holding an overlay for this person blocks',
    p2.blockers.some((b) => b.code === 'SHARED_PERSON_IDENTITY'), p2.blockers);
  ok('the foreign overlay row is counted as deleted — it dies with the guest',
    p2.deleted.academy_player_metadata === 2, p2.deleted.academy_player_metadata);
  ok('...and NOT also as detached: deleted outranks detached, whoever owns the row',
    p2.detached['academy_player_metadata.person_id'] === 0, p2.detached['academy_player_metadata.person_id']);

  await c.query(`DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [otherAcademy]);
  await c.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [otherAcademy]);
  await c.query(`DELETE FROM public.trainer_profiles WHERE id = $1`, [trainer]);
  await c.query(`DELETE FROM public.profiles WHERE id = $1`, [profileId]);
  await c.query(`DELETE FROM auth.users WHERE id = $1`, [uid]);
  await c.end();
}

// ══ 3h. AN ACADEMY'S OWN MEMBERSHIPS MUST NOT BLOCK ITS DELETION ═══════════════════════════════
// `academy_player_memberships.person_id` is ON DELETE RESTRICT. Deleting the academy cascades both
// the guests and the memberships, and the order between two FK action triggers is not a contract:
// with the guests first, the cleanup trigger deletes a person the membership still references and
// RESTRICT aborts everything with 23503. After U1b backfills memberships that is EVERY academy, so
// the flow deletes its own memberships explicitly first.
{
  const c = await client();
  const f = await seedAcademy(c);
  await c.query(
    `INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1, $2)`,
    [f.academy, f.person]);

  const p = await preview(c, f.academy);
  ok('a membership in THIS academy is not a shared-identity blocker',
    !p.blockers.some((b) => b.code === 'SHARED_PERSON_IDENTITY'), p.blockers);
  ok('it is announced as deleted', p.deleted.academy_player_memberships === 1, p.deleted.academy_player_memberships);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  let failure = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { failure = `${e.code}: ${e.message}`; }
  ok('the deletion SUCCEEDS — a RESTRICT reference this flow owns is removed before the person',
    failure === null, { failure });
  ok('and the academy is really gone',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [f.academy])).n === 0);
  await c.end();
}

// ══ 3i. THE DRIFT GUARD REACHES THE RELATIONS THIS FLOW ONLY *WRITES* ══════════════════════════
// Clearing a person reference is an UPDATE, and the detach targets carry triggers that fire on one.
// Fingerprinting only what the flow DELETES left those outside the guard.
{
  const c = await client();
  const f = await seedAcademy(c);
  const p = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p);

  // every relation this transaction WRITES to, not only the ones it deletes from
  for (const rel of ['invoices', 'availability_slots', 'academy_deletion_audit', 'academy_player_metadata']) {
    ok(`${rel} is a trigger root because the flow writes to it`,
      (await one(c, `SELECT count(*)::int AS n FROM public.academy_deletion_trigger_root_relations()
                      WHERE oid = to_regclass('public.' || $1)`, [rel])).n === 1);
  }

  await c.query(`CREATE OR REPLACE FUNCTION public.u1c_p3_probe_fn() RETURNS trigger
                 LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; END $fn$`);
  await c.query(`CREATE TRIGGER u1c_p3_probe BEFORE UPDATE ON public.invoices
                 FOR EACH ROW EXECUTE FUNCTION public.u1c_p3_probe_fn()`);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok('a new trigger on a DETACH TARGET is ACADEMY_DELETION_CATALOG_DRIFT',
    refused !== null && refused.includes('ACADEMY_DELETION_CATALOG_DRIFT'), { refused });

  await c.query(`DROP TRIGGER u1c_p3_probe ON public.invoices`);
  await c.query(`DROP FUNCTION public.u1c_p3_probe_fn()`);
  ok('removing it makes the fingerprint match again',
    (await one(c, `SELECT public.academy_deletion_catalog_fingerprint() = public.academy_deletion_expected_fingerprint() AS m`)).m === true);

  // A REWRITE RULE adds statements to this transaction without touching a constraint, a trigger or
  // a function body — the three things the rest of the fingerprint hashes.
  await c.query(`CREATE RULE u1c_p3_rule AS ON UPDATE TO public.availability_slots DO ALSO NOTHING`);
  let ruleRefused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { ruleRefused = e.message; }
  ok('a rewrite RULE on a written relation is ACADEMY_DELETION_CATALOG_DRIFT too',
    ruleRefused !== null && ruleRefused.includes('ACADEMY_DELETION_CATALOG_DRIFT'), { ruleRefused });
  await c.query(`DROP RULE u1c_p3_rule ON public.availability_slots`);
  ok('and dropping the rule restores the fingerprint',
    (await one(c, `SELECT public.academy_deletion_catalog_fingerprint() = public.academy_deletion_expected_fingerprint() AS m`)).m === true);
  await c.end();
}

// ══ 3j. A DETACH THAT WOULD BREAK A CHECK IS A BLOCKER, NOT A CRASH ════════════════════════════
// `bookings` requires an owner: player_id OR guest_player_id OR anonymized_at. Deleting the academy
// cascades its guests, the FK clears `bookings.guest_player_id`, and a GUEST-ONLY booking then
// violates that check — the transaction aborts, after a clean preview, and a guest-only booking is
// not an exotic state: it is how guests are booked. So the check is re-evaluated with the column
// forced to NULL and the row is refused up front instead.
{
  const c = await client();
  const f = await seedAcademy(c);
  const { id: uid } = await one(c,
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             'u1c-p3-slot-' || replace(gen_random_uuid()::text,'-','') || '@example.com', '', now(), now())
     RETURNING id`);
  const { id: profileId } = await one(c, `SELECT id FROM public.profiles WHERE user_id = $1`, [uid]);
  const { id: trainer } = await one(c,
    `INSERT INTO public.trainer_profiles (user_id) VALUES ($1) RETURNING id`, [uid]);
  const { id: slot } = await one(c,
    `INSERT INTO public.availability_slots (trainer_id, start_time, end_time)
     VALUES ($1, now() + interval '1 day', now() + interval '1 day 1 hour') RETURNING id`, [trainer]);
  const { id: booking } = await one(c,
    `INSERT INTO public.bookings (slot_id, guest_player_id) VALUES ($1, $2) RETURNING id`, [slot, f.guest]);

  const p = await preview(c, f.academy);
  ok('a guest-ONLY booking blocks: clearing its guest would violate booking_has_player',
    p.blockers.some((b) => b.code === 'DETACH_BREAKS_CONSTRAINT'), p.blockers);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = `${e.code}:${e.message}`; }
  ok('...and it is refused as BLOCKED, not discovered as a constraint violation mid-delete',
    refused !== null && refused.includes('BLOCKED') && !refused.includes('23514'), { refused });
  ok('the academy survives the refusal intact',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [f.academy])).n === 1);

  // give the booking a second owner: the check now survives the detach, so it is merely detached
  await c.query(`UPDATE public.bookings SET player_id = $1 WHERE id = $2`, [profileId, booking]);
  const p2 = await preview(c, f.academy);
  ok('with another owner present the block clears',
    !p2.blockers.some((b) => b.code === 'DETACH_BREAKS_CONSTRAINT'), p2.blockers);
  ok('and the booking is announced as detached', p2.detached['bookings.guest_player_id'] === 1, p2.detached);

  const auditId2 = await startAudit(c, f.academy, ACTOR, p2);
  await confirm(c, f.academy, p2, auditId2, ACTOR);
  const after = await one(c,
    `SELECT count(*)::int AS n, bool_and(guest_player_id IS NULL) AS cleared FROM public.bookings WHERE id = $1`, [booking]);
  ok('the booking survives with its guest reference cleared', after.n === 1 && after.cleared === true, after);

  await c.query(`DELETE FROM public.bookings WHERE id = $1`, [booking]);
  await c.query(`DELETE FROM public.availability_slots WHERE id = $1`, [slot]);
  await c.query(`DELETE FROM public.trainer_profiles WHERE id = $1`, [trainer]);
  await c.query(`DELETE FROM public.profiles WHERE id = $1`, [profileId]);
  await c.query(`DELETE FROM auth.users WHERE id = $1`, [uid]);
  await c.end();
}

// ══ 3k. A REFUSING REFERENCE IS A BLOCKER TOO ══════════════════════════════════════════════════
// `intake_requests.guest_player_id` is NO ACTION and nothing in this flow deletes those rows, so the
// guest cascade would abort the transaction. Read out of the catalogue rather than discovered.
{
  const c = await client();
  const f = await seedAcademy(c);
  // a real trainer: registrations validate their owner, so a random uuid is refused
  const { id: uid } = await one(c,
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
     VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             'u1c-p3-intake-' || replace(gen_random_uuid()::text,'-','') || '@example.com', '', now(), now())
     RETURNING id`);
  const { id: profileId } = await one(c, `SELECT id FROM public.profiles WHERE user_id = $1`, [uid]);
  const { id: trainer } = await one(c,
    `INSERT INTO public.trainer_profiles (user_id) VALUES ($1) RETURNING id`, [uid]);
  const { id: reg } = await one(c,
    `INSERT INTO public.registrations (owner_type, owner_id, name)
     VALUES ('trainer', $1, 'u1c-p3 intake host') RETURNING id`, [trainer]);
  await c.query(
    `INSERT INTO public.intake_requests
       (registration_id, guest_player_id, full_name, email, lesson_type, preferred_days, preferred_time_windows)
     VALUES ($1, $2, 'Intake', 'intake@example.com', ARRAY['group'], ARRAY['mon'], '[]'::jsonb)`,
    [reg, f.guest]);

  const p = await preview(c, f.academy);
  ok('a NO ACTION reference to a dying guest is reported as BLOCKING_REFERENCES',
    p.blockers.some((b) => b.code === 'BLOCKING_REFERENCES'), p.blockers);
  ok('a trainer-owned registration is NOT this academy\'s programme',
    !p.blockers.some((b) => b.code === 'HAS_PROGRAMS'), p.blockers);

  const auditId = await startAudit(c, f.academy, ACTOR, p);
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = `${e.code}:${e.message}`; }
  ok('it refuses BLOCKED rather than aborting on the foreign key',
    refused !== null && refused.includes('BLOCKED') && !refused.includes('23503'), { refused });

  await c.query(`DELETE FROM public.intake_requests WHERE guest_player_id = $1`, [f.guest]);
  await c.query(`DELETE FROM public.registrations WHERE id = $1`, [reg]);
  await c.query(`DELETE FROM public.trainer_profiles WHERE id = $1`, [trainer]);
  await c.query(`DELETE FROM public.profiles WHERE id = $1`, [profileId]);
  await c.query(`DELETE FROM auth.users WHERE id = $1`, [uid]);
  await c.end();
}

// ══ 3m. THE MODEL IS DERIVED OVER EVERY DELETION PARENT, NOT A LIST OF ROOTS ═══════════════════
// Three named roots was one root too few, twice. Any relation this transaction deletes from is a
// parent whose children feel it — including the overlays it deletes by value.
{
  const c = await client();
  const parents = (await c.query(`SELECT relname FROM public.academy_deletion_deletion_parents() ORDER BY 1`)).rows.map((r) => r.relname);
  for (const rel of ['academy_player_metadata', 'academy_player_locations', 'guest_players', 'persons',
                     'person_links', 'session_player_notes']) {
    ok(`${rel} is a deletion parent`, parents.includes(rel), parents.length);
  }
  ok('the preview loop and the derivation walk the SAME set',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_deletion_deletion_parents() dp
                    WHERE public.academy_deletion_deleted_scope(dp.relname) IS NULL`)).n === 0);

  // every detach target's parent is one of them — nothing is derived from a root that is not deleted
  ok('every detach target hangs off a relation this flow actually deletes',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_deletion_detach_targets() dt
                    WHERE dt.parent NOT IN (SELECT relname FROM public.academy_deletion_deletion_parents())`)).n === 0);

  // Every SET NULL foreign key in the shipped schema happens to point at `persons` or
  // `guest_players`, so a derivation narrowed to those two roots is indistinguishable today. It is
  // not indistinguishable tomorrow: an overlay is deleted too, and a child of one detaches exactly
  // the same way. Staged here rather than waited for.
  await c.query(`ALTER TABLE public.invoices ADD COLUMN u1c_p3_probe_meta_id uuid
                 REFERENCES public.academy_player_metadata(id) ON DELETE SET NULL`);
  ok('a SET NULL child of a deleted OVERLAY is derived as a detach target',
    (await one(c, `SELECT count(*)::int AS n FROM public.academy_deletion_detach_targets()
                    WHERE parent = 'academy_player_metadata' AND relname = 'invoices'
                      AND colname = 'u1c_p3_probe_meta_id'`)).n === 1);
  await c.query(`ALTER TABLE public.invoices DROP COLUMN u1c_p3_probe_meta_id`);
  ok('dropping the probe restores the fingerprint',
    (await one(c, `SELECT public.academy_deletion_catalog_fingerprint() = public.academy_deletion_expected_fingerprint() AS m`)).m === true);

  // a relation outside `public` must not be silently swallowed: `to_regclass` ERRORs on a dotted
  // name rather than returning NULL, and WHERE-clause evaluation order is not a contract
  ok('a schema-qualified name yields NULL rather than a cross-database error',
    (await one(c, `SELECT public.academy_deletion_scope_predicate('storage.objects') IS NULL AS m`)).m === true);
  await c.end();
}

// ══ 3n. A MULTI-COLUMN CHECK IS SIMULATED AS A WHOLE ═══════════════════════════════════════════
// `slot_priority_claims` has TWO guest columns. A check that reads both is survivable when each is
// simulated alone and broken when both are cleared — which is what actually happens. No shipped
// check reads both today, so the case is staged: the constraint is created, the simulation
// inspected, and its removal asserted to restore the fingerprint.
{
  const c = await client();
  const f = await seedAcademy(c);
  const p = await preview(c, f.academy);
  const auditId = await startAudit(c, f.academy, ACTOR, p);

  const single = await one(c, `SELECT public.academy_deletion_detach_check_pred('slot_priority_claims') AS p`);
  ok('the shipped one-column check is simulated with one substitution',
    (single.p.match(/CASE WHEN/g) ?? []).length === 1, { n: (single.p.match(/CASE WHEN/g) ?? []).length });

  await c.query(`ALTER TABLE public.slot_priority_claims ADD CONSTRAINT u1c_p3_two_col_probe
                 CHECK (guest_player_id IS NOT NULL OR booked_by_guest_player_id IS NOT NULL OR player_id IS NOT NULL)`);
  const both = await one(c, `SELECT public.academy_deletion_detach_check_pred('slot_priority_claims') AS p`);
  ok('a check reading BOTH guest columns is simulated with both cleared at once',
    (both.p.match(/CASE WHEN/g) ?? []).length >= 3, { n: (both.p.match(/CASE WHEN/g) ?? []).length });
  ok('...and each substitution is conditional on that column\'s own row dying, not a blanket NULL',
    both.p.includes('THEN NULL ELSE'));

  // the checks are themselves fingerprinted: they are the blocker's input, so changing one is drift
  let refused = null;
  try { await confirm(c, f.academy, p, auditId, ACTOR); } catch (e) { refused = e.message; }
  ok('adding a CHECK to a detach target is ACADEMY_DELETION_CATALOG_DRIFT',
    refused !== null && refused.includes('ACADEMY_DELETION_CATALOG_DRIFT'), { refused });

  await c.query(`ALTER TABLE public.slot_priority_claims DROP CONSTRAINT u1c_p3_two_col_probe`);
  ok('dropping it restores the fingerprint',
    (await one(c, `SELECT public.academy_deletion_catalog_fingerprint() = public.academy_deletion_expected_fingerprint() AS m`)).m === true);

  const p2 = await preview(c, f.academy);
  ok('an academy with no breaking rows is not blocked by the simulation',
    !p2.blockers.some((b) => b.code === 'DETACH_BREAKS_CONSTRAINT'), p2.blockers);
  await c.end();
}

// ══ 3l. THE ROOT ITSELF IS LOCKED ══════════════════════════════════════════════════════════════
// Only the academy's ROW was locked, so a concurrent CREATE TRIGGER on academy_profiles could take
// its lock after the fingerprint was checked and fire during the delete.
{
  const c = await client();
  const f = await seedAcademy(c);
  await c.query('BEGIN');
  await c.query(`SELECT public.academy_deletion_lock_plan($1)`, [f.academy]);
  const held = await one(c, `
    SELECT bool_or(l.relation = 'public.academy_profiles'::regclass AND l.mode = 'ShareRowExclusiveLock') AS root,
           bool_or(l.relation = 'public.academy_deletion_audit'::regclass AND l.mode = 'RowExclusiveLock') AS audit
      FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted`);
  ok('the lock plan holds academy_profiles itself, not merely its row', held.root === true, held);
  ok('...and the audit table at the weakest mode that still conflicts with trigger DDL',
    held.audit === true, held);
  await c.query('ROLLBACK');
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
// Session A runs the REAL `academy_delete_confirmed`. It is parked mid-lock-plan by a third session
// holding a conflicting lock on a relation that sorts LATE in the plan's fixed ascending order: by
// the time A blocks there it has already taken every earlier relation lock, which is exactly the
// state under test.
//
// (An earlier version parked A with a test-local trigger on academy_player_metadata. That is now
// impossible — and rightly so: the catalogue fingerprint hashes every trigger on the closure, so
// adding one is DRIFT and the confirmation refuses. The guard caught its own test harness.)
{
  const setup = await client();
  const { rows: [{ id: academy }] } = await setup.query(
    `INSERT INTO public.academy_profiles (name, slug)
     VALUES ('u1c-p3-concurrency', 'u1c-p3-cc-' || replace(gen_random_uuid()::text,'-','')) RETURNING id`);
  const { rows: [{ id: ccGuest }] } = await setup.query(
    `INSERT INTO public.guest_players (full_name, academy_profile_id) VALUES ('CC Guest', $1) RETURNING id`, [academy]);
  await setup.query(
    `INSERT INTO public.academy_player_metadata (academy_profile_id, guest_player_id, notes)
     VALUES ($1, $2, 'hold')`, [academy, ccGuest]);

  const p = await preview(setup, academy);
  const { rows: [{ id: auditId }] } = await setup.query(
    `INSERT INTO public.academy_deletion_audit (academy_profile_id, actor_user_id, preview_version, digest)
     VALUES ($1, $2, $3, $4) RETURNING id`, [academy, ACTOR, p.preview_version, p.digest]);

  // The gatekeeper: `persons` sorts late, so A parks there holding everything before it.
  const gate = await client();
  await gate.query('BEGIN');
  await gate.query(`LOCK TABLE public.persons IN ACCESS EXCLUSIVE MODE`);

  const a = await client();
  const { pg_backend_pid: aPid } = await one(a, `SELECT pg_backend_pid()`);
  const aRun = a.query('BEGIN')
    .then(() => a.query(`SELECT public.academy_delete_confirmed($1,$2,$3,$4,$5)`,
      [academy, p.digest, p.preview_version, auditId, ACTOR]))
    .then(() => a.query('COMMIT').then(() => 'committed'))
    .catch((e) => { a.query('ROLLBACK').catch(() => {}); return `failed: ${e.message}`; });

  // Wait until A is DEMONSTRABLY blocked on `persons` — not a sleep. As the lock plan grows, a fixed
  // delay stops being long enough and B would run before A held anything (which happened once).
  const probe = await client();
  let parked = false;
  for (let i = 0; i < 200 && !parked; i++) {
    const r = await one(probe, `
      SELECT count(*)::int AS n FROM pg_locks
       WHERE pid = $1 AND NOT granted AND locktype = 'relation'
         AND relation = 'public.persons'::regclass`, [aPid]);
    parked = r.n > 0;
    if (!parked) await new Promise((r2) => setTimeout(r2, 50));
  }
  ok('session A is blocked mid-lock-plan, holding every earlier relation lock', parked);

  const b = await client();
  await b.query(`SET lock_timeout = '600ms'`);
  let overlayErr = null, identityErr = null;
  try {
    await b.query(`UPDATE public.academy_player_metadata SET notes = 'racer' WHERE academy_profile_id = $1`, [academy]);
  } catch (e) { overlayErr = e.code; }
  try {
    await b.query(`UPDATE public.person_links SET person_id = person_id WHERE guest_player_id = $1`, [ccGuest]);
  } catch (e) { identityErr = e.code; }

  ok('a concurrent OVERLAY write blocks while the deletion holds its locks (55P03)', overlayErr === '55P03', { overlayErr });
  ok('a concurrent IDENTITY write blocks too (55P03)', identityErr === '55P03', { identityErr });

  await gate.query('ROLLBACK');          // release the gate; A proceeds
  const aResult = await aRun;
  ok('the held deletion then resolves', typeof aResult === 'string', { aResult });

  await b.query(`SET lock_timeout = '10s'`);
  const after = await one(b, `SELECT count(*)::int AS n FROM public.academy_profiles WHERE id = $1`, [academy]);
  ok('a retried writer sees the committed outcome, not a half-state',
    (aResult === 'committed' && after.n === 0) || (aResult !== 'committed' && after.n === 1),
    { aResult, remaining: after.n });

  await b.query(`DELETE FROM public.academy_player_metadata WHERE academy_profile_id = $1`, [academy]);
  await b.query(`DELETE FROM public.academy_deletion_audit WHERE academy_profile_id = $1`, [academy]);
  await b.query(`DELETE FROM public.academy_profiles WHERE id = $1`, [academy]).catch(() => {});
  await Promise.all([a.end(), b.end(), gate.end(), probe.end(), setup.end()]);
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
