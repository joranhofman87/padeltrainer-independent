#!/usr/bin/env node
/**
 * SLICE A part 1 — the worker-kind partition, against REAL local PostgreSQL.
 *
 * The invariant this file exists to hold: the generic email worker and the dedicated identity
 * sender claim DISJOINT sets of outbox rows, and neither can skip, reap or burn the other's. That
 * cannot be tested against a copy of the predicate — the claim is a SECURITY DEFINER function whose
 * whole job is concurrency, so every assertion here calls the shipped RPC.
 *
 * The property that carries the deployment: `p_worker_kind` DEFAULTS to NULL, so the THREE-argument
 * call the already-deployed production worker makes resolves to the new function and excludes
 * identity rows without that worker being redeployed.
 *
 * LOCAL ONLY: connection string hardcoded to 127.0.0.1:54322, no env override, no remote access.
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
const one = async (sql, p = []) => (await c.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await c.query(sql, p)).rows;

await c.query('BEGIN');

// ── the instant email path must be ACTIVE, or the claim returns nothing and every assertion below
//    would pass for the wrong reason — the trap the notification work hit repeatedly. `email:instant`
//    ships active with an unbounded boundary, so this asserts rather than seeds; if that ever
//    changes, this file fails loudly instead of going quietly green.
const boundaryOpen = await one(`SELECT public.notif_activation_boundary('email:instant') AS b`);
ok('the email:instant path is active for this test (else every claim would be vacuously empty)',
   boundaryOpen.b !== null, boundaryOpen);

// ── the catalogue partition ────────────────────────────────────────────────────────────────────
const cat = await one(`SELECT dedicated_worker FROM public.notification_event_types
                        WHERE key = 'identity_verification_requested'`);
ok('identity_verification_requested is owned by the identity_verify worker kind',
   cat && cat.dedicated_worker === 'identity_verify', cat);

const generic = await one(`SELECT count(*)::int AS n FROM public.notification_event_types
                            WHERE dedicated_worker IS NULL`);
ok('every other event stays with the generic worker (NULL)', generic.n > 0, generic);

ok('an UNKNOWN event type answers NULL, so it keeps its present owner rather than becoming unroutable',
   (await one(`SELECT public.notif_event_dedicated_worker('no_such_event_type_xyz') AS w`)).w === null);

// ── fixtures: one identity row and one ordinary row, both due on the email channel ─────────────
const owner = await one(`SELECT id FROM public.academy_profiles LIMIT 1`);
// the outbox requires a recipient (person | user | guest). A throwaway person keeps the fixture
// honest without dragging a whole booking flow into a routing test.
const probePerson = (await one(`INSERT INTO public.persons (full_name) VALUES ('routing probe') RETURNING id`)).id;
const mkRow = async (eventType, templateKey) => (await one(
  `INSERT INTO public.notification_outbox
     (channel, event_type, template_key, destination_normalized, destination_redacted,
      payload, status, scheduled_for, occurred_at, created_at, delivery_mode,
      tenant_academy_profile_id, max_attempts, idempotency_key, recipient_person_id)
   VALUES ('email', $1, $2, 'x@example.com', 'x***@example.com',
           '{"probe":true}'::jsonb, 'pending', now() - interval '1 minute',
           now() - interval '1 minute', now() - interval '1 minute', 'instant', $3, 5,
           'routing-probe:' || gen_random_uuid()::text, $4)
   RETURNING id`, [eventType, templateKey, owner ? owner.id : null, probePerson])).id;

const idRow = await mkRow('identity_verification_requested', 'identity_verification_requested');
const genericEvent = await one(`SELECT key, COALESCE(template_email, key) AS tpl
                                  FROM public.notification_event_types
                                 WHERE dedicated_worker IS NULL AND supports_email LIMIT 1`);
const otherRow = await mkRow(genericEvent.key, genericEvent.tpl);

// ── THE PARTITION ──────────────────────────────────────────────────────────────────────────────
// The generic worker, called EXACTLY as the deployed one calls it: three named arguments.
const genericClaim = await all(
  `SELECT outbox_id FROM public.claim_notification_outbox_batch(
      p_channel => 'email', p_worker => 'generic-probe', p_limit => 50)`);
const genericIds = genericClaim.map((r) => r.outbox_id);

ok('the DEPLOYED 3-argument call still resolves (no ambiguous-overload outage)', Array.isArray(genericIds));
ok('...and it does NOT claim the identity row — the migration alone makes the live worker safe',
   !genericIds.includes(idRow), { idRow, genericIds });
ok('...while still claiming ordinary email rows', genericIds.includes(otherRow), { otherRow, genericIds });

// The dedicated worker takes its own, and only its own.
const identityClaim = await all(
  `SELECT outbox_id FROM public.claim_notification_outbox_batch(
      p_channel => 'email', p_worker => 'identity-probe', p_limit => 50,
      p_worker_kind => 'identity_verify')`);
const identityIds = identityClaim.map((r) => r.outbox_id);

ok('the dedicated worker claims the identity row', identityIds.includes(idRow), { idRow, identityIds });
ok('...and claims nothing belonging to the generic worker', !identityIds.includes(otherRow), { identityIds });

const overlap = genericIds.filter((id) => identityIds.includes(id));
ok('the two claim sets are DISJOINT — no row can be sent twice', overlap.length === 0, { overlap });

// ── no double-claim under contention ───────────────────────────────────────────────────────────
// A second dedicated worker, after the first already holds the row, must get nothing: the row is
// 'processing' and not yet stale, so it is neither due nor reclaimable.
const second = await all(
  `SELECT outbox_id FROM public.claim_notification_outbox_batch(
      p_channel => 'email', p_worker => 'identity-probe-2', p_limit => 50,
      p_worker_kind => 'identity_verify')`);
ok('a second identity worker cannot re-claim a row the first still holds',
   !second.map((r) => r.outbox_id).includes(idRow), second);

const held = await one(`SELECT locked_by, status, attempts FROM public.notification_outbox WHERE id = $1`, [idRow]);
ok('...and the row is still held by the FIRST worker, attempts incremented exactly once',
   held.locked_by === 'identity-probe' && held.status === 'processing' && held.attempts === 1, held);

// ── the generic worker cannot REAP or SKIP an identity row either ───────────────────────────────
// Burning by reap is as fatal as burning by claim, so the partition is on all three statements.
await c.query(`UPDATE public.notification_outbox
                  SET status='processing', locked_at = now() - interval '90 minutes',
                      attempts = max_attempts, locked_by='dead-worker'
                WHERE id = $1`, [idRow]);
await c.query(`SELECT * FROM public.claim_notification_outbox_batch(
                  p_channel => 'email', p_worker => 'generic-probe-3', p_limit => 50)`);
const afterReap = await one(`SELECT status, last_error FROM public.notification_outbox WHERE id = $1`, [idRow]);
ok('the generic worker does NOT reap a stale identity row as stuck_in_processing',
   afterReap.status !== 'failed' && afterReap.last_error !== 'stuck_in_processing', afterReap);

// ...but its own worker kind still can, so a genuinely stuck identity row is not immortal.
await c.query(`SELECT * FROM public.claim_notification_outbox_batch(
                  p_channel => 'email', p_worker => 'identity-probe-4', p_limit => 50,
                  p_worker_kind => 'identity_verify')`);
const afterOwnReap = await one(`SELECT status, last_error FROM public.notification_outbox WHERE id = $1`, [idRow]);
ok('...but the identity worker DOES reap it, so a stuck row is still recoverable',
   afterOwnReap.status === 'failed' && afterOwnReap.last_error === 'stuck_in_processing', afterOwnReap);

// ── the send target: the challenge address, never the person's current contact ──────────────────
const tgt = await all(`SELECT * FROM public.identity_challenge_send_target(gen_random_uuid())`);
ok('an unknown challenge id yields no send target (fail closed, nothing to send)', tgt.length === 0);

const grantIdentity = await one(`
  SELECT has_function_privilege('authenticated', 'public.identity_challenge_send_target(uuid)', 'EXECUTE') AS a,
         has_function_privilege('anon',          'public.identity_challenge_send_target(uuid)', 'EXECUTE') AS n,
         has_function_privilege('service_role',  'public.identity_challenge_send_target(uuid)', 'EXECUTE') AS s`);
ok('the send target is service_role only — no browser or authenticated client may read the address',
   grantIdentity.a === false && grantIdentity.n === false && grantIdentity.s === true, grantIdentity);

const grantClaim = await one(`
  SELECT has_function_privilege('authenticated', 'public.claim_notification_outbox_batch(text,text,int,int,text)', 'EXECUTE') AS a,
         has_function_privilege('anon',          'public.claim_notification_outbox_batch(text,text,int,int,text)', 'EXECUTE') AS n,
         has_function_privilege('service_role',  'public.claim_notification_outbox_batch(text,text,int,int,text)', 'EXECUTE') AS s`);
ok('the claim stays service_role only after the signature change',
   grantClaim.a === false && grantClaim.n === false && grantClaim.s === true, grantClaim);

const oldSig = await one(`
  SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname='public' AND p.proname='claim_notification_outbox_batch'`);
ok('exactly ONE claim function exists — the 4-argument overload is gone, so a 3-argument call is unambiguous',
   oldSig.n === 1, oldSig);

await c.query('ROLLBACK');
await c.end();

if (failures) { console.error(`\n❌ identity worker routing FAILED (${failures})`); process.exit(1); }
console.log('\n✅ identity worker routing passed');
