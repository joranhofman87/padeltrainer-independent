#!/usr/bin/env node
/**
 * The backup's table list, checked against the schema instead of against someone's memory.
 *
 * `academy_player_memberships` shipped in U1a and was not in the backup list. Nothing noticed,
 * because a hand-maintained list has no way to notice — which is the same failure mode this
 * programme has hit repeatedly, and the same answer: derive it.
 *
 * Two properties are asserted here.
 *
 *   COVERAGE — every table carrying canonical identity or academy-private Player data is backed up,
 *     or is listed below with a reason. A new person-keyed table fails this by default; being
 *     forgotten is not an option the schema allows any more.
 *
 *   PAGINATION PRECONDITION — every backed-up table has a single-column `id` primary key of type
 *     uuid, because the backup keyset-walks on exactly that and `backup_export_page` takes a uuid
 *     cursor. A table with a composite, differently-named or differently-typed key would page
 *     wrongly, and silently: the walk would still return rows.
 *
 *   ALLOW-LIST AGREEMENT — the edge function's list and the database's `backup_export_tables()`
 *     allow-list name the same tables. They are two halves of one decision: a table in the edge
 *     list but not the allow-list is permission denied every night, and one in the allow-list but
 *     not the edge list is an export capability nobody asked for.
 *
 * Runs in `migrations.yml` after `supabase db reset`, against the real local schema. LOCAL ONLY —
 * the connection string is hardcoded to 127.0.0.1:54322 and nothing here reads a credential.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';

const CONN = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const SOURCE = 'supabase/functions/backup-database/index.ts';

/**
 * Tables that are identity-adjacent but deliberately NOT backed up. Each needs a reason that says
 * why losing it is recoverable — "it's big" is not one.
 */
const EXCLUDED = new Map([
  ['notification_outbox', 'transient queue state: rows are re-derivable from their source events, and a restored outbox would re-send. Consent lives in notification_contacts, which IS backed up.'],
]);

let failures = 0;
const fail = (msg, detail) => { failures++; console.error('FAIL', msg, detail ?? ''); };
const pass = (msg) => console.log('PASS', msg);
const ok_ = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

// ── the declared list, read out of the edge function itself ────────────────────────────────────
const src = readFileSync(SOURCE, 'utf8');
const block = src.match(/export const TABLES_TO_BACKUP = \[([\s\S]*?)\] as const;/);
if (!block) {
  console.error(`FAIL could not find TABLES_TO_BACKUP in ${SOURCE} — the guard cannot verify what it cannot read`);
  process.exit(1);
}
const declared = [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
const declaredSet = new Set(declared);

if (declared.length !== declaredSet.size) {
  fail('TABLES_TO_BACKUP contains duplicates', declared.filter((t, i) => declared.indexOf(t) !== i));
} else {
  pass(`TABLES_TO_BACKUP declares ${declared.length} distinct tables`);
}

const c = new pg.Client({ connectionString: CONN });
await c.connect();

// ── COVERAGE ───────────────────────────────────────────────────────────────────────────────────
// The identity family, derived: anything that names a person, plus the academy-private Player
// tables, plus the identity roots themselves.
const { rows: family } = await c.query(`
  SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
     AND (
       EXISTS (SELECT 1 FROM pg_attribute a
                WHERE a.attrelid = c.oid AND NOT a.attisdropped AND a.attname LIKE '%person_id')
       OR c.relname LIKE 'academy_player%'
       -- both halves of the U1b manifest: items reference a run, and the run carries the plan hash
       -- and completion state that says whether a backfill may be resumed or must be abandoned
       OR c.relname IN ('persons', 'profiles', 'guest_players', 'person_links',
                        'membership_backfill_runs', 'membership_backfill_items')
     )
   ORDER BY 1`);

const missing = family.map((r) => r.relname)
  .filter((t) => !declaredSet.has(t) && !EXCLUDED.has(t));

if (missing.length) {
  fail('identity/Player tables are not backed up', missing);
  console.error('      add them to TABLES_TO_BACKUP, or to EXCLUDED here with a reason that says why losing them is recoverable');
} else {
  pass(`every one of the ${family.length} identity/Player tables is backed up or excluded with a reason`);
}

// An exclusion for a table that no longer exists is a stale exemption pretending to be a decision.
const gone = [...EXCLUDED.keys()].filter((t) => !family.some((r) => r.relname === t));
if (gone.length) fail('EXCLUDED names tables that are not in the identity family any more', gone);
else pass('every exclusion still refers to a real identity-family table');

// ── PAGINATION PRECONDITION ────────────────────────────────────────────────────────────────────
const { rows: keys } = await c.query(`
  SELECT c.relname,
         (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) AS has_pk,
         coalesce((SELECT string_agg(a.attname, ',' ORDER BY x.ord)
                     FROM pg_index i
                     JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
                     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.attnum
                    WHERE i.indrelid = c.oid AND i.indisprimary), '(none)') AS pk,
         (SELECT format_type(a.atttypid, NULL) FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped) AS pk_type
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])
   ORDER BY 1`, [declared]);

const unknown = declared.filter((t) => !keys.some((k) => k.relname === t));
if (unknown.length) fail('TABLES_TO_BACKUP names tables that do not exist', unknown);
else pass('every declared table exists');

const badKey = keys.filter((k) => k.pk !== 'id');
if (badKey.length) {
  fail('backed-up tables whose primary key is not a single `id` column — the keyset walk would page them wrongly',
    badKey.map((k) => `${k.relname}:${k.pk}`));
} else {
  pass(`all ${keys.length} backed-up tables keyset-page on a single id primary key`);
}

const badType = keys.filter((k) => k.pk === 'id' && k.pk_type !== 'uuid');
if (badType.length) {
  fail('backed-up tables whose `id` is not uuid — backup_export_page takes a uuid cursor',
    badType.map((k) => `${k.relname}:${k.pk_type}`));
} else {
  pass('every backed-up id is a uuid, which is what the export cursor takes');
}

// ── ALLOW-LIST AGREEMENT ───────────────────────────────────────────────────────────────────────
const { rows: allowed } = await c.query(`SELECT relname FROM public.backup_export_tables() ORDER BY 1`);
const allowedSet = new Set(allowed.map((r) => r.relname));

const notAllowed = declared.filter((t) => !allowedSet.has(t));
if (notAllowed.length) {
  fail('tables the backup exports that backup_export_tables() will refuse — permission denied every night', notAllowed);
} else {
  pass('every backed-up table is allow-listed by backup_export_tables()');
}

const unusedAllowance = [...allowedSet].filter((t) => !declaredSet.has(t));
if (unusedAllowance.length) {
  fail('tables the database will export that nothing backs up — an export capability nobody asked for', unusedAllowance);
} else {
  pass('the allow-list grants nothing the backup does not use');
}

// The export functions must be reachable by the backup, and by nobody else.
const { rows: grants } = await c.query(`
  SELECT p.proname,
         has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
         has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname LIKE 'backup_export%'
   ORDER BY 1`);

if (grants.length !== 3) fail('expected three backup_export functions', grants.map((g) => g.proname));
else pass('all three backup_export functions exist');

const leaked = grants.filter((g) => g.anon || g.authenticated);
if (leaked.length) fail('backup_export functions reachable by anon/authenticated', leaked.map((g) => g.proname));
else pass('no backup_export function is reachable by anon or authenticated');

const unreachable = grants.filter((g) => !g.service_role);
if (unreachable.length) fail('backup_export functions the backup itself cannot call', unreachable.map((g) => g.proname));
else pass('the backup can execute all three');

// ── AND IT ACTUALLY WORKS AS service_role ──────────────────────────────────────────────────────
// The reason this whole path exists: `academy_player_memberships` and both manifest tables REVOKE
// ALL from service_role, and BYPASSRLS does not bypass table privileges. Asserting the grant shape
// is not the same as proving the read succeeds, so this runs as the role the backup runs as.
{
  const closed = [];
  for (const t of ['academy_player_memberships', 'membership_backfill_runs', 'membership_backfill_items']) {
    const { rows: [p] } = await c.query(
      `SELECT has_table_privilege('service_role', to_regclass('public.' || $1), 'SELECT') AS can`, [t]);
    if (!p.can) closed.push(t);
  }
  if (closed.length !== 3) {
    fail('these tables no longer revoke service_role — the privileged export path may be unnecessary now', closed);
  } else {
    pass('the membership tables still revoke service_role, which is why the export path exists');
  }

  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE service_role');

  // Each probe gets its own savepoint: a statement that is SUPPOSED to fail aborts the transaction,
  // and every later probe would then report that abort instead of its own result — three failures
  // for one cause, and two of them lies.
  const probe = async (sql, params = []) => {
    await c.query('SAVEPOINT p');
    try {
      const r = await c.query(sql, params);
      await c.query('RELEASE SAVEPOINT p');
      return { ok: true, rows: r.rows };
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT p');
      return { ok: false, code: e.code, message: e.message };
    }
  };

  const direct = await probe('SELECT 1 FROM public.academy_player_memberships LIMIT 1');
  ok_(!direct.ok && direct.code === '42501',
    'a DIRECT read of academy_player_memberships as service_role is denied', direct);

  const viaCount = await probe(`SELECT public.backup_export_count('academy_player_memberships') AS n`);
  const viaPage = await probe(`SELECT public.backup_export_page('academy_player_memberships', NULL, 10)`);
  ok_(viaCount.ok && viaPage.ok,
    'the same read THROUGH backup_export_* succeeds as service_role', { viaCount, viaPage });

  // and it refuses anything not on the list, rather than exporting whatever it is handed. Two
  // shapes: a real table the backup has no business reading, and a catalogue relation.
  for (const rel of ['user_sessions', 'pg_shadow', 'schema_migrations']) {
    const r = await probe(`SELECT public.backup_export_page($1, NULL, 10)`, [rel]);
    ok_(!r.ok && String(r.message).includes('BACKUP_EXPORT_NOT_ALLOWED'),
      `an unlisted relation (${rel}) is refused, not exported`, r);
  }

  const badLimit = await probe(`SELECT public.backup_export_page('persons', NULL, 100000)`);
  ok_(!badLimit.ok && String(badLimit.message).includes('BACKUP_EXPORT_BAD_LIMIT'),
    'an unbounded page size is refused', badLimit);

  await c.query('ROLLBACK');
}

// ── THE PAGE WALK ITSELF, against real Postgres ────────────────────────────────────────────────
// The Deno tests stub the export, and a stub that sorts because the real function promises to sort
// cannot notice the promise being broken. Dropping `ORDER BY t.id` from `backup_export_page` passed
// every one of them. PostgREST and Postgres guarantee no row order without an explicit sort, and a
// keyset walk over unordered pages silently skips rows — so the walk is exercised here, on rows
// deliberately inserted out of id order, in a transaction that is rolled back.
{
  await c.query('BEGIN');
  const N = 250, PAGE = 40;
  await c.query(`
    INSERT INTO public.persons (id, full_name)
    SELECT gen_random_uuid(), 'u1c-p4-walk-' || g FROM generate_series(1, $1) g`, [N]);

  const seen = [];
  let after = null, pages = 0;
  for (;;) {
    const { rows } = await c.query(
      `SELECT (r->>'id') AS id FROM public.backup_export_page('persons', $1::uuid, $2) r`,
      [after, PAGE]);
    pages++;
    seen.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].id;
    if (pages > 100) break;      // a walk that will not terminate must not hang the guard
  }

  const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM public.persons`);
  ok_(seen.length === Number(n), 'the real page walk returns every row exactly once',
    { walked: seen.length, inTable: Number(n), pages });
  ok_(new Set(seen).size === seen.length, 'the real page walk returns no row twice',
    { walked: seen.length, distinct: new Set(seen).size });

  const sorted = [...seen].sort();
  ok_(seen.every((v, i) => v === sorted[i]),
    'the real page walk returns rows in id order, which is what makes the cursor sound');

  await c.query('ROLLBACK');
}

await c.end();

if (failures > 0) {
  console.error(`\n❌ backup coverage FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ backup coverage passed');
