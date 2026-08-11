#!/usr/bin/env node
/**
 * U2 B1 — what the guard trigger does when TWO workers reach the same operation at once.
 *
 * PGlite is a single connection: it cannot express this, and faking it there would prove nothing.
 * So this runs against real local Postgres with two sessions and real row locks.
 *
 * WHAT THIS DOES AND DOES NOT PROVE. It exercises the trigger directly, as the table's owner,
 * because B1 ships no RPC and grants no client role any privilege. It therefore proves the
 * TRANSITION layer serialises: given two concurrent claims, exactly one survives and the other is
 * refused by the state machine rather than silently overwriting it. It does NOT prove worker
 * IDENTITY fencing — that a superseded holder's UPDATE matches zero rows — because that predicate
 * belongs to the RPCs the later slice owns, and no such RPC exists yet. When those land, this file
 * is the place to add the two-session proof of the predicate itself.
 *
 * LOCAL ONLY — the connection string is hardcoded to 127.0.0.1:54322 and nothing here reads a
 * credential.
 */
import pg from 'pg';

const CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let failures = 0;
const fail = (msg, detail) => { failures++; console.error('FAIL', msg, detail ?? ''); };
const pass = (msg) => console.log('PASS', msg);
const ok_ = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

const a = new pg.Client({ connectionString: CONN });
const b = new pg.Client({ connectionString: CONN });
const admin = new pg.Client({ connectionString: CONN });
await a.connect(); await b.connect(); await admin.connect();

const created = [];

/** A fresh operation, carried to `database_scrubbed` so a claim is the next legal step. */
async function scrubbedOperation() {
  const { rows: [row] } = await admin.query(`
    INSERT INTO public.account_scrub_operations
      (command_id, subject_user_id, actor_user_id, self_service)
    VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), false)
    RETURNING id`);
  // self_service must equal (actor = subject); the insert above deliberately uses two distinct ids
  await admin.query(
    `UPDATE public.account_scrub_operations
        SET state = 'database_scrubbed', subject_person_id = gen_random_uuid() WHERE id = $1`, [row.id]);
  created.push(row.id);
  return row.id;
}

/** Wait until `client` is genuinely blocked on a lock, rather than merely slow. */
async function waitUntilBlocked(pid, label) {
  for (let i = 0; i < 200; i++) {
    const { rows: [w] } = await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid]);
    if (w.n === 1) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  fail(`${label} never blocked on a row lock — the race was not actually staged`);
  return false;
}

const pidOf = async (c) => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
const aPid = await pidOf(a);
const bPid = await pidOf(b);

// ── 1. two workers claim the same freshly scrubbed operation ───────────────────────────────────
{
  const id = await scrubbedOperation();
  const tokenA = '11111111-1111-4111-8111-111111111111';
  const tokenB = '22222222-2222-4222-8222-222222222222';

  await a.query('BEGIN');
  await a.query(
    `UPDATE public.account_scrub_operations
        SET state = 'external_cleanup_in_progress', lease_token = $2 WHERE id = $1`, [id, tokenA]);

  // B issues the same claim and must WAIT: A holds the row lock.
  await b.query('BEGIN');
  const bClaim = b.query(
    `UPDATE public.account_scrub_operations
        SET state = 'external_cleanup_in_progress', lease_token = $2 WHERE id = $1`, [id, tokenB])
    .then(() => ({ ok: true }), (e) => ({ ok: false, message: e.message }));

  const staged = await waitUntilBlocked(bPid, 'the second claimant');
  await a.query('COMMIT');

  const result = await bClaim;
  await b.query('ROLLBACK');

  ok_(staged && !result.ok, 'the second concurrent claim is REFUSED, not silently applied', result);
  ok_(!result.ok && /only an expired lease may be reclaimed/.test(result.message ?? ''),
    '...and it is refused by the state machine, as an unexpired lease it may not reclaim',
    { message: result.message });

  const { rows: [held] } = await admin.query(
    `SELECT lease_token::text AS token, external_attempt_count::int AS attempts, state
       FROM public.account_scrub_operations WHERE id = $1`, [id]);
  ok_(held.token === tokenA && held.attempts === 1 && held.state === 'external_cleanup_in_progress',
    'exactly one worker holds the operation, and the attempt was counted exactly once', held);
}

// ── 2. two workers reclaim the same EXPIRED lease ──────────────────────────────────────────────
{
  const id = await scrubbedOperation();
  await admin.query(
    `UPDATE public.account_scrub_operations
        SET state = 'external_cleanup_in_progress', lease_token = gen_random_uuid() WHERE id = $1`, [id]);
  // age the lease without waiting five real minutes; the trigger owns the value, so this is the one
  // way to stage expiry, and it is done by the owner outside the race
  await admin.query('ALTER TABLE public.account_scrub_operations DISABLE TRIGGER USER');
  await admin.query(
    `UPDATE public.account_scrub_operations
        SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [id]);
  await admin.query('ALTER TABLE public.account_scrub_operations ENABLE TRIGGER USER');

  const tokenA = '33333333-3333-4333-8333-333333333333';
  const tokenB = '44444444-4444-4444-8444-444444444444';

  await a.query('BEGIN');
  await a.query(
    `UPDATE public.account_scrub_operations
        SET state = 'external_cleanup_in_progress', lease_token = $2 WHERE id = $1`, [id, tokenA]);

  await b.query('BEGIN');
  const bReclaim = b.query(
    `UPDATE public.account_scrub_operations
        SET state = 'external_cleanup_in_progress', lease_token = $2 WHERE id = $1`, [id, tokenB])
    .then(() => ({ ok: true }), (e) => ({ ok: false, message: e.message }));

  const staged = await waitUntilBlocked(bPid, 'the second reclaimer');
  await a.query('COMMIT');
  const result = await bReclaim;
  await b.query('ROLLBACK');

  ok_(staged && !result.ok,
    'two workers reclaiming one expired lease: the second is refused', result);
  ok_(!result.ok && /only an expired lease may be reclaimed/.test(result.message ?? ''),
    '...because the first reclaim already made the lease fresh', { message: result.message });

  const { rows: [held] } = await admin.query(
    `SELECT lease_token::text AS token, external_attempt_count::int AS attempts
       FROM public.account_scrub_operations WHERE id = $1`, [id]);
  ok_(held.token === tokenA && held.attempts === 2,
    'the attempt counter advanced ONCE, not once per racing worker', held);
}

// ── 3. the loser of a race can still make progress once it legitimately holds the row ──────────
// Otherwise "refused" could mean "wedged", which is the failure mode this whole slice exists to
// avoid: a refusal must leave the operation workable, not stranded.
{
  const id = await scrubbedOperation();
  await admin.query(
    `UPDATE public.account_scrub_operations
        SET state = 'external_cleanup_in_progress', lease_token = gen_random_uuid() WHERE id = $1`, [id]);
  await admin.query(
    `UPDATE public.account_scrub_operations SET auth_deleted_at = clock_timestamp() WHERE id = $1`, [id]);
  await admin.query(
    `UPDATE public.account_scrub_operations
        SET state = 'database_scrubbed', last_error_code = 'asset_retryable' WHERE id = $1`, [id]);
  const { rows: [r] } = await admin.query(
    `SELECT state, next_attempt_at > clock_timestamp() AS backing_off,
            auth_deleted_at IS NOT NULL AS auth_recorded
       FROM public.account_scrub_operations WHERE id = $1`, [id]);
  ok_(r.state === 'database_scrubbed' && r.backing_off === true && r.auth_recorded === true,
    'a released operation keeps its recorded outcome and comes back on a database-set backoff', r);
}

// ── cleanup ────────────────────────────────────────────────────────────────────────────────────
// The table is append-only by trigger, so removing this run's rows needs the owner to disable it.
// Done so repeated local runs stay idempotent; CI runs against a fresh reset either way.
if (created.length) {
  await admin.query('ALTER TABLE public.account_scrub_operations DISABLE TRIGGER USER');
  await admin.query(`DELETE FROM public.account_scrub_operations WHERE id = ANY($1::uuid[])`, [created]);
  await admin.query('ALTER TABLE public.account_scrub_operations ENABLE TRIGGER USER');
}

await a.end(); await b.end(); await admin.end();

if (failures > 0) {
  console.error(`\n❌ u2 scrub claim race FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ u2 scrub claim race passed');
