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
await db.exec(readFileSync('supabase/migrations/20260614200000_cron_lock_revoke_authenticated.sql', 'utf8'));
await db.exec(readFileSync('supabase/migrations/20260614220000_validate_date_order_checks.sql', 'utf8'));
// 10c-b: retires the two advisory-lock RPCs above and installs the durable lease.
await db.exec(readFileSync('supabase/migrations/20261007100000_cron_durable_lease.sql', 'utf8'));

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

// ---- VALIDATE migration validated both CHECKs (empty tables → 0 violators) ----
const conv = (await db.query(
  `SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('availability_slots_time_order_check','cycles_date_order_check') ORDER BY conname`,
)).rows;
ok(conv.length === 2 && conv.every((c) => c.convalidated === true),
  'both date-order CHECKs are VALIDATED after 20260614220000', conv);

// ---- cron single-flight: the DURABLE LEASE (20261007100000) ----
// The session-scoped try_lock_cron_job/unlock_cron_job pair was DROPPED in 10c-b
// (CRON-SF-WEDGE: its unlock could land on a different pooled backend than the
// lock and wedge the job). What follows rehearses the replacement, whose whole
// point is that exclusion and expiry are DATA — so unlike the advisory lock it is
// fully observable from a single session, which is all PGlite can offer.
const gone = (await db.query(
  `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('try_lock_cron_job','unlock_cron_job')`,
)).rows[0].n;
ok(gone === 0, 'the session-scoped advisory cron-lock RPCs are GONE (wedge class retired)', gone);

const t1 = (await db.query(`SELECT public.acquire_cron_lease('process-onboarding-emails', 900) AS v`)).rows[0].v;
ok(typeof t1 === 'string' && t1.length === 36, 'acquire_cron_lease returns an owner token on first acquire', t1);
// a SECOND acquire while the lease is live must refuse — this is the single-flight
const t1b = (await db.query(`SELECT public.acquire_cron_lease('process-onboarding-emails', 900) AS v`)).rows[0].v;
ok(t1b === null, 'a second acquire while the lease is LIVE returns NULL (single-flight holds)', t1b);
// a WRONG owner cannot release someone else's lease
const wrong = (await db.query(
  `SELECT public.release_cron_lease('process-onboarding-emails', gen_random_uuid()) AS v`)).rows[0].v;
ok(wrong === false, 'a wrong owner token CANNOT release another run\'s lease', wrong);
const stillHeld = (await db.query(`SELECT public.acquire_cron_lease('process-onboarding-emails', 900) AS v`)).rows[0].v;
ok(stillHeld === null, 'the lease survives the wrong-owner release attempt', stillHeld);
// the true owner releases, and the job becomes acquirable again
const rel = (await db.query(
  `SELECT public.release_cron_lease('process-onboarding-emails', $1) AS v`, [t1])).rows[0].v;
ok(rel === true, 'the true owner CAN release its own lease', rel);
const t1c = (await db.query(`SELECT public.acquire_cron_lease('process-onboarding-emails', 900) AS v`)).rows[0].v;
ok(typeof t1c === 'string', 'after release the job is acquirable again', t1c);
await db.query(`SELECT public.release_cron_lease('process-onboarding-emails', $1)`, [t1c]);

// distinct job names are independent
const t2 = (await db.query(`SELECT public.acquire_cron_lease('invoice-health-check', 900) AS v`)).rows[0].v;
ok(typeof t2 === 'string', 'a distinct job name leases independently', t2);
await db.query(`SELECT public.release_cron_lease('invoice-health-check', $1)`, [t2]);

// EXPIRY IS DATA: an abandoned (crashed) lease frees the job with no session
// involvement at all — the property the advisory lock could not offer.
const t3 = (await db.query(`SELECT public.acquire_cron_lease('crash-sim', 60) AS v`)).rows[0].v;
await db.query(`UPDATE public.cron_job_leases SET locked_until = now() - interval '1 second' WHERE job_name='crash-sim'`);
const afterExpiry = (await db.query(`SELECT public.acquire_cron_lease('crash-sim', 60) AS v`)).rows[0].v;
ok(typeof afterExpiry === 'string' && afterExpiry !== t3,
  'an EXPIRED lease is re-acquirable by a new owner (a crash cannot wedge the job)', afterExpiry);
// the crashed run's stale token is now powerless
const staleRenew = (await db.query(`SELECT public.renew_cron_lease('crash-sim', $1, 60) AS v`, [t3])).rows[0].v;
ok(staleRenew === false, 'a stale token cannot renew a lease that has moved on', staleRenew);
await db.query(`SELECT public.release_cron_lease('crash-sim', $1)`, [afterExpiry]);

// a nonsense TTL must RAISE rather than hand out an already-expired lease
ok(await raises(`SELECT public.acquire_cron_lease('ttl-test', 0)`),
  'a zero TTL is REJECTED (it would make every caller a winner)', null);
ok(await raises(`SELECT public.acquire_cron_lease('ttl-test', 100000)`),
  'an unbounded TTL is REJECTED (it would recreate the wedge)', null);

// ---- grant lockdown: service_role yes, authenticated/anon no ----
await db.query(`SET ROLE service_role`);
const svc = (await db.query(`SELECT public.acquire_cron_lease('grant-test', 900) AS v`)).rows[0].v;
ok(typeof svc === 'string', 'service_role CAN execute acquire_cron_lease', svc);
await db.query(`SELECT public.release_cron_lease('grant-test', $1)`, [svc]);
await db.query(`RESET ROLE`);
ok(await raises(`SET ROLE authenticated; SELECT public.acquire_cron_lease('grant-test', 900)`),
  'authenticated CANNOT execute acquire_cron_lease (revoked)', null);
await db.query(`RESET ROLE`);
ok(await raises(`SET ROLE anon; SELECT public.release_cron_lease('grant-test', gen_random_uuid())`),
  'anon CANNOT execute release_cron_lease (revoked)', null);
await db.query(`RESET ROLE`);
// the lease TABLE itself is never directly writable, even by service_role
ok(await raises(`SET ROLE service_role; INSERT INTO public.cron_job_leases (job_name, owner_token, locked_until)
                 VALUES ('direct', gen_random_uuid(), now() + interval '1 hour')`),
  'service_role CANNOT write cron_job_leases directly (RPC-only surface)', null);
await db.query(`RESET ROLE`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
