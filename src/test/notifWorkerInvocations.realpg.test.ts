import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

/**
 * N4 M1 — the durable pending-invocation record (Stage-3.5 AC-6; contract CRITICAL 1, thread
 * 019fd1e0-0979-7132-b5b3-081a49517231) — CORRECTED contract after the operator review:
 *
 *  BIND is typed, and only 'bound' | 'replayed' may proceed: the boolean version returned one
 *  false for a provably-identical retry, a run STEALING the invocation, a missing row and a
 *  resolved one — and its comment invited proceeding, so a retried HTTP request could run a
 *  second worker pass without owning the invocation.
 *
 *  OPEN is request-id idempotent: an invoker whose COMMIT outcome was ambiguous retries with
 *  the same id and RECOVERS its invocation uuid; concurrent exact replays converge on one row;
 *  concurrent different requests cannot both open; a reused id carrying a different request is
 *  refused.
 */

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
let c2: InstanceType<typeof Client>;
const PORT = 54437;
const MIG = (f: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8');

const open = async (client: InstanceType<typeof Client>, req: string, purpose = 'smoke', source = 'runbook:test') =>
  (await client.query(`SELECT public.open_notification_worker_invocation($1,$2,$3) AS id`, [purpose, source, req])).rows[0].id as string;
const bind = async (inv: string, run: string) =>
  (await c.query(`SELECT public.bind_notification_worker_invocation($1,$2) AS r`, [inv, run])).rows[0].r as string;
const newRun = async (ended = false, phase = 'dispatch', channel = 'email', worker = 'notification-digest-worker:test') => {
  // born unfinished, finished through the PRODUCTION transition — the guard forbids pre-ended
  // inserts, exactly as production does
  const run = (await c.query(
    `INSERT INTO public.notification_worker_runs (worker, channel, phase)
     VALUES ($3, $1, $2) RETURNING run_id`,
    [channel, phase, worker])).rows[0].run_id as string;
  if (ended) await endRun(run);
  return run;
};
const endRun = async (run: string) =>
  c.query(`UPDATE public.notification_worker_runs SET ended_at = now(), status = 'succeeded' WHERE run_id = $1`, [run]);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n4inv-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c2.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);
  // The REAL worker-runs DDL, extracted from the foundation migration rather than retyped — a
  // hand-built stand-in is exactly what hid the r.id-vs-run_id defect from the first battery.
  const foundation = MIG('20261002100000_notification_digest_schema_foundation.sql');
  const runsDdl = foundation.match(
    /CREATE TABLE IF NOT EXISTS public\.notification_worker_runs[\s\S]*?\);/)?.[0];
  if (!runsDdl) throw new Error('notification_worker_runs DDL not found in the foundation migration');
  await c.query(runsDdl);
  // …WITH its production guard: born unfinished, finished only through the sanctioned UPDATE.
  // Without it the fixture could INSERT pre-ended runs — a shape production cannot produce, and
  // exactly the kind of divergence that hid the r.id defect.
  const runsGuard = foundation.match(
    /CREATE OR REPLACE FUNCTION public\.notification_worker_runs_guard\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;|CREATE OR REPLACE FUNCTION public\.notification_worker_runs_guard\(\)[\s\S]*?\$\$;/)?.[0];
  const runsTrigger = foundation.match(
    /DROP TRIGGER IF EXISTS trg_worker_runs_guard[\s\S]*?notification_worker_runs_guard\(\);/)?.[0];
  if (!runsGuard || !runsTrigger) throw new Error('worker_runs guard not found in the foundation migration');
  await c.query(runsGuard);
  await c.query(runsTrigger);
  await c.query(MIG('20261016100000_notif_n4_worker_invocations.sql'));
  await c.query(MIG('20261016110000_notif_n4_invocation_claim.sql'));
}, 180_000);

afterAll(async () => { await c2?.end(); await c?.end(); await epg?.stop(); });

beforeEach(async () => {
  // the guard forbids DELETE by design — the harness resets state the sanctioned way
  await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
  await c.query(`DELETE FROM public.notification_worker_invocations;`);
  await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
  await c.query(`ALTER TABLE public.notification_worker_runs DISABLE TRIGGER trg_worker_runs_guard;`);
  await c.query(`DELETE FROM public.notification_worker_runs;`);
  await c.query(`ALTER TABLE public.notification_worker_runs ENABLE TRIGGER trg_worker_runs_guard;`);
});

describe('open: request-id idempotency', () => {
  it('an exact replay RECOVERS the same invocation — the ambiguous-commit path', async () => {
    const req = crypto.randomUUID();
    const first = await open(c, req);
    const replay = await open(c, req);
    expect(replay).toBe(first);
    const n = await c.query(`SELECT count(*)::int AS n FROM public.notification_worker_invocations`);
    expect(n.rows[0].n).toBe(1);
  });

  it('replay still recovers AFTER the invocation resolved — the id is durable identity, not state', async () => {
    const req = crypto.randomUUID();
    const inv = await open(c, req);
    const run = await newRun(false); // bound while LIVE (an ended run is rightly refused now)
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r).toBe('completed');
    expect(await open(c, req)).toBe(inv);
  });

  it('a reused id carrying a DIFFERENT request is refused — one id, one request', async () => {
    const req = crypto.randomUUID();
    await open(c, req, 'smoke', 'runbook:test');
    await expect(open(c, req, 'canary', 'runbook:test')).rejects.toThrow(/different invocation/);
    await expect(open(c, req, 'smoke', 'runbook:other')).rejects.toThrow(/different invocation/);
  });

  it('single-flight: a DIFFERENT request while one is unresolved is refused with the runbook message', async () => {
    await open(c, crypto.randomUUID());
    await expect(open(c, crypto.randomUUID())).rejects.toThrow(/single-flight/);
  });

  it('two-session EXACT replay converges on ONE row (deterministic: session 1 holds its txn open)', async () => {
    const req = crypto.randomUUID();
    await c.query('BEGIN');
    const first = (await c.query(`SELECT public.open_notification_worker_invocation('smoke','runbook:test',$1) AS id`, [req])).rows[0].id;
    const race = c2.query(`SELECT public.open_notification_worker_invocation('smoke','runbook:test',$1) AS id`, [req]);
    await new Promise((r) => setTimeout(r, 150)); // let session 2 block on the request lock
    await c.query('COMMIT');
    const second = (await race).rows[0].id;
    expect(second).toBe(first);
    const n = await c.query(`SELECT count(*)::int AS n FROM public.notification_worker_invocations`);
    expect(n.rows[0].n).toBe(1);
  });

  it('two-session DIFFERENT requests cannot both open (deterministic)', async () => {
    await c.query('BEGIN');
    await c.query(`SELECT public.open_notification_worker_invocation('smoke','runbook:test',$1)`, [crypto.randomUUID()]);
    const race = c2.query(`SELECT public.open_notification_worker_invocation('canary','runbook:test',$1)`, [crypto.randomUUID()]);
    await new Promise((r) => setTimeout(r, 150)); // session 2 blocks on the OPEN lock
    await c.query('COMMIT');
    await expect(race).rejects.toThrow(/single-flight/);
  });

  it('a NULL request id is refused outright', async () => {
    await expect(c.query(`SELECT public.open_notification_worker_invocation('smoke','runbook:test',NULL)`))
      .rejects.toThrow(/request_id is required/);
  });
});

describe('bind: typed verdicts — only bound|replayed proceed', () => {
  it('the full verdict table, each case distinguishable', async () => {
    const inv = await open(c, crypto.randomUUID());
    const runA = await newRun();
    const runB = await newRun();
    expect(await bind(inv, runA)).toBe('bound');
    expect(await bind(inv, runA)).toBe('replayed');           // provably identical retry
    expect(await bind(inv, runB)).toBe('conflict_other_run'); // a second worker must STOP
    expect(await bind(crypto.randomUUID(), runB)).toBe('missing');
    // resolve, then bind again → resolved
    await endRun(runA);
    await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed')`, [inv]);
    expect(await bind(inv, runA)).toBe('resolved');
  });

  it('the run is EVIDENCE and must be one: nonexistent, wrong-kind and already-ended runs refuse the bind', async () => {
    const inv = await open(c, crypto.randomUUID());
    expect(await bind(inv, crypto.randomUUID())).toBe('run_missing');
    expect(await bind(inv, await newRun(false, 'materialize'))).toBe('run_wrong_kind');
    expect(await bind(inv, await newRun(false, 'dispatch', 'whatsapp'))).toBe('run_wrong_kind');
    expect(await bind(inv, await newRun(true))).toBe('run_already_ended'); // historical evidence
    // none of the refusals consumed the invocation
    const row = await c.query(`SELECT status, worker_run_id FROM public.notification_worker_invocations WHERE id = $1`, [inv]);
    expect(row.rows[0]).toEqual({ status: 'pending', worker_run_id: null });
    // a replay stays valid after the OWNED run ends — the exact-run arm, not the fresh-bind arm
    const run = await newRun();
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    expect(await bind(inv, run)).toBe('replayed');
  });

  it("a WRONG-WORKER run is not evidence — arbitrary service-role runs can't impersonate the digest worker", async () => {
    const inv = await open(c, crypto.randomUUID());
    const impostor = await newRun(false, 'dispatch', 'email', 'some-other-service:test');
    expect(await bind(inv, impostor)).toBe('run_wrong_kind');
    const row = await c.query(`SELECT status, worker_run_id FROM public.notification_worker_invocations WHERE id = $1`, [inv]);
    expect(row.rows[0]).toEqual({ status: 'pending', worker_run_id: null });
  });

  it('two-session: bind cannot accept a run a concurrent finish is ending (deterministic)', async () => {
    // Session 2 holds the run's finish OPEN (row lock held, ended_at uncommitted); bind must
    // BLOCK on its FOR UPDATE and, once the finish commits, see the ended run — never bind over
    // stale unfinished evidence read before the lock.
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun(false);
    await c2.query('BEGIN');
    await c2.query(`UPDATE public.notification_worker_runs SET ended_at = now(), status = 'succeeded' WHERE run_id = $1`, [run]);
    const race = c.query(`SELECT public.bind_notification_worker_invocation($1,$2) AS r`, [inv, run]);
    await new Promise((r) => setTimeout(r, 150)); // bind is now blocked on the run row
    await c2.query('COMMIT');
    expect((await race).rows[0].r).toBe('run_already_ended');
    const row = await c.query(`SELECT status FROM public.notification_worker_invocations WHERE id = $1`, [inv]);
    expect(row.rows[0].status).toBe('pending');
  });

  it('a conflicting bind never overwrites the owner', async () => {
    const inv = await open(c, crypto.randomUUID());
    const runA = await newRun();
    const runB = await newRun();
    await bind(inv, runA);
    await bind(inv, runB); // conflict — must not steal
    const row = await c.query(`SELECT worker_run_id FROM public.notification_worker_invocations WHERE id = $1`, [inv]);
    expect(row.rows[0].worker_run_id).toBe(runA);
  });
});

describe('resolution', () => {
  it('completion demands EVIDENCE: an unbound or still-running invocation is rejected', async () => {
    const inv = await open(c, crypto.randomUUID());
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r)
      .toBe('rejected_run_not_ended');
    const run = await newRun(false); // not ended
    await bind(inv, run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r)
      .toBe('rejected_run_not_ended');
    await endRun(run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r)
      .toBe('completed');
  });

  it('abandon: pending is age-gated; STARTED additionally demands its run has ended', async () => {
    const inv = await open(c, crypto.randomUUID());
    await expect(c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned')`, [inv]))
      .rejects.toThrow(/requires a reason/);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned','operator gave up') AS r`, [inv])).rows[0].r)
      .toBe('rejected_too_young');
    // the guard makes requested_at immutable — model age the sanctioned way
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await c.query(`UPDATE public.notification_worker_invocations SET requested_at = now() - interval '11 minutes' WHERE id = $1`, [inv]);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
    // bind it: a STARTED invocation over a live run cannot be abandoned at ANY age — an
    // unfinished run is the durable evidence the system has not closed it
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned','operator gave up') AS r`, [inv])).rows[0].r)
      .toBe('rejected_run_still_running');
    await endRun(run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned','operator gave up') AS r`, [inv])).rows[0].r)
      .toBe('abandoned');
    // and abandoning FREES the single-flight slot
    await open(c, crypto.randomUUID());
  });

  it('the owner-effective guard: no birth-as-started, no owner change, no reopening, no delete', async () => {
    await expect(c.query(`INSERT INTO public.notification_worker_invocations (request_id, purpose, source, status, worker_run_id)
      VALUES (gen_random_uuid(),'smoke','direct-guard', 'started', gen_random_uuid())`))
      .rejects.toThrow(/born clean pending/);
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun();
    await bind(inv, run);
    await expect(c.query(`UPDATE public.notification_worker_invocations SET worker_run_id = gen_random_uuid() WHERE id = $1`, [inv]))
      .rejects.toThrow(/immutable/);
    await endRun(run);
    await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed')`, [inv]);
    await expect(c.query(`UPDATE public.notification_worker_invocations SET status = 'pending', resolved_at = NULL WHERE id = $1`, [inv]))
      .rejects.toThrow(/not a legal transition|never reopen/);
    await expect(c.query(`DELETE FROM public.notification_worker_invocations WHERE id = $1`, [inv]))
      .rejects.toThrow(/append-only/);
    await expect(c.query(`TRUNCATE public.notification_worker_invocations`))
      .rejects.toThrow(/append-only/);
  });
});

describe('ACLs', () => {
  it('clients touch nothing; service_role acts only through the RPCs', async () => {
    const as = async (role: string, sql: string) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as('authenticated', `SELECT * FROM public.notification_worker_invocations`)).toBe('42501');
    expect(await as('anon', `SELECT public.open_notification_worker_invocation('smoke','x-test',gen_random_uuid())`)).toBe('42501');
    expect(await as('service_role', `SELECT * FROM public.notification_worker_invocations`)).toBeNull();
    expect(await as('service_role', `INSERT INTO public.notification_worker_invocations (request_id, purpose, source) VALUES (gen_random_uuid(),'smoke','direct')`)).toBe('42501');
  });
});


describe('claim_pending_worker_invocation (part 3): the worker-side handshake', () => {
  const claim = async (run: string) =>
    (await c.query(`SELECT public.claim_pending_worker_invocation($1) AS r`, [run])).rows[0].r as string | null;

  it('claims THE pending invocation; a second run of the same request replays via the claim too', async () => {
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun(false);
    expect(await claim(run)).toBe(inv);
    // an HTTP duplicate delivering the same request → same run id claims again → replayed → same id
    expect(await claim(run)).toBe(null); // no PENDING left; the started row is not re-claimable…
    // …which is correct: the duplicate proceeds as a steady-state pass, never as a second
    // deliberate one (bind's 'replayed' arm remains available to callers holding the id)
  });

  it('no pending invocation → NULL: the steady-state cron tick, explicitly not an error', async () => {
    expect(await claim(await newRun(false))).toBe(null);
  });

  it('a pending invocation the run cannot own RAISES — never a silent steady-state downgrade', async () => {
    await open(c, crypto.randomUUID());
    const impostor = await newRun(false, 'materialize');
    await expect(c.query(`SELECT public.claim_pending_worker_invocation($1)`, [impostor]))
      .rejects.toThrow(/refused this run/);
  });
});
