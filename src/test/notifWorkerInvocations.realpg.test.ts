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
  // What part 3's RPCs read beyond the invocation table itself:
  //  - net._http_response (pg_net) for the disabled-smoke evidence — a minimal structural stand-in
  //    with pg_net's real columns (id, status_code, content, timed_out, error_msg, created);
  //  - auth.uid() + public.has_role for the admin reader — has_role is the REAL function body
  //    extracted from its migration (the doctrine that caught r.id-vs-run_id), over the real
  //    user_roles shape; auth.uid() is a GUC-driven stand-in so tests can impersonate.
  await c.query(`
    CREATE SCHEMA net;
    CREATE TABLE net._http_response (
      id bigint PRIMARY KEY, status_code int, content_type text, headers jsonb,
      content text, timed_out boolean, error_msg text,
      created timestamptz NOT NULL DEFAULT now());
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TYPE public.app_role AS ENUM ('player', 'trainer', 'admin');
  `);
  const rolesMig = MIG('20260115184937_a9f9b073-efb2-4069-8c85-10e3c65c6124.sql');
  const userRolesDdl = rolesMig.match(/CREATE TABLE public\.user_roles \([\s\S]*?\);/)?.[0];
  const hasRole = rolesMig.match(/CREATE OR REPLACE FUNCTION public\.has_role[\s\S]*?\$\$;/)?.[0];
  if (!userRolesDdl || !hasRole) throw new Error('user_roles/has_role not found in the roles migration');
  await c.query(userRolesDdl);
  await c.query(hasRole);
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

  it('a STARTED invocation refuses every OTHER run — a duplicate HTTP request can never proceed as steady-state', async () => {
    // The bug this pins: the claim searched pending-only, so a duplicate request (pg_net retry,
    // double dispatch) whose sibling had bound the invocation got NULL and proceeded as a FULL
    // steady-state pass — materializing and claiming groups in a second, unverified run inside
    // the operator's evidence window. (An earlier version of this test BLESSED that NULL.)
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun(false);
    expect(await claim(run)).toBe(inv);
    // the same run retrying its own claim is a provably-identical replay → same id, may proceed
    expect(await claim(run)).toBe(inv);
    // any OTHER run — duplicate request or a cron tick landing mid-window — is REFUSED, loudly
    const dup = await newRun(false);
    await expect(c.query(`SELECT public.claim_pending_worker_invocation($1)`, [dup]))
      .rejects.toThrow(/conflict_other_run/);
  });

  it('two concurrent requests: the loser BLOCKS on the classification, then is refused — deterministic, not a lucky race', async () => {
    const inv = await open(c, crypto.randomUUID());
    const runA = await newRun(false);
    const runB = await newRun(false);
    await c.query('BEGIN');
    expect((await c.query(`SELECT public.claim_pending_worker_invocation($1) AS r`, [runA])).rows[0].r).toBe(inv);
    let settled = false;
    const loser = c2.query(`SELECT public.claim_pending_worker_invocation($1) AS r`, [runB])
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);   // genuinely serialized behind the winner's open transaction
    await c.query('COMMIT');
    await expect(loser).rejects.toThrow(/conflict_other_run/);
  });

  it('NULL only when ZERO unresolved invocations exist: the steady-state cron tick', async () => {
    expect(await claim(await newRun(false))).toBe(null);
  });

  it('a pending invocation the run cannot own RAISES — never a silent steady-state downgrade', async () => {
    await open(c, crypto.randomUUID());
    const impostor = await newRun(false, 'materialize');
    await expect(c.query(`SELECT public.claim_pending_worker_invocation($1)`, [impostor]))
      .rejects.toThrow(/refused this run/);
  });
});


describe('resolve_smoke_invocation_disabled (part 3): the disabled-smoke completion arm', () => {
  // The one deliberate invocation whose worker never starts a run: the disabled worker answers
  // the exact disabled 200 before any DB work, so the generic run-evidence resolve refuses it
  // forever. This arm demands the pg_net response evidence instead — and must not weaken the
  // generic path or accept anything that is not a pending smoke with clean disabled evidence.
  let nextResp = 1000;
  const addResp = async (over: {
    status_code?: number; content?: string; timed_out?: boolean; error_msg?: string | null; created?: string;
  } = {}) => {
    const id = ++nextResp;
    await c.query(
      `INSERT INTO net._http_response (id, status_code, content, timed_out, error_msg, created)
       VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))`,
      [id, over.status_code ?? 200, over.content ?? '{"status":"disabled","reason":"disabled"}',
       over.timed_out ?? false, over.error_msg ?? null, over.created ?? null]);
    return id;
  };
  const resolveSmoke = async (inv: string, resp: number) =>
    (await c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2) AS r`, [inv, resp])).rows[0].r as string;

  it('the exact disabled 200 completes a pending smoke as completed_disabled — idempotently', async () => {
    const inv = await open(c, crypto.randomUUID());
    const resp = await addResp();
    expect(await resolveSmoke(inv, resp)).toBe('completed_disabled');
    const row = (await c.query(`SELECT status, worker_run_id, resolved_at FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0];
    expect(row.status).toBe('completed_disabled');
    expect(row.worker_run_id).toBeNull();
    expect(row.resolved_at).not.toBeNull();
    expect(await resolveSmoke(inv, resp)).toBe('already_resolved');      // shell re-run
    // …and the GENERIC resolve agrees it is terminal rather than re-resolving it
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r).toBe('already_resolved');
  });

  it('completed_disabled RELEASES the single-flight gate — the next deliberate invocation can open', async () => {
    const inv = await open(c, crypto.randomUUID());
    await expect(open(c2, crypto.randomUUID())).rejects.toThrow(/unresolved/);
    await resolveSmoke(inv, await addResp());
    expect(await open(c2, crypto.randomUUID())).toBeTruthy();
  });

  it('a canary is REFUSED — finding the engine disabled is an operational failure for a canary, not a success', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const resp = await addResp();
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, resp]))
      .rejects.toThrow(/not a smoke/);
  });

  it('a STARTED smoke is refused — the worker RAN, so the run-based resolve owns it', async () => {
    const inv = await open(c, crypto.randomUUID());
    await bind(inv, await newRun(false));
    const resp = await addResp();
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, resp]))
      .rejects.toThrow(/not pending/);
  });

  it('non-200, wrong body, transport failure, and missing response are each refused', async () => {
    const inv = await open(c, crypto.randomUUID());
    for (const [resp, why] of [
      [await addResp({ status_code: 500 }), /only the exact disabled 200/],
      [await addResp({ content: '{"status":"ok","dispatchRunId":"x"}' }), /only the exact disabled 200/],
      [await addResp({ timed_out: true }), /transport failure/],
      [await addResp({ error_msg: 'connection reset' }), /transport failure/],
      [999999999, /does not exist/],
    ] as const) {
      await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, resp]))
        .rejects.toThrow(why);
    }
    // all five refusals left it pending — no partial state
    expect((await c.query(`SELECT status FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0].status).toBe('pending');
  });

  it("a response that PREDATES the open is refused — another request's evidence cannot complete this smoke", async () => {
    const stale = await addResp({ created: new Date(Date.now() - 3600_000).toISOString() });
    const inv = await open(c, crypto.randomUUID());
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, stale]))
      .rejects.toThrow(/PREDATES/);
  });

  it('this arm did NOT weaken the generic resolve: a runless pending smoke still cannot be completed generically', async () => {
    const inv = await open(c, crypto.randomUUID());
    const r = (await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r;
    expect(r).toBe('rejected_run_not_ended');   // the typed refusal — never a completion
    expect((await c.query(`SELECT status FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0].status).toBe('pending');
  });

  it('the guard: completed_disabled never reopens, its terminal shape is smoke-only and runless', async () => {
    const inv = await open(c, crypto.randomUUID());
    await resolveSmoke(inv, await addResp());
    await expect(c.query(`UPDATE public.notification_worker_invocations SET status='pending', resolved_at=NULL WHERE id=$1`, [inv]))
      .rejects.toThrow(/not a legal transition|never reopen/);
    // and the schema refuses the shape outright for a non-smoke, even with the guard disabled
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await expect(c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, status, resolved_at)
       VALUES (gen_random_uuid(), 'canary', 'shape-test', 'completed_disabled', now())`))
      .rejects.toThrow(/invocation_disabled_is_runless_smoke/);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
  });
});


describe('resolve_invocation_for_canary_run (part 3): the strict canary reconciliation', () => {
  // The defect this replaces: the artifact resolved "WHERE worker_run_id = run AND status =
  // 'started'" — ZERO matches produced zero rows and the shell sailed on to verification with
  // the invocation still pending. Zero must RAISE (naming that a pending invocation exists —
  // the reconciled run is then NOT the run the canary caused), and a typed refusal from the
  // generic resolve must RAISE too, never print as a quiet verdict.
  const resolveForRun = async (run: string) =>
    (await c.query(`SELECT public.resolve_invocation_for_canary_run($1) AS r`, [run])).rows[0].r as string;

  it('happy path: the bound, ended run completes its invocation; a re-run is already_resolved', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    expect(await resolveForRun(run)).toBe('completed');
    expect(await resolveForRun(run)).toBe('already_resolved');
  });

  it('ZERO invocations for the run RAISES, naming the still-pending invocation — never a silent no-op', async () => {
    await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql'); // pending, NOT bound
    const foreignRun = await newRun(true);
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [foreignRun]))
      .rejects.toThrow(/NO invocation is bound to run.*1 still pending/s);
  });

  it('a typed refusal from the generic resolve RAISES — a still-running run cannot quietly “reconcile”', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    // run NOT ended — the generic resolve answers rejected_run_not_ended
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/refused completion — verdict rejected_run_not_ended/);
  });

  it('an ABANDONED invocation is never overwritten by reconciliation', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned','operator gave up') AS r`, [inv])).rows[0].r).toBe('abandoned');
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/ABANDONED/);
  });

  it('MANY invocations claiming one run RAISES as ambiguous (constructible only past the guards)', async () => {
    const run = await newRun(true);
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, status, worker_run_id, resolved_at)
       VALUES (gen_random_uuid(), 'canary', 'ambig-a', 'completed', $1, now()),
              (gen_random_uuid(), 'canary', 'ambig-b', 'started', $1, NULL)`, [run]);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/2 invocations claim run/);
  });
});


describe('admin_list_worker_invocations (part 3): AC-6 health exposure', () => {
  const ADMIN = '11111111-1111-4111-8111-111111111111';
  const PLAYER = '22222222-2222-4222-8222-222222222222';
  beforeAll(async () => {
    await c.query(`INSERT INTO auth.users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [ADMIN, PLAYER]);
    await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1,'admin'), ($2,'player') ON CONFLICT DO NOTHING`, [ADMIN, PLAYER]);
  });
  const listAs = async (client: InstanceType<typeof Client>, uid: string | null, limit?: number) => {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try {
      return (await client.query(`SELECT * FROM public.admin_list_worker_invocations($1)`, [limit ?? null])).rows;
    } finally {
      await client.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    }
  };

  it('fail-closed: anonymous and non-admin callers are refused', async () => {
    await expect(listAs(c2, null)).rejects.toThrow(/platform admin only/);
    await expect(listAs(c2, PLAYER)).rejects.toThrow(/platform admin only/);
  });

  it('an admin sees fixed columns, unresolved-first, with the bound run joined and a stale flag past the abandon age-gate', async () => {
    // an old resolved row + a stale pending one (requested_at is settable only at INSERT; the
    // guard permits an old birth timestamp, which is exactly how a stale row exists in prod)
    const staleReq = crypto.randomUUID();
    await c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, requested_at)
       VALUES ($1, 'canary', 'canary_invoke.sql', now() - interval '11 minutes')`, [staleReq]);
    const rows = await listAs(c2, ADMIN);
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.purpose).toBe('canary');
    expect(r.status).toBe('pending');
    expect(r.stale).toBe(true);
    expect(Number(r.age_seconds)).toBeGreaterThanOrEqual(11 * 60 - 5);
    expect(r.worker_run_id).toBeNull();
    expect(r.run_status).toBeNull();
    // the column set is FIXED — no payloads, no request bodies
    expect(Object.keys(r).sort()).toEqual([
      'abandon_reason', 'age_seconds', 'id', 'purpose', 'requested_at', 'resolved_at',
      'run_phase', 'run_status', 'source', 'stale', 'status', 'worker_run_id',
    ]);
  });

  it('a freshly bound invocation is NOT stale and carries its run', async () => {
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun(false);
    await bind(inv, run);
    const rows = await listAs(c2, ADMIN);
    const mine = rows.find((r) => r.id === inv);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('started');
    expect(mine.stale).toBe(false);
    expect(mine.worker_run_id).toBe(run);
    expect(mine.run_phase).toBe('dispatch');
  });

  it('the bound is clamped: a hostile limit cannot open the window', async () => {
    await open(c, crypto.randomUUID());
    expect((await listAs(c2, ADMIN, 0)).length).toBe(1);          // clamps up to 1
    await expect(listAs(c2, ADMIN, 10_000_000)).resolves.toBeTruthy(); // clamps down to 200 (structural: no error)
  });

  it('ACL: anon cannot even EXECUTE it', async () => {
    await c2.query(`SET ROLE anon`);
    try {
      await expect(c2.query(`SELECT * FROM public.admin_list_worker_invocations(5)`)).rejects.toThrow();
    } finally {
      await c2.query(`RESET ROLE`);
    }
  });
});
