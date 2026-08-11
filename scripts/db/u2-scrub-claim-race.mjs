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
 * THE TRIGGER IS NEVER DISABLED IN A COMMITTED WINDOW. Staging an expired lease needs the guard
 * off, because the guard owns that column. `ALTER TABLE ... DISABLE TRIGGER` is transactional in
 * PostgreSQL, so every such window is opened and closed inside ONE transaction: no other session
 * ever sees the table unguarded, and any error — including one injected by the fault switch below —
 * rolls the disable back rather than leaking it. Nothing here is left to a happy path.
 *
 * `U2_RACE_FAULT=<stage>` raises at a chosen point so the recovery path can be proven rather than
 * asserted. It is test-only scaffolding for exactly that; unset, it does nothing.
 *
 * LOCAL ONLY — the connection string is hardcoded to 127.0.0.1:54322 and nothing here reads a
 * credential.
 */
import pg from 'pg';

// application_name tags this run's three sessions so they can be told apart from the stack's own
// pooled backends — PostgREST, for one, sits idle in a transaction holding its schema cache.
const CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?application_name=u2-scrub-claim-race';
const TABLE = 'public.account_scrub_operations';

/** Test-only fault injection. See the header. */
const FAULT = process.env.U2_RACE_FAULT ?? '';
const faultIf = (stage) => {
  if (FAULT === stage) throw new Error(`U2_RACE_FAULT: injected failure at "${stage}"`);
};

let failures = 0;
const fail = (msg, detail) => { failures++; console.error('FAIL', msg, detail ?? ''); };
const pass = (msg) => console.log('PASS', msg);
const ok_ = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

const a = new pg.Client({ connectionString: CONN });
const b = new pg.Client({ connectionString: CONN });
const admin = new pg.Client({ connectionString: CONN });
await a.connect(); await b.connect(); await admin.connect();

/** Rows this run created, recorded the instant they exist so an error cannot leak one. */
const created = [];

/**
 * Open the guard-off window and close it inside ONE transaction, so a failure rolls the disable
 * back instead of committing an unguarded table.
 */
async function withGuardDisabled(client, fn) {
  await client.query('BEGIN');
  try {
    await client.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER USER`);
    const out = await fn();
    await client.query(`ALTER TABLE ${TABLE} ENABLE TRIGGER USER`);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // ROLLBACK restores tgenabled with everything else — that is why the DDL is in here at all
    try { await client.query('ROLLBACK'); } catch { /* the failure below is the one that matters */ }
    throw err;
  }
}

try {
  /** A fresh operation, carried to `database_scrubbed` so a claim is the next legal step. */
  async function scrubbedOperation() {
    const { rows: [row] } = await admin.query(`
      INSERT INTO ${TABLE} (command_id, subject_user_id, actor_user_id, self_service)
      VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), false)
      RETURNING id`);
    created.push(row.id);          // recorded BEFORE anything else can throw
    faultIf('after-insert');
    await admin.query(
      `UPDATE ${TABLE} SET state = 'database_scrubbed', subject_person_id = gen_random_uuid()
        WHERE id = $1`, [row.id]);
    return row.id;
  }

  /** Age a lease without waiting five real minutes. The guard owns the column, so it must be off. */
  const stageExpiredLease = (id) => withGuardDisabled(admin, async () => {
    await admin.query(
      `UPDATE ${TABLE} SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
      [id]);
    faultIf('inside-guard-window');
    // Test-only: hold the window open so another session can check what it can SEE. The window is
    // inside a transaction, so a concurrent session must observe the trigger still ENABLED — that
    // is the property, and it is not provable by looking at the state after the fact.
    if (FAULT === 'hold-guard-window') await new Promise((r) => setTimeout(r, 1500));
  });

  /** Wait until the client is genuinely blocked on a lock, rather than merely slow. */
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

  const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

  /** Stage a race: A holds the row, B queues behind it, A commits, B's statement is judged. */
  async function race(id, tokenA, tokenB, label) {
    const claim = (client, token) => client.query(
      `UPDATE ${TABLE} SET state = 'external_cleanup_in_progress', lease_token = $2 WHERE id = $1`,
      [id, token]);

    await a.query('BEGIN');
    await claim(a, tokenA);

    await b.query('BEGIN');
    const pending = claim(b, tokenB).then(() => ({ ok: true }), (e) => ({ ok: false, message: e.message }));

    const staged = await waitUntilBlocked(bPid, label);
    await a.query('COMMIT');
    const result = await pending;
    await b.query('ROLLBACK');
    return { staged, result };
  }

  // ── 1. two workers claim the same freshly scrubbed operation ─────────────────────────────────
  {
    const id = await scrubbedOperation();
    const tokenA = '11111111-1111-4111-8111-111111111111';
    const tokenB = '22222222-2222-4222-8222-222222222222';
    const { staged, result } = await race(id, tokenA, tokenB, 'the second claimant');
    faultIf('after-claim-race');

    ok_(staged && !result.ok, 'the second concurrent claim is REFUSED, not silently applied', result);
    ok_(!result.ok && /only an expired lease may be reclaimed/.test(result.message ?? ''),
      '...and it is refused by the state machine, as an unexpired lease it may not reclaim',
      { message: result.message });

    const { rows: [held] } = await admin.query(
      `SELECT lease_token::text AS token, external_attempt_count::int AS attempts, state
         FROM ${TABLE} WHERE id = $1`, [id]);
    ok_(held.token === tokenA && held.attempts === 1 && held.state === 'external_cleanup_in_progress',
      'exactly one worker holds the operation, and the attempt was counted exactly once', held);
  }

  // ── 2. two workers reclaim the same EXPIRED lease ────────────────────────────────────────────
  {
    const id = await scrubbedOperation();
    await admin.query(
      `UPDATE ${TABLE} SET state = 'external_cleanup_in_progress', lease_token = gen_random_uuid()
        WHERE id = $1`, [id]);
    await stageExpiredLease(id);

    const tokenA = '33333333-3333-4333-8333-333333333333';
    const tokenB = '44444444-4444-4444-8444-444444444444';
    const { staged, result } = await race(id, tokenA, tokenB, 'the second reclaimer');

    ok_(staged && !result.ok, 'two workers reclaiming one expired lease: the second is refused', result);
    ok_(!result.ok && /only an expired lease may be reclaimed/.test(result.message ?? ''),
      '...because the first reclaim already made the lease fresh', { message: result.message });

    const { rows: [held] } = await admin.query(
      `SELECT lease_token::text AS token, external_attempt_count::int AS attempts
         FROM ${TABLE} WHERE id = $1`, [id]);
    ok_(held.token === tokenA && held.attempts === 2,
      'the attempt counter advanced ONCE, not once per racing worker', held);

    // ...and the WINNER can still work. A refusal that leaves the row unusable would be a wedge
    // wearing the clothes of a guard. The loser is not used here: its statement was rejected and
    // its transaction rolled back, so it holds nothing to exercise — see section 3.
    await admin.query(`UPDATE ${TABLE} SET auth_deleted_at = clock_timestamp() WHERE id = $1`, [id]);
    await admin.query(
      `UPDATE ${TABLE} SET state = 'database_scrubbed', last_error_code = 'asset_retryable'
        WHERE id = $1`, [id]);
    const { rows: [after] } = await admin.query(
      `SELECT state, next_attempt_at > clock_timestamp() AS backing_off FROM ${TABLE} WHERE id = $1`,
      [id]);
    ok_(after.state === 'database_scrubbed' && after.backing_off === true,
      'the winner of the race can still progress and release afterwards', after);
  }

  // ── 3. release keeps the recorded outcome and comes back on a database-set backoff ────────────
  // NOT a race: single session, no contention. It is here because the release path is what a
  // refused-or-crashed worker's successor depends on, and section 2's loser holds nothing to
  // exercise it with.
  {
    const id = await scrubbedOperation();
    await admin.query(
      `UPDATE ${TABLE} SET state = 'external_cleanup_in_progress', lease_token = gen_random_uuid()
        WHERE id = $1`, [id]);
    await admin.query(`UPDATE ${TABLE} SET auth_deleted_at = clock_timestamp() WHERE id = $1`, [id]);
    await admin.query(
      `UPDATE ${TABLE} SET state = 'database_scrubbed', last_error_code = 'asset_retryable'
        WHERE id = $1`, [id]);
    const { rows: [r] } = await admin.query(
      `SELECT state, next_attempt_at > clock_timestamp() AS backing_off,
              auth_deleted_at IS NOT NULL AS auth_recorded
         FROM ${TABLE} WHERE id = $1`, [id]);
    ok_(r.state === 'database_scrubbed' && r.backing_off === true && r.auth_recorded === true,
      'a released operation keeps its recorded outcome and comes back on a database-set backoff', r);
  }

  faultIf('before-cleanup');
} finally {
  // Whatever happened above — assertion failure, injected fault, thrown query — no session may be
  // left holding a transaction, no row may be left behind, and no client may be left open.
  for (const [client, label] of [[a, 'A'], [b, 'B'], [admin, 'admin']]) {
    try {
      await client.query('ROLLBACK');   // a no-op outside a transaction, by design
    } catch (err) {
      console.error(`cleanup: could not roll back session ${label}: ${err.message}`);
    }
  }

  if (created.length) {
    try {
      // Append-only by trigger, so removing this run's rows needs the guard off — transactionally,
      // exactly as when it was staged.
      await withGuardDisabled(admin, () =>
        admin.query(`DELETE FROM ${TABLE} WHERE id = ANY($1::uuid[])`, [created]));
    } catch (err) {
      failures++;
      console.error(`FAIL cleanup could not remove ${created.length} row(s): ${err.message}`);
    }
  }

  for (const client of [a, b, admin]) {
    try { await client.end(); } catch { /* already closed or never opened */ }
  }
}

if (failures > 0) {
  console.error(`\n❌ u2 scrub claim race FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ u2 scrub claim race passed');
