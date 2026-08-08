/**
 * U1b GUARDRAIL — the backfill plan must be deterministic, and the applier must be resumable,
 * idempotent, bounded and reversible.
 *
 * Seeds the SHARED U1a fixture universe (so every evidence path and every terminal disposition is
 * present), builds a plan, and then attacks the applier with the failure modes that actually matter
 * for a backfill:
 *
 *   1. PARTITION + PLAN   — eligible ∪ unresolved = all candidates; the plan is exactly the DISTINCT
 *                           (academy, person) pairs among eligible, and nothing else.
 *   2. DETERMINISM        — two plans over unchanged data have the same plan_hash; artifacts are
 *                           byte-identical.
 *   3. UNRESOLVED NEVER WRITTEN — not one quarantined candidate reaches the table.
 *   4. RESUME             — killing the run at a batch boundary and resuming produces EXACTLY the
 *                           same final state as an uninterrupted run: no skipped tail, no double write.
 *   5. IDEMPOTENCE        — a second run over the same plan inserts nothing and records every pair as
 *                           already_present.
 *   6. DRIFT REFUSAL      — resuming with a changed plan is refused, not reconciled.
 *   7. ROLLBACK           — the data rollback removes exactly the rows the run inserted, keeps the
 *                           already_present ones, retains the log, and marks the run aborted; the
 *                           schema rollback refuses while the log is populated and succeeds once empty.
 *   8. LOCKDOWN           — after a full reset + seed both logbook tables are still default-deny.
 *
 * Everything runs against PGlite. Nothing here touches a remote database.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { mkdtempSync, readFileSync as readFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pgliteSessionSource } from './u1a-pglite-session.mjs';
import { runMembershipInventory } from './u1a-membership-inventory.mjs';
import { SCHEMA_STUB_SQL, FIXTURE_SQL, AS_OF, A1, A2, PE } from './u1a-fixture-universe.mjs';
import { buildBackfillPlan, ELIGIBLE_DISPOSITION } from './u1b-backfill-plan.mjs';
import { applyBackfillPlan } from './u1b-backfill-apply.mjs';
import { buildArtifacts, writeArtifacts } from './u1b-artifacts.mjs';

const U1A_MIGRATION = 'supabase/migrations/20261113100000_u1a_academy_player_memberships.sql';
const U1B_MIGRATION = 'supabase/migrations/20261114100000_u1b_membership_backfill_manifest.sql';
const ROLLBACK_ROWS = 'scripts/rollout/u1b/sql/rollback_u1b_backfill_rows.sql';
const ROLLBACK_SCHEMA = 'scripts/rollout/u1b/sql/rollback_u1b_manifest.sql';

let fail = 0;
const ok = (m, c, x) => {
  if (c) console.log('PASS', m);
  else { fail++; console.error('FAIL', m, JSON.stringify(x ?? '')); }
};

/** A fresh database seeded to the same starting point, so each scenario is independent. */
async function freshDb() {
  const db = new PGlite();
  await db.exec(SCHEMA_STUB_SQL);
  await db.exec(readFileSync(U1A_MIGRATION, 'utf8'));
  await db.exec(readFileSync(U1B_MIGRATION, 'utf8'));
  await db.exec(FIXTURE_SQL);
  return db;
}

const planFor = async (db) => {
  const inventory = await runMembershipInventory(pgliteSessionSource(db), { asOf: AS_OF });
  return { inventory, plan: buildBackfillPlan(inventory) };
};

// ══ 1. PARTITION + PLAN ═════════════════════════════════════════════════════════════════════════
const db1 = await freshDb();
const { inventory: inv1, plan: plan1 } = await planFor(db1);

ok('plan carries a hash and a version', typeof plan1.plan_hash === 'string' && plan1.plan_version === 'u1b.1');

const eligibleRows = inv1.report.dispositions.filter((r) => r.disposition === ELIGIBLE_DISPOSITION);
ok('reconciliation: eligible + unresolved = all candidates',
  plan1.reconciliation.eligible_candidates + plan1.reconciliation.unresolved_candidates === inv1.total_candidates,
  plan1.reconciliation);
ok('eligible candidate count matches the inventory',
  plan1.reconciliation.eligible_candidates === eligibleRows.length,
  { plan: plan1.reconciliation.eligible_candidates, inventory: eligibleRows.length });

const expectedPairs = new Set(eligibleRows.map((r) => `${r.academy_profile_id}|${r.person_id}`));
ok('plan is exactly the DISTINCT eligible (academy, person) pairs',
  plan1.rows.length === expectedPairs.size
  && plan1.rows.every((r) => expectedPairs.has(`${r.academy_profile_id}|${r.person_id}`)),
  { planned: plan1.rows.length, distinctEligible: expectedPairs.size });

ok('collision_delta accounts for eligible subjects that share a person',
  plan1.reconciliation.collision_delta === eligibleRows.length - plan1.rows.length,
  plan1.reconciliation);

// The unresolved histogram is DERIVED from the inventory, never enumerated in U1b — so a class U1a
// adds shows up here without touching this file.
ok('every non-eligible disposition appears in unresolved_by_class',
  Object.keys(inv1.disposition_counts)
    .filter((d) => d !== ELIGIBLE_DISPOSITION)
    .every((d) => d in plan1.reconciliation.unresolved_by_class),
  { classes: Object.keys(plan1.reconciliation.unresolved_by_class) });

ok('the plan is totally ordered by (academy, person)',
  plan1.rows.every((r, i) => i === 0 || (
    plan1.rows[i - 1].academy_profile_id < r.academy_profile_id
    || (plan1.rows[i - 1].academy_profile_id === r.academy_profile_id
      && plan1.rows[i - 1].person_id < r.person_id))));

// ══ 2. DETERMINISM ══════════════════════════════════════════════════════════════════════════════
const { plan: plan1b } = await planFor(db1);
ok('two plans over unchanged data share a plan_hash', plan1.plan_hash === plan1b.plan_hash,
  { a: plan1.plan_hash, b: plan1b.plan_hash });

const dirA = mkdtempSync(join(tmpdir(), 'u1b-a-'));
const dirB = mkdtempSync(join(tmpdir(), 'u1b-b-'));
const manA = writeArtifacts(dirA, buildArtifacts(inv1, plan1));
const manB = writeArtifacts(dirB, buildArtifacts(inv1, plan1b));
ok('artifact manifests agree file-for-file',
  JSON.stringify(manA.files) === JSON.stringify(manB.files), { a: manA.files, b: manB.files });
ok('artifact bytes are identical, not merely equivalent',
  ['plan.json', 'drift.json', 'anomalies.json'].every(
    (f) => readFile(join(dirA, f), 'utf8') === readFile(join(dirB, f), 'utf8')));
ok('drift artifact carries the quarantined identity classes',
  manA.files['drift.json'].bytes > 0
  && JSON.parse(readFile(join(dirA, 'drift.json'), 'utf8')).drifted_candidates.length > 0);
ok('anomaly artifact carries the structural classes',
  JSON.parse(readFile(join(dirA, 'anomalies.json'), 'utf8')).structurally_broken_candidates.length > 0);

// ══ 3. APPLY — small batches, then the invariants ═══════════════════════════════════════════════
const summary1 = await applyBackfillPlan(pgliteSessionSource(db1), { plan: plan1, batchSize: 2 });
ok('applier reports completion', summary1.status === 'completed', summary1);
ok('inserted exactly the planned number of rows', summary1.inserted === plan1.rows.length, summary1);
ok('bounded work per hop: more than one batch ran', summary1.batches > 1, summary1);
ok('manifest has one line per planned row', summary1.manifest_lines === plan1.rows.length, summary1);

const written = await db1.query(
  'SELECT academy_profile_id, person_id FROM public.academy_player_memberships ORDER BY 1,2');
ok('table content equals the plan',
  written.rows.length === plan1.rows.length
  && written.rows.every((r, i) => r.academy_profile_id === plan1.rows[i].academy_profile_id
    && r.person_id === plan1.rows[i].person_id),
  { wrote: written.rows.length, planned: plan1.rows.length });

// ── 3b. UNRESOLVED NEVER WRITTEN ────────────────────────────────────────────────────────────────
// Every quarantined candidate that HAS a person: its (academy, person) must be absent unless some
// OTHER eligible candidate legitimately produced that same pair.
const unresolvedPairs = inv1.report.dispositions
  .filter((r) => r.disposition !== ELIGIBLE_DISPOSITION && r.person_id)
  .map((r) => `${r.academy_profile_id}|${r.person_id}`)
  .filter((k) => !expectedPairs.has(k));
const writtenKeys = new Set(written.rows.map((r) => `${r.academy_profile_id}|${r.person_id}`));
ok('no purely-unresolved pair was written',
  unresolvedPairs.every((k) => !writtenKeys.has(k)),
  { leaked: unresolvedPairs.filter((k) => writtenKeys.has(k)) });
ok('there were unresolved pairs to leak (the check is not vacuous)', unresolvedPairs.length > 0,
  { count: unresolvedPairs.length });

// tenant isolation survives the write: A1 and A2 both relate to person PE(1), as two rows
const shared = await db1.query(
  'SELECT academy_profile_id FROM public.academy_player_memberships WHERE person_id = $1 ORDER BY 1',
  [PE(1)]);
ok('one Player at two academies produces two independent rows',
  shared.rows.length === 2
  && shared.rows.some((r) => r.academy_profile_id === A1)
  && shared.rows.some((r) => r.academy_profile_id === A2), shared.rows);

// ══ 4. IDEMPOTENCE ══════════════════════════════════════════════════════════════════════════════
const summary2 = await applyBackfillPlan(pgliteSessionSource(db1), { plan: plan1, batchSize: 3 });
ok('a second run inserts nothing', summary2.inserted === 0, summary2);
ok('a second run records every pair as already_present',
  summary2.already_present === plan1.rows.length, summary2);
const afterSecond = await db1.query('SELECT count(*)::int AS n FROM public.academy_player_memberships');
ok('a second run leaves the row count unchanged', afterSecond.rows[0].n === plan1.rows.length,
  afterSecond.rows[0]);

// ══ 5. RESUME — kill at a batch boundary, resume, compare with the uninterrupted run ════════════
const db2 = await freshDb();
const { plan: plan2 } = await planFor(db2);
ok('the independent database produces the same plan', plan2.plan_hash === plan1.plan_hash);

let killedRunId = null;
let killed = false;
try {
  await applyBackfillPlan(pgliteSessionSource(db2), {
    plan: plan2,
    batchSize: 2,
    onBatchCommitted: async ({ batchSeq, runId }) => {
      killedRunId = runId;
      // A crash at a CLEAN batch boundary: the batch is committed, the process dies before the next.
      if (batchSeq === 1) throw new Error('SIMULATED_CRASH');
    },
  });
} catch (err) {
  killed = err.message === 'SIMULATED_CRASH';
}
ok('the simulated crash actually fired', killed);

const midway = await db2.query('SELECT count(*)::int AS n FROM public.academy_player_memberships');
ok('a killed run leaves a PARTIAL table (so resume has real work)',
  midway.rows[0].n > 0 && midway.rows[0].n < plan2.rows.length, midway.rows[0]);
const midwayRun = await db2.query(
  'SELECT status FROM public.membership_backfill_runs WHERE id = $1', [killedRunId]);
ok('a killed run stays in_progress (aborting it would destroy resumability)',
  midwayRun.rows[0].status === 'in_progress', midwayRun.rows[0]);

const resumed = await applyBackfillPlan(pgliteSessionSource(db2), {
  plan: plan2, batchSize: 2, resumeRunId: killedRunId,
});
ok('resume completes the run', resumed.status === 'completed', resumed);
ok('resume skipped the work already done', resumed.already_done_on_entry > 0, resumed);

const resumedRows = await db2.query(
  'SELECT academy_profile_id, person_id FROM public.academy_player_memberships ORDER BY 1,2');
ok('RESUMED state equals UNINTERRUPTED state (no skipped tail, no double write)',
  JSON.stringify(resumedRows.rows) === JSON.stringify(written.rows),
  { resumed: resumedRows.rows.length, uninterrupted: written.rows.length });

const itemCount = await db2.query(
  'SELECT count(*)::int AS n FROM public.membership_backfill_items WHERE run_id = $1', [killedRunId]);
ok('the manifest holds exactly one line per planned row after resume',
  itemCount.rows[0].n === plan2.rows.length, itemCount.rows[0]);

// ══ 6. DRIFT REFUSAL ════════════════════════════════════════════════════════════════════════════
const db3 = await freshDb();
const { plan: plan3 } = await planFor(db3);
let drifted = null;
try {
  await applyBackfillPlan(pgliteSessionSource(db3), {
    plan: plan3,
    batchSize: 2,
    onBatchCommitted: async ({ batchSeq, runId }) => {
      killedRunId = runId;
      if (batchSeq === 0) throw new Error('STOP');
    },
  });
} catch { /* expected */ }

// The candidate set moves under the run: a brand-new eligible academy guest appears.
await db3.exec(`
  INSERT INTO public.persons VALUES ('${PE(120)}');
  INSERT INTO public.guest_players (id, academy_profile_id) VALUES ('cccc0120-0000-4000-8000-000000000000','${A1}');
  INSERT INTO public.person_links (person_id, guest_player_id)
    VALUES ('${PE(120)}','cccc0120-0000-4000-8000-000000000000');
  INSERT INTO public.academy_player_metadata (id, academy_profile_id, guest_player_id, person_id)
    VALUES ('88880120-0000-4000-8000-000000000000','${A1}','cccc0120-0000-4000-8000-000000000000','${PE(120)}');
`);
const { plan: plan3b } = await planFor(db3);
ok('the drifted plan really is different', plan3b.plan_hash !== plan3.plan_hash);

try {
  await applyBackfillPlan(pgliteSessionSource(db3), {
    plan: plan3b, batchSize: 2, resumeRunId: killedRunId,
  });
} catch (err) { drifted = err.code; }
ok('resuming with a drifted plan is REFUSED, not reconciled', drifted === 'PLAN_DRIFT', { drifted });

// ══ 7. ROLLBACK ═════════════════════════════════════════════════════════════════════════════════
// A pair written by "someone else" first, so the run records it already_present and must NOT own it.
const db4 = await freshDb();
const { plan: plan4 } = await planFor(db4);
const foreign = plan4.rows[0];
await db4.query(
  'INSERT INTO public.academy_player_memberships (academy_profile_id, person_id) VALUES ($1,$2)',
  [foreign.academy_profile_id, foreign.person_id]);

const summary4 = await applyBackfillPlan(pgliteSessionSource(db4), { plan: plan4, batchSize: 4 });
ok('a pre-existing pair is recorded already_present, not inserted',
  summary4.already_present === 1 && summary4.inserted === plan4.rows.length - 1, summary4);

await db4.exec(`SET u1b.run_id = '${summary4.run_id}'`);
await db4.exec(readFileSync(ROLLBACK_ROWS, 'utf8'));   // the REAL script, byte-for-byte

const afterRollback = await db4.query(
  'SELECT academy_profile_id, person_id FROM public.academy_player_memberships');
ok('data rollback removes every row the run inserted', afterRollback.rows.length === 1, afterRollback.rows);
ok('data rollback KEEPS the row the run did not create',
  afterRollback.rows[0].academy_profile_id === foreign.academy_profile_id
  && afterRollback.rows[0].person_id === foreign.person_id, afterRollback.rows[0]);

const logAfter = await db4.query(
  'SELECT count(*)::int AS n FROM public.membership_backfill_items WHERE run_id = $1', [summary4.run_id]);
ok('the manifest is RETAINED after a data rollback', logAfter.rows[0].n === plan4.rows.length, logAfter.rows[0]);
const runAfter = await db4.query(
  'SELECT status FROM public.membership_backfill_runs WHERE id = $1', [summary4.run_id]);
ok('the rolled-back run is marked aborted', runAfter.rows[0].status === 'aborted', runAfter.rows[0]);

let resumeAborted = null;
try {
  await applyBackfillPlan(pgliteSessionSource(db4), {
    plan: plan4, batchSize: 2, resumeRunId: summary4.run_id,
  });
} catch (err) { resumeAborted = err.code; }
ok('an aborted run cannot be resumed', resumeAborted === 'RUN_NOT_RESUMABLE', { resumeAborted });

// schema rollback must REFUSE while the logbook holds anything
let refused = false;
try { await db4.exec(readFileSync(ROLLBACK_SCHEMA, 'utf8')); } catch { refused = true; }
ok('schema rollback REFUSES while the logbook is populated', refused);

await db4.exec('DELETE FROM public.membership_backfill_items; DELETE FROM public.membership_backfill_runs;');
await db4.exec(readFileSync(ROLLBACK_SCHEMA, 'utf8'));
const gone = await db4.query(`SELECT to_regclass('public.membership_backfill_runs') AS r,
                                     to_regclass('public.membership_backfill_items') AS i,
                                     to_regclass('public.academy_player_memberships') AS m`);
ok('schema rollback drops both logbook tables once empty',
  gone.rows[0].r === null && gone.rows[0].i === null, gone.rows[0]);
ok('schema rollback leaves the U1a membership table alone', gone.rows[0].m !== null, gone.rows[0]);
ok('schema rollback is idempotent when already absent',
  await db4.exec(readFileSync(ROLLBACK_SCHEMA, 'utf8')).then(() => true, () => false));

// ══ 8. LOCKDOWN — the seed re-grants; the deny-list must re-revoke ══════════════════════════════
const db5 = await freshDb();
await db5.exec(readFileSync('supabase/seed.sql', 'utf8'));
const acl = await db5.query(`
  SELECT c.relname,
         count(*) FILTER (WHERE has_table_privilege(r.rolname, c.oid, 'SELECT')
                            OR has_table_privilege(r.rolname, c.oid, 'INSERT')
                            OR has_table_privilege(r.rolname, c.oid, 'UPDATE')
                            OR has_table_privilege(r.rolname, c.oid, 'DELETE'))::int AS granted
  FROM pg_class c
  CROSS JOIN (SELECT unnest(ARRAY['anon','authenticated','service_role']) AS rolname) r
  WHERE c.relname IN ('membership_backfill_runs','membership_backfill_items','academy_player_memberships')
  GROUP BY c.relname ORDER BY c.relname`);
ok('after a FULL seed all three tables are still default-deny for every app role',
  acl.rows.length === 3 && acl.rows.every((r) => r.granted === 0), acl.rows);
const rls = await db5.query(`
  SELECT relname, relrowsecurity,
         (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
  FROM pg_class c WHERE relname IN ('membership_backfill_runs','membership_backfill_items')
  ORDER BY relname`);
ok('both logbook tables have RLS on with zero policies',
  rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity === true && r.policies === 0), rls.rows);

// ══ done ════════════════════════════════════════════════════════════════════════════════════════
if (fail > 0) {
  console.error(`\n❌ U1b backfill rehearsal FAILED (${fail})`);
  process.exit(1);
}
console.log('\n✅ U1b plan + applier + rollback rehearsal passed');
