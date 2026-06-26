/**
 * Phase 4 F2a rehearsal (PGlite — real Postgres, no Docker): count_cycles_intakes returns one
 * GROUP BY row per cycle that HAS intakes, omits cycles with none, and handles empty input — the
 * exact contract getCyclesWithCounts / listRegistrationCycles will rely on.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const C1 = '40000000-0000-0000-0000-000000000001';
const C2 = '40000000-0000-0000-0000-000000000002';
const C3 = '40000000-0000-0000-0000-000000000003'; // no intakes

// Minimal schema the migration's objects reference (the index targets + the function's table).
await db.exec(`
  CREATE TABLE public.intake_requests (id serial PRIMARY KEY, cycle_id uuid);
  CREATE TABLE public.bookings (id serial PRIMARY KEY, slot_id uuid, status text);
  CREATE TABLE public.availability_slots (id serial PRIMARY KEY, cyclus_id uuid, trainer_id uuid);
`);

await db.exec(readFileSync('supabase/migrations/20260629120000_phase4_f2a_read_indexes.sql', 'utf8'));

await db.exec(`
  INSERT INTO public.intake_requests (cycle_id) VALUES
    ('${C1}'),('${C1}'),('${C1}'),   -- C1 → 3
    ('${C2}'),('${C2}');             -- C2 → 2
`);

let pass = 0,
  fail = 0;
const ok = (c, m, x) => {
  c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, x ?? ''));
};
const n = (rows, cid) => {
  const r = rows.find((row) => row.cycle_id === cid);
  return r ? Number(r.n) : undefined;
};

const rows = (
  await db.query(
    `SELECT cycle_id, n FROM public.count_cycles_intakes(ARRAY['${C1}','${C2}','${C3}']::uuid[])`,
  )
).rows;

ok(rows.length === 2, 'one row per cycle WITH intakes (the empty cycle is omitted by GROUP BY)', rows);
ok(n(rows, C1) === 3, 'C1 → 3', rows);
ok(n(rows, C2) === 2, 'C2 → 2', rows);
ok(n(rows, C3) === undefined, 'C3 (no intakes) → absent', rows);

const empty = (await db.query(`SELECT * FROM public.count_cycles_intakes(ARRAY[]::uuid[])`)).rows;
ok(empty.length === 0, 'empty cycle_ids → no rows', empty);

// only the requested cycles are returned (a 4th cycle's intakes are not leaked in)
await db.exec(`INSERT INTO public.intake_requests (cycle_id) VALUES ('40000000-0000-0000-0000-000000000099')`);
const scoped = (await db.query(`SELECT cycle_id FROM public.count_cycles_intakes(ARRAY['${C1}']::uuid[])`)).rows;
ok(scoped.length === 1 && scoped[0].cycle_id === C1, 'only requested cycle ids are returned', scoped);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
