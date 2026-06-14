// Rehearsal for Phase 4/5 Batch A migrations:
//  - 20260614170000 availability_slots end_time > start_time CHECK (NOT VALID, but enforced on new writes)
//  - 20260614180000 cycles NULL-tolerant start_date <= end_date CHECK
//  - 20260614190000 cron single-flight advisory-lock RPCs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (c, m, x) => { c ? (pass++, console.log('PASS', m)) : (fail++, console.error('FAIL', m, JSON.stringify(x ?? ''))); };
const raises = async (sql) => { try { await db.exec(sql); return false; } catch { return true; } };

await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.availability_slots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), start_time timestamptz NOT NULL, end_time timestamptz NOT NULL);
  CREATE TABLE public.cycles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), start_date date, end_date date, is_always_open boolean DEFAULT false);
`);

// apply the three migrations
await db.exec(readFileSync('supabase/migrations/20260614170000_availability_slots_time_order_check.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260614180000_cycles_date_order_check.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260614190000_cron_single_flight_lock.sql', 'utf8'));

// ---- availability_slots CHECK (enforced on new writes despite NOT VALID) ----
ok(!(await raises(`INSERT INTO public.availability_slots (start_time, end_time) VALUES ('2026-06-14T10:00Z','2026-06-14T11:00Z')`)),
  'slots: forward interval (end>start) inserts OK', null);
ok(await raises(`INSERT INTO public.availability_slots (start_time, end_time) VALUES ('2026-06-14T11:00Z','2026-06-14T10:00Z')`),
  'slots: inverted interval (end<start) REJECTED', null);
ok(await raises(`INSERT INTO public.availability_slots (start_time, end_time) VALUES ('2026-06-14T10:00Z','2026-06-14T10:00Z')`),
  'slots: zero-length (end=start) REJECTED', null);

// ---- cycles CHECK (NULL-tolerant) ----
ok(!(await raises(`INSERT INTO public.cycles (start_date, end_date) VALUES ('2026-06-01','2026-08-31')`)),
  'cycles: start<=end inserts OK', null);
ok(!(await raises(`INSERT INTO public.cycles (start_date, end_date) VALUES ('2026-06-01','2026-06-01')`)),
  'cycles: single-day (start=end) inserts OK', null);
ok(!(await raises(`INSERT INTO public.cycles (start_date, end_date, is_always_open) VALUES (NULL, NULL, true)`)),
  'cycles: always-open (both NULL) inserts OK', null);
ok(!(await raises(`INSERT INTO public.cycles (start_date, end_date) VALUES ('2026-06-01', NULL)`)),
  'cycles: open-ended (end NULL) inserts OK', null);
ok(await raises(`INSERT INTO public.cycles (start_date, end_date) VALUES ('2026-08-31','2026-06-01')`),
  'cycles: end<start REJECTED', null);

// ---- cron single-flight RPCs ----
const tl = (await db.query(`SELECT public.try_lock_cron_job('process-onboarding-emails') AS v`)).rows[0].v;
ok(tl === true, 'try_lock_cron_job returns boolean true on first acquire', tl);
const ul = (await db.query(`SELECT public.unlock_cron_job('process-onboarding-emails') AS v`)).rows[0].v;
ok(ul === true, 'unlock_cron_job returns boolean true after release', ul);
// distinct keys are independent (different job names hash to different lock ids)
const tl2 = (await db.query(`SELECT public.try_lock_cron_job('invoice-health-check') AS v`)).rows[0].v;
ok(tl2 === true, 'try_lock_cron_job acquires an independent lock for a distinct job name', tl2);
await db.query(`SELECT public.unlock_cron_job('invoice-health-check')`);
// NOTE: PGlite is single-session so true cross-run contention (run B sees false)
// is validated against Supabase, not here — documented in the migration.

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
