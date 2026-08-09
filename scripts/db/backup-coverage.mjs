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
 *   PAGINATION PRECONDITION — every backed-up table has a single-column `id` primary key, because
 *     the backup keyset-walks on exactly that. A table with a composite or differently-named key
 *     would page wrongly, and silently: the walk would still return rows.
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
       OR c.relname IN ('persons', 'profiles', 'guest_players', 'person_links', 'membership_backfill_items')
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
                    WHERE i.indrelid = c.oid AND i.indisprimary), '(none)') AS pk
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

await c.end();

if (failures > 0) {
  console.error(`\n❌ backup coverage FAILED (${failures})`);
  process.exit(1);
}
console.log('\n✅ backup coverage passed');
