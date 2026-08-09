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

// ── GROUPS ─────────────────────────────────────────────────────────────────────────────────────
const { rows: groupRows } = await c.query(`SELECT group_name, relname FROM public.backup_export_groups()`);
const grouped = groupRows.map((r) => r.relname);
const groupOf = new Map(groupRows.map((r) => [r.relname, r.group_name]));

if (grouped.length !== new Set(grouped).size) {
  fail('a table is in more than one export group — it would be backed up twice',
    grouped.filter((t, i) => grouped.indexOf(t) !== i));
} else {
  pass('every table is in exactly one export group');
}

const ungrouped = declared.filter((t) => !groupOf.has(t));
if (ungrouped.length) fail('backed-up tables that belong to no export group — they would never be exported', ungrouped);
else pass('every backed-up table belongs to an export group');

// the reason groups exist at all: the U1c rollback record must come from one snapshot
const rollbackFamily = ['academy_player_memberships', 'membership_backfill_runs', 'membership_backfill_items'];
const families = new Set(rollbackFamily.map((t) => groupOf.get(t)));
if (families.size !== 1 || families.has(undefined)) {
  fail('the U1c rollback tables are not in ONE group — an item could name a membership the backup lacks',
    rollbackFamily.map((t) => `${t}:${groupOf.get(t)}`));
} else {
  pass('the U1c rollback tables share one export group, so they come from one snapshot');
}

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

if (grants.length !== 6) fail('expected six backup_export functions', grants.map((g) => g.proname));
else pass('all six backup_export functions exist');

// STABLE is load-bearing on the exports: a VOLATILE function takes a FRESH snapshot per query in
// READ COMMITTED, which would put a group's tables back on different snapshots and undo the only
// reason groups exist.
const { rows: vol } = await c.query(`
  SELECT p.proname, p.provolatile
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN ('backup_export_group', 'backup_export_table')`);
const notStable = vol.filter((v) => v.provolatile !== 's');
if (notStable.length) {
  fail('the export functions must be STABLE or a group shares no snapshot',
    notStable.map((v) => `${v.proname}:${v.provolatile}`));
} else {
  pass('both export functions are STABLE, so every query inside them uses one snapshot');
}

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

  const viaFn = await probe(`SELECT public.backup_export_table('academy_player_memberships') AS r`);
  ok_(viaFn.ok, 'the same read THROUGH backup_export_table succeeds as service_role', viaFn);

  const viaGroup = await probe(`SELECT public.backup_export_group('u1c_membership') AS r`);
  ok_(viaGroup.ok && Object.keys(viaGroup.rows?.[0]?.r ?? {}).length === 3,
    'the whole U1c rollback group exports in ONE call as service_role',
    { ok: viaGroup.ok, tables: Object.keys(viaGroup.rows?.[0]?.r ?? {}) });

  const badGroup = await probe(`SELECT public.backup_export_group('not_a_group')`);
  ok_(!badGroup.ok && String(badGroup.message).includes('BACKUP_EXPORT_NOT_ALLOWED'),
    'an unknown group is refused, not silently empty', badGroup);

  // it refuses anything not on the list rather than exporting whatever it is handed. Three shapes:
  // a real table the backup has no business reading, a catalogue relation, and a migration table.
  for (const rel of ['user_sessions', 'pg_shadow', 'schema_migrations']) {
    const r = await probe(`SELECT public.backup_export_table($1)`, [rel]);
    ok_(!r.ok && String(r.message).includes('BACKUP_EXPORT_NOT_ALLOWED'),
      `an unlisted relation (${rel}) is refused, not exported`, r);
  }

  await c.query('ROLLBACK');
}

// ── THE EXPORT ITSELF, against real Postgres ───────────────────────────────────────────────────
// The Deno tests stub the export, and a stub cannot notice the real function breaking its own
// promises. This runs it: rows inserted out of id order, in a transaction that is rolled back.
{
  await c.query('BEGIN');
  const N = 250;
  await c.query(`
    INSERT INTO public.persons (id, full_name)
    SELECT gen_random_uuid(), 'u1c-p4-export-' || g FROM generate_series(1, $1) g`, [N]);

  const { rows: [{ r }] } = await c.query(`SELECT public.backup_export_table('persons') AS r`);
  const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM public.persons`);

  ok_(r.rows.length === Number(n) && r.row_count === Number(n),
    'the export returns every row, and its own count agrees',
    { rows: r.rows.length, row_count: r.row_count, inTable: Number(n) });

  const ids = r.rows.map((x) => x.id);
  const sorted = [...ids].sort();
  ok_(ids.every((v, i2) => v === sorted[i2]),
    'the export is ordered by id, so two exports of an unchanged table are byte-identical');
  ok_(new Set(ids).size === ids.length, 'no row appears twice');

  // an empty table exports as an empty array, not null — a restore must not have to special-case it
  const { rows: [{ e }] } = await c.query(`SELECT public.backup_export_table('academy_player_tags') AS e`);
  ok_(Array.isArray(e.rows) && e.rows.length === 0 && e.row_count === 0,
    'an empty table exports as [] with a zero count, not null', e);

  await c.query('ROLLBACK');
}

// The size bound is refused rather than attempted: a jsonb aggregate that cannot fit should fail
// with a sentence an operator can act on, not as an out-of-memory in the middle of the night.
// Exercised by LOWERING the bound rather than by making a table enormous — function DDL is
// transactional in Postgres, so the real bound is restored by the rollback.
{
  const { rows: [{ m }] } = await c.query(`SELECT public.backup_export_max_rows() AS m`);
  ok_(Number(m) > 0 && Number(m) <= 5_000_000, 'the export declares a row bound', { max: Number(m) });

  await c.query('BEGIN');
  await c.query(`
    CREATE OR REPLACE FUNCTION public.backup_export_max_rows() RETURNS bigint
    LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
    AS $fn$ SELECT 1::bigint $fn$`);
  await c.query(`INSERT INTO public.persons (id, full_name)
                 SELECT gen_random_uuid(), 'u1c-p4-bound-' || g FROM generate_series(1, 3) g`);
  let bounded = null;
  try { await c.query(`SELECT public.backup_export_table('persons')`); }
  catch (e) { bounded = e.message; }
  ok_(bounded !== null && bounded.includes('BACKUP_EXPORT_TOO_LARGE'),
    'a table above the bound is refused with a reason, not attempted', { bounded });
  await c.query('ROLLBACK');

  const { rows: [{ m2 }] } = await c.query(`SELECT public.backup_export_max_rows() AS m2`);
  ok_(Number(m2) === Number(m), 'the real row bound survives the probe', { before: Number(m), after: Number(m2) });

  // and the BYTE bound, which is the one that matters: these tables carry unbounded text and jsonb,
  // so a row count cannot tell you whether the aggregate will fit
  const { rows: [{ b }] } = await c.query(`SELECT public.backup_export_max_bytes() AS b`);
  ok_(Number(b) > 0, 'the export declares a byte bound', { max: Number(b) });

  await c.query('BEGIN');
  await c.query(`
    CREATE OR REPLACE FUNCTION public.backup_export_max_bytes() RETURNS bigint
    LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
    AS $fn$ SELECT 1::bigint $fn$`);
  await c.query(`INSERT INTO public.persons (id, full_name)
                 SELECT gen_random_uuid(), 'u1c-p4-bytes-' || g FROM generate_series(1, 3) g`);
  let byBytes = null;
  try { await c.query(`SELECT public.backup_export_table('persons')`); }
  catch (e) { byBytes = e.message; }
  ok_(byBytes !== null && byBytes.includes('BACKUP_EXPORT_TOO_LARGE') && byBytes.includes('bytes'),
    'a table above the BYTE bound is refused with a reason, not attempted', { byBytes });
  await c.query('ROLLBACK');

  const { rows: [{ b2 }] } = await c.query(`SELECT public.backup_export_max_bytes() AS b2`);
  ok_(Number(b2) === Number(b), 'the real byte bound survives the probe', { before: Number(b), after: Number(b2) });
}

await c.end();

if (failures > 0) {
  console.error(`\n❌ backup coverage FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ backup coverage passed');
