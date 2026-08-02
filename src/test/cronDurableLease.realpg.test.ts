// @vitest-environment node
// 10c-b A — the durable cron lease on a REAL multi-connection Postgres server.
//
// This suite exists for the ONE property PGlite structurally cannot demonstrate, and it is the
// exact property CRON-SF-WEDGE was about: the session-scoped advisory lock was unsafe because
// acquire and release landed on DIFFERENT pooled backends. So every assertion below deliberately
// crosses connections — acquire on A, observe/release from B — which is precisely how Supabase's
// pooler will actually serve an edge function's round-trips.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54364;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let a: pg.Client;   // "backend A" — one pooled connection
let b: pg.Client;   // "backend B" — a genuinely different one
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cronlease-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const boot = new Client({ connectionString: url });
  await boot.connect();
  await boot.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);
  await boot.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`);
  await boot.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  // the RPCs the migration drops must exist first, so the DROP is exercised for real
  await boot.query(MIG('20260614190000_cron_single_flight_lock.sql'));
  await boot.query(MIG('20261007100000_cron_durable_lease.sql'));
  await boot.query(MIG('20261009100000_notif_10cb_review_corrections.sql'));
  await boot.end();
  a = new Client({ connectionString: url }); await a.connect();
  b = new Client({ connectionString: url }); await b.connect();
  // prove A and B really are distinct backends — otherwise every assertion below is vacuous
  const pidA = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  const pidB = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  expect(pidA).not.toBe(pidB);
}, 180_000);

beforeEach(async () => { await a.query('DELETE FROM public.cron_job_leases'); });

afterAll(async () => {
  try { await a?.end(); } catch { /* ignore */ }
  try { await b?.end(); } catch { /* ignore */ }
  try { await epg?.stop(); } catch { /* ignore */ }
});

const acquire = (c: pg.Client, job: string, ttl = 900) =>
  c.query('SELECT public.acquire_cron_lease($1,$2) AS v', [job, ttl]).then((r) => r.rows[0].v as string | null);
const release = (c: pg.Client, job: string, tok: string) =>
  c.query('SELECT public.release_cron_lease($1,$2) AS v', [job, tok]).then((r) => r.rows[0].v as boolean);
const renew = (c: pg.Client, job: string, tok: string, ttl = 900) =>
  c.query('SELECT public.renew_cron_lease($1,$2,$3) AS v', [job, tok, ttl]).then((r) => r.rows[0].v as boolean);

describe('10c-b A — durable cron lease across DIFFERENT pooled sessions', () => {
  it('the wedge primitives are gone from the live schema', async () => {
    const { rows } = await a.query(
      `SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('try_lock_cron_job','unlock_cron_job')`);
    expect(rows[0].n).toBe(0);
  });

  it('two concurrent invocations on different backends: exactly ONE wins', async () => {
    const [x, y] = await Promise.all([acquire(a, 'job-1'), acquire(b, 'job-1')]);
    const winners = [x, y].filter((t) => t !== null);
    expect(winners).toHaveLength(1);
  });

  it('a lease taken on A is released from B — the case the advisory lock could not do', async () => {
    const tok = await acquire(a, 'job-2');
    expect(tok).toBeTruthy();
    // B, a different backend, holds no session state for this lease yet still releases it
    expect(await release(b, 'job-2', tok as string)).toBe(true);
    // and the job is immediately re-acquirable, from either side
    expect(await acquire(b, 'job-2')).toBeTruthy();
  });

  it('a backend that DISCONNECTS mid-run cannot wedge the job (the wedge regression)', async () => {
    const dying = new Client({ connectionString: url });
    await dying.connect();
    await dying.query('SELECT public.acquire_cron_lease($1,$2)', ['job-3', 30]);
    await dying.end();   // simulates the pooled backend going away mid-run
    // The lease is still HELD (correct: the TTL has not elapsed) …
    expect(await acquire(a, 'job-3')).toBeNull();
    // … and it frees itself on expiry, with no session, no recycle, no operator.
    await a.query(`UPDATE public.cron_job_leases SET locked_until = now() - interval '1 ms' WHERE job_name='job-3'`);
    expect(await acquire(a, 'job-3')).toBeTruthy();
  });

  it('a stale owner cannot release or renew a lease that has moved to a new owner', async () => {
    const stale = await acquire(a, 'job-4', 30) as string;
    await a.query(`UPDATE public.cron_job_leases SET locked_until = now() - interval '1 ms' WHERE job_name='job-4'`);
    const fresh = await acquire(b, 'job-4') as string;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(stale);
    expect(await release(a, 'job-4', stale)).toBe(false);   // wrong owner releases NOTHING
    expect(await renew(a, 'job-4', stale)).toBe(false);
    expect(await acquire(a, 'job-4')).toBeNull();           // the real owner still holds it
    expect(await release(b, 'job-4', fresh)).toBe(true);
  });

  it('renew extends only for the live owner, and an expired owner cannot resurrect itself', async () => {
    const tok = await acquire(a, 'job-5', 30) as string;
    expect(await renew(b, 'job-5', tok, 900)).toBe(true);    // cross-session renew is fine
    await a.query(`UPDATE public.cron_job_leases SET locked_until = now() - interval '1 ms' WHERE job_name='job-5'`);
    expect(await renew(b, 'job-5', tok, 900)).toBe(false);   // expired: must re-acquire, not renew
  });

  it('a race of many concurrent acquirers still yields exactly one winner', async () => {
    const conns = await Promise.all(Array.from({ length: 8 }, async () => {
      const c = new Client({ connectionString: url }); await c.connect(); return c;
    }));
    try {
      const results = await Promise.all(conns.map((c) => acquire(c, 'job-6')));
      expect(results.filter((t) => t !== null)).toHaveLength(1);
    } finally {
      await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    }
  });

  it('the lease table is not directly writable, even by service_role', async () => {
    await a.query('SET ROLE service_role');
    await expect(a.query(
      `INSERT INTO public.cron_job_leases (job_name, owner_token, locked_until)
       VALUES ('direct', gen_random_uuid(), now() + interval '1 hour')`)).rejects.toThrow();
    await a.query('RESET ROLE');
  });
});

describe('10c-b review #4 — release_cron_lease is idempotent per its contract', () => {
  const counters = async (job: string) =>
    (await b.query('SELECT release_count::int AS rc, locked_until FROM public.cron_job_leases WHERE job_name=$1', [job])).rows[0];

  it('first live-owner release returns true and increments release_count exactly once', async () => {
    const tok = await acquire(a, 'idem-1') as string;
    expect((await counters('idem-1')).rc).toBe(0);
    expect(await release(a, 'idem-1', tok)).toBe(true);
    expect((await counters('idem-1')).rc).toBe(1);
  });

  it('a SECOND release by the same owner returns false and changes no telemetry', async () => {
    const tok = await acquire(a, 'idem-2') as string;
    expect(await release(a, 'idem-2', tok)).toBe(true);
    const after = await counters('idem-2');
    // repeat several times — the count must not creep
    for (let i = 0; i < 3; i++) expect(await release(a, 'idem-2', tok)).toBe(false);
    const later = await counters('idem-2');
    expect(later.rc).toBe(after.rc);
    expect(later.rc).toBe(1);
    expect(new Date(later.locked_until).getTime()).toBe(new Date(after.locked_until).getTime());
  });

  it('the repeat release is refused ACROSS sessions too, not just within one', async () => {
    const tok = await acquire(a, 'idem-3') as string;
    expect(await release(a, 'idem-3', tok)).toBe(true);
    expect(await release(b, 'idem-3', tok)).toBe(false);      // different backend, same stale token
    expect((await counters('idem-3')).rc).toBe(1);
  });

  it('a wrong owner never touches telemetry', async () => {
    const tok = await acquire(a, 'idem-4') as string;
    const before = await counters('idem-4');
    expect(await release(b, 'idem-4', '00000000-0000-0000-0000-000000000000')).toBe(false);
    expect((await counters('idem-4')).rc).toBe(before.rc);
    expect(await release(a, 'idem-4', tok)).toBe(true);
  });

  it('releasing, re-acquiring and releasing again counts each real release once', async () => {
    const t1 = await acquire(a, 'idem-5') as string;
    expect(await release(a, 'idem-5', t1)).toBe(true);
    const t2 = await acquire(b, 'idem-5') as string;
    expect(t2).not.toBe(t1);
    expect(await release(a, 'idem-5', t1)).toBe(false);       // the OLD token is inert
    expect(await release(b, 'idem-5', t2)).toBe(true);
    expect((await counters('idem-5')).rc).toBe(2);            // exactly two genuine releases
  });
});
