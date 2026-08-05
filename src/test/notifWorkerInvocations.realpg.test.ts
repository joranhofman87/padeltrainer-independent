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
  // round 3: bind gains the CAUSALITY check (a run cannot own an invocation it predates)
  // and the claim stops turning that refusal into a failed cron tick
  {
    const r3 = MIG('20261024100000_notif_n4_seam_corrections_round3.sql');
    await c.query(r3.slice(0, r3.indexOf('-- \u2500\u2500 SEAM 13')));
  }
  // round 4 (convergence): the ownership CONTRACT — 'manual' is gone, and with it round 3's
  // timestamp comparison and the claim arm that comparison needed
  await c.query(MIG('20261025100000_notif_n4_invocation_ownership_contract.sql'));
  // round 5: the claim binds ONLY the invocation the REQUEST names. The migration's first half
  // re-points the scheduled cron command (pg_cron is not installed here — the rollout harness
  // executes that half); the second half is the RPC, which is what this suite owns.
  {
    const r5 = MIG('20261026100000_notif_n4_dispatch_carries_invocation.sql');
    await c.query(r5.slice(r5.indexOf('DROP FUNCTION IF EXISTS public.claim_pending_worker_invocation')));
  }
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
  it('I4: a purpose no ARTIFACT provides is refused, naming what the artifacts supply that it cannot', async () => {
    // the round-4 convergence: ownership of the run an invocation causes is proven by exclusion
    // (cron inactive under the job row lock, no run in flight, single-flight) — properties only
    // an artifact establishes. An ad-hoc invocation had none of them.
    await expect(c.query(
      `SELECT public.open_notification_worker_invocation('manual','operator:adhoc',gen_random_uuid())`))
      .rejects.toThrow(/purpose manual is not available/);
    await expect(c.query(
      `SELECT public.open_notification_worker_invocation('backfill','ops',gen_random_uuid())`))
      .rejects.toThrow(/is not available/);
    // …and the SCHEMA refuses it too, with the RPC out of the way
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await expect(c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source)
       VALUES (gen_random_uuid(), 'manual', 'operator:adhoc')`))
      .rejects.toThrow(/purpose_check/);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
  });

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


describe('claim_worker_invocation (part 3): the worker-side handshake', () => {
  /** the round-5 shape: the request's own identity goes in, one (status, invocation_id) row comes back */
  const claimRow = async (run: string, inv: string | null = null) =>
    (await c.query(`SELECT * FROM public.claim_worker_invocation($1, $2)`, [run, inv])).rows[0] as
      { status: string; invocation_id: string | null };
  const claim = async (run: string, inv: string | null = null) => (await claimRow(run, inv)).invocation_id;

  it('a STARTED invocation refuses every OTHER run — a duplicate HTTP request can never proceed as steady-state', async () => {
    // The bug this pins: the claim searched pending-only, so a duplicate request (pg_net retry,
    // double dispatch) whose sibling had bound the invocation got NULL and proceeded as a FULL
    // steady-state pass — materializing and claiming groups in a second, unverified run inside
    // the operator's evidence window. (An earlier version of this test BLESSED that NULL.)
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun(false);
    expect(await claim(run, inv)).toBe(inv);
    // the same run retrying its own claim is a provably-identical replay → same id, may proceed
    expect(await claim(run, inv)).toBe(inv);
    // a DUPLICATE HTTP request carries the SAME id (the body was built once) and is REFUSED loudly
    const dup = await newRun(false);
    await expect(c.query(`SELECT * FROM public.claim_worker_invocation($1, $2)`, [dup, inv]))
      .rejects.toThrow(/conflict_other_run/);
  });

  it('two concurrent requests: the loser BLOCKS on the classification, then is refused — deterministic, not a lucky race', async () => {
    const inv = await open(c, crypto.randomUUID());
    const runA = await newRun(false);
    const runB = await newRun(false);
    await c.query('BEGIN');
    expect((await c.query(`SELECT invocation_id FROM public.claim_worker_invocation($1, $2)`, [runA, inv])).rows[0].invocation_id).toBe(inv);
    let settled = false;
    const loser = c2.query(`SELECT * FROM public.claim_worker_invocation($1, $2)`, [runB, inv])
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);   // genuinely serialized behind the winner's open transaction
    await c.query('COMMIT');
    await expect(loser).rejects.toThrow(/conflict_other_run/);
  });

  it("'none' only when ZERO unresolved invocations exist: the steady-state cron tick", async () => {
    expect(await claimRow(await newRun(false))).toMatchObject({ status: 'none', invocation_id: null });
  });

  it('a NAMED invocation the run cannot own RAISES — never a silent steady-state downgrade', async () => {
    const inv = await open(c, crypto.randomUUID());
    const impostor = await newRun(false, 'materialize');
    await expect(c.query(`SELECT * FROM public.claim_worker_invocation($1, $2)`, [impostor, inv]))
      .rejects.toThrow(/refused this run/);
  });

  // ── round 5: THE COUNTEREXAMPLE that ended the exclusion argument ────────────────────────
  it('a request that names NOTHING can never bind an invocation — it DEFERS instead', async () => {
    // the in-flight tick: dispatched while the cron was active, its body frozen BEFORE the
    // invocation existed, arriving after the operator opened a canary. Under "claim the one
    // unresolved invocation" it bound the canary's evidence to a steady-state run that carried
    // none of the canary's blast-radius bounds.
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const staleTick = await newRun(false);
    expect(await claimRow(staleTick, null)).toMatchObject({ status: 'deferred', invocation_id: null });
    expect((await c.query(
      `SELECT status, worker_run_id FROM public.notification_worker_invocations WHERE id = $1`, [inv])).rows[0])
      .toMatchObject({ status: 'pending', worker_run_id: null });
    // …and the canary's OWN request, which names it, still owns it
    const canaryRun = await newRun(false);
    expect(await claimRow(canaryRun, inv)).toMatchObject({ status: 'owned', invocation_id: inv });
  });

  it('deferral is not stranding: once the invocation resolves, the next unnamed tick is steady-state again', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await c.query(`SELECT public.record_invocation_net_request($1, 970001)`, [inv]);   // the dispatch provenance
    const run = await newRun(false);
    expect(await claim(run, inv)).toBe(inv);
    expect(await claimRow(await newRun(false), null)).toMatchObject({ status: 'deferred' });  // started, still open
    await endRun(run);
    await c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]);
    expect(await claimRow(await newRun(false), null)).toMatchObject({ status: 'none' });
  });

  // ── round 4 (convergence): ownership is proven by EXCLUSION, so the claim keeps exactly two
  //    arms — own it, or nothing is unresolved. The third arm round 3 needed for 'manual'
  //    returned NULL, which is the worker's signal to run a FULL steady-state pass: it
  //    authorised the overlapping unverified execution the loud arm exists to prevent.
  it('a NAMED invocation another run owns ALWAYS raises — the duplicate-request protection, unchanged by round 5', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const owner = await newRun(false);
    expect(await claim(owner, inv)).toBe(inv);
    // a duplicate HTTP request carries the SAME id and starts its own run: refused LOUDLY, never
    // downgraded to a silent second steady-state pass
    const duplicate = await newRun(false);
    await expect(c.query(`SELECT * FROM public.claim_worker_invocation($1, $2)`, [duplicate, inv]))
      .rejects.toThrow(/conflict_other_run/);
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

  const bindNet = async (inv: string, resp: number) =>
    c.query(`SELECT public.record_invocation_net_request($1,$2)`, [inv, resp]);

  it('the exact disabled 200 completes a pending smoke as completed_disabled — idempotently', async () => {
    const inv = await open(c, crypto.randomUUID());
    const resp = await addResp();
    await bindNet(inv, resp);
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
    const resp = await addResp();
    await bindNet(inv, resp);
    await resolveSmoke(inv, resp);
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

  it.each([
    ['a non-200', { status_code: 500 }, /only the exact disabled 200/],
    ['an ok body', { content: '{"status":"ok","dispatchRunId":"x"}' }, /only the exact disabled 200/],
    ['a missing reason', { content: '{"status":"disabled"}' }, /only the exact disabled 200/],
    ['a wrong reason', { content: '{"status":"disabled","reason":"unexpected"}' }, /only the exact disabled 200/],
    ['an EXTRA field', { content: '{"status":"disabled","reason":"disabled","error":"partial failure"}' }, /only the exact disabled 200/],
    ['a timeout', { timed_out: true }, /transport failure/],
    ['a transport error', { error_msg: 'connection reset' }, /transport failure/],
  ] as const)('%s is refused — the body must EQUAL the documented answer as jsonb, not merely contain status=disabled', async (_label, over, why) => {
    const inv = await open(c, crypto.randomUUID());
    const resp = await addResp(over as Parameters<typeof addResp>[0]);
    await bindNet(inv, resp);
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, resp]))
      .rejects.toThrow(why);
    // the refusal left it pending — no partial state
    expect((await c.query(`SELECT status FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0].status).toBe('pending');
  });

  it('a response row that does not exist is refused', async () => {
    const inv = await open(c, crypto.randomUUID());
    await bindNet(inv, 999999999);   // bound at dispatch, but no response ever arrived
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, 999999999]))
      .rejects.toThrow(/does not exist/);
  });

  it('CAUSAL binding: a later fully-qualifying response from ANOTHER request cannot complete this smoke', async () => {
    const inv = await open(c, crypto.randomUUID());
    const mine = await addResp({ status_code: 500 });        // my request failed…
    await bindNet(inv, mine);
    const other = await addResp();                           // …someone else's disabled 200, later
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, other]))
      .rejects.toThrow(/dispatched pg_net request/);
    expect((await c.query(`SELECT status FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0].status).toBe('pending');
  });

  it('an invocation that never recorded its dispatch cannot be completed by ANY response', async () => {
    const inv = await open(c, crypto.randomUUID());
    const resp = await addResp();
    await expect(c.query(`SELECT public.resolve_smoke_invocation_disabled($1,$2)`, [inv, resp]))
      .rejects.toThrow(/never recorded its pg_net request/);
  });

  it("a response that PREDATES the open is refused — stale evidence, even for the bound request id", async () => {
    const stale = await addResp({ created: new Date(Date.now() - 3600_000).toISOString() });
    const inv = await open(c, crypto.randomUUID());
    await bindNet(inv, stale);
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
    const resp = await addResp();
    await bindNet(inv, resp);
    await resolveSmoke(inv, resp);
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


describe('record_invocation_net_request (part 3): the causal dispatch-evidence recorder', () => {
  const record = async (inv: string, resp: number) =>
    c.query(`SELECT public.record_invocation_net_request($1,$2)`, [inv, resp]);

  it('set-once: the same value replays silently; a DIFFERENT value raises naming the original request', async () => {
    const inv = await open(c, crypto.randomUUID());
    await record(inv, 501);
    await record(inv, 501);   // idempotent — the replay whose commit was real re-records itself
    await expect(record(inv, 502)).rejects.toThrow(/ALREADY dispatched pg_net request 501/);
    expect((await c.query(`SELECT net_request_id FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0].net_request_id).toBe('501');
  });

  it('one pg_net request evidences at most ONE invocation — ever, across resolutions', async () => {
    const a = await open(c, crypto.randomUUID());
    await record(a, 601);
    await addRespShared(601);
    expect((await c.query(`SELECT public.resolve_smoke_invocation_disabled($1,601) AS r`, [a])).rows[0].r).toBe('completed_disabled');
    const b = await open(c, crypto.randomUUID());
    await expect(record(b, 601)).rejects.toThrow(/uq_notification_worker_invocation_net_request|duplicate key/);
  });

  it('the recorded request is IMMUTABLE even past the RPC — the owner-effective guard blocks a direct change', async () => {
    const inv = await open(c, crypto.randomUUID());
    await record(inv, 701);
    await expect(c.query(`UPDATE public.notification_worker_invocations SET net_request_id = 702 WHERE id=$1`, [inv]))
      .rejects.toThrow(/dispatch evidence does not change/);
  });

  it('recording is pending-only: the invoker binds in its OWN transaction, never after a worker claimed', async () => {
    const inv = await open(c, crypto.randomUUID());
    await bind(inv, await newRun(false));
    await expect(record(inv, 801)).rejects.toThrow(/is started/);
  });

  it('OWNER-EFFECTIVE, not just RPC discipline: birth with evidence, and late attachment in any state, are refused by the guard itself', async () => {
    // birth: a row cannot arrive already carrying dispatch evidence
    await expect(c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, net_request_id)
       VALUES (gen_random_uuid(), 'smoke', 'guard-test', 901)`))
      .rejects.toThrow(/born clean pending/);
    // NULL→value on a STARTED invocation — the RPC refuses this, and so must the guard (a
    // direct owner UPDATE is exactly the bypass the round-3 review named)
    const inv = await open(c, crypto.randomUUID());
    const run = await newRun(false);
    await bind(inv, run);
    await expect(c.query(`UPDATE public.notification_worker_invocations SET net_request_id = 902 WHERE id=$1`, [inv]))
      .rejects.toThrow(/recorded by the invoker while pending/);
    // ...and on a TERMINAL invocation
    await endRun(run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'completed') AS r`, [inv])).rows[0].r).toBe('completed');
    await expect(c.query(`UPDATE public.notification_worker_invocations SET net_request_id = 903 WHERE id=$1`, [inv]))
      .rejects.toThrow(/recorded by the invoker while pending/);
  });

  it('the SCHEMA refuses a completed_disabled row with no recorded request, even with the guard disabled', async () => {
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await expect(c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, status, resolved_at)
       VALUES (gen_random_uuid(), 'smoke', 'shape-test', 'completed_disabled', now())`))
      .rejects.toThrow(/invocation_disabled_is_runless_smoke/);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
  });

  // the disabled-resolve needs a response row for the happy path above
  async function addRespShared(id: number) {
    await c.query(
      `INSERT INTO net._http_response (id, status_code, content, timed_out, error_msg)
       VALUES ($1, 200, '{"status":"disabled","reason":"disabled"}', false, NULL)
       ON CONFLICT (id) DO NOTHING`, [id]);
    return id;
  }
});


describe('the invocation gates (part 3): strict for activate, replay-aware for the invokers', () => {
  // These execute the REAL artifact SQL — the same text psql sends — with the one psql
  // substitution (:'invocation_request_id') applied the way psql would. The strict gate has no
  // variables at all.
  const ART = (f: string) =>
    readFileSync(resolve(__dirname, '..', '..', 'scripts', 'rollout', 'notif-10cb', 'sql', f), 'utf8');
  const strictGate = () => c.query(ART('_invocation_gate.sql'));
  const replayGate = (req: string) =>
    c.query(`BEGIN`).then(async () => {
      try {
        await c.query(ART('_invocation_gate_replay.sql').replace(/:'invocation_request_id'/g, `'${req}'`));
      } finally { /* caller commits/rolls back */ }
    });

  it('STRICT: passes on zero unresolved; refuses ANY unresolved row, naming its request id', async () => {
    await strictGate();   // empty → no raise
    const req = crypto.randomUUID();
    await open(c, req);
    await expect(strictGate()).rejects.toThrow(new RegExp(`UNRESOLVED.*request_id=${req}`));
  });

  it('REPLAY-AWARE: passes on zero unresolved, and passes the OWN interrupted invocation through to the idempotent open()', async () => {
    const req = crypto.randomUUID();
    await replayGate(req); await c.query('COMMIT');            // empty → no raise
    const inv = await open(c, req);                            // the "committed but ambiguous" open
    await replayGate(req);                                     // the retry reaches…
    const again = (await c.query(
      `SELECT public.open_notification_worker_invocation('smoke','runbook:test',$1) AS id`, [req])).rows[0].id;
    await c.query('COMMIT');
    expect(again).toBe(inv);                                   // …the SAME invocation
    expect((await c.query(`SELECT count(*)::int AS n FROM public.notification_worker_invocations`)).rows[0].n).toBe(1);
  });

  it('REPLAY-AWARE: any OTHER unresolved invocation still refuses, naming the id to use', async () => {
    const req = crypto.randomUUID();
    await open(c, req);
    await expect(replayGate(crypto.randomUUID())).rejects.toThrow(new RegExp(`NOT this request.*request_id=${req}`));
    await c.query('ROLLBACK');
  });

  it('REPLAY-AWARE: takes open()\'s locks in open()\'s ORDER — a concurrent direct open() on the same id must NOT deadlock', async () => {
    // Round 1 gave this gate the global open lock to close a visibility race, but took it FIRST,
    // while open() takes the REQUEST lock first. Artifact holds open + wants req; a concurrent
    // opener holds req + wants open. Postgres resolves that by killing one of them mid-rollout.
    const req = crypto.randomUUID();
    // c2 stands in for an opener that is INSIDE open(), past its first lock — reproduced with
    // open()'s own key rather than a paraphrase of it.
    await c2.query('BEGIN');
    await c2.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-req:' || $1::text, 0))`, [req]);
    await c.query('BEGIN');
    let gateSettled = false;
    const artifact = (async () => {
      await c.query(ART('_invocation_gate_replay.sql').replace(/:'invocation_request_id'/g, `'${req}'`));
      return open(c, req);
    })().finally(() => { gateSettled = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(gateSettled).toBe(false);                       // waiting on the REQUEST lock, holding nothing
    const other = (await c2.query(
      `SELECT public.open_notification_worker_invocation('smoke','runbook:test',$1) AS id`, [req])).rows[0].id;
    await c2.query('COMMIT');                              // …so this can complete instead of deadlocking
    expect(await artifact).toBe(other);                    // the gate then REPLAYS the same invocation
    await c.query('COMMIT');
    expect((await c.query(`SELECT count(*)::int AS n FROM public.notification_worker_invocations`)).rows[0].n).toBe(1);
  });

  it('a reused id whose PURPOSE differs passes the gate but dies in open() — no second row, no dispatch', async () => {
    const req = crypto.randomUUID();
    await open(c, req, 'smoke');
    await replayGate(req);
    await expect(c.query(
      `SELECT public.open_notification_worker_invocation('canary','canary_invoke.sql',$1)`, [req]))
      .rejects.toThrow(/already used for a different invocation/);
    await c.query('ROLLBACK');
    expect((await c.query(`SELECT count(*)::int AS n FROM public.notification_worker_invocations`)).rows[0].n).toBe(1);
  });
});


describe("the activation gate's INDEPENDENT canary-provenance assertion (part 3)", () => {
  // Activation is the authoritative gate: it must not depend on canary_reconcile having been
  // run correctly. This executes the REAL assertion from _activation_assertions.sql (section 8),
  // extracted verbatim and substituted the way psql would, over the real assert_eq helper.
  const assertsFile = readFileSync(
    resolve(__dirname, '..', '..', 'scripts', 'rollout', 'notif-10cb', 'sql', '_activation_assertions.sql'), 'utf8');
  // section 8 ONLY — section 9 (the N4 seam kill check) reads a table this invocation-focused
  // harness does not carry; it is pinned in the preflight suite and exercised in the kill suite
  const section = assertsFile.match(/-- 8\. THE CANARY'S PROVENANCE[\s\S]*?(?=\n-- 9\.|$)/)?.[0];
  const assertHelper = readFileSync(
    resolve(__dirname, '..', '..', 'scripts', 'rollout', 'notif-10ca3', 'sql', '_assert.sql'), 'utf8')
    .replace(/^\\set .*$/m, '');
  const runAssert = async (run: string) => {
    if (!section) throw new Error('provenance assertion not found in _activation_assertions.sql');
    await c.query(assertHelper);
    await c.query(section.replace(/:'run_id'/g, `'${run}'`));
  };

  it('passes for a run bound to exactly one COMPLETED canary-provenance invocation', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await c.query(`SELECT public.record_invocation_net_request($1, 950001)`, [inv]);
    const run = await newRun(false);
    await bind(inv, run);
    await endRun(run);
    expect(await resolveForRunShared(run)).toBe('completed');
    await runAssert(run);   // no raise
  });

  it("REFUSES a run whose invocation was a SMOKE — even one that 'completed' through the run path before the RPC provenance check existed", async () => {
    // constructed past the guards, because the RPCs themselves now refuse this shape — the
    // activation assertion must hold even against historical or manually-repaired rows
    const run = await newRun(true);
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, status, worker_run_id, net_request_id, resolved_at)
       VALUES (gen_random_uuid(), 'smoke', 'smoke_invoke.sql', 'completed', $1, 950002, now())`, [run]);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await expect(runAssert(run)).rejects.toThrow(/exactly one COMPLETED canary-provenance invocation/);
  });

  it('REFUSES a run bound to NO completed invocation at all — an unreconciled canary cannot activate', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await c.query(`SELECT public.record_invocation_net_request($1, 950003)`, [inv]);
    const run = await newRun(false);
    await bind(inv, run);          // started, never resolved
    await endRun(run);
    await expect(runAssert(run)).rejects.toThrow(/exactly one COMPLETED canary-provenance invocation/);
  });

  const resolveForRunShared = async (run: string) =>
    (await c.query(`SELECT public.resolve_invocation_for_canary_run($1) AS r`, [run])).rows[0].r as string;
});


describe('resolve_invocation_for_canary_run (part 3): the strict canary reconciliation', () => {
  // The defect this replaces: the artifact resolved "WHERE worker_run_id = run AND status =
  // 'started'" — ZERO matches produced zero rows and the shell sailed on to verification with
  // the invocation still pending. Zero must RAISE (naming that a pending invocation exists —
  // the reconciled run is then NOT the run the canary caused), and a typed refusal from the
  // generic resolve must RAISE too, never print as a quiet verdict.
  const resolveForRun = async (run: string) =>
    (await c.query(`SELECT public.resolve_invocation_for_canary_run($1) AS r`, [run])).rows[0].r as string;
  let nextNet = 900000;
  const rec = async (inv: string) =>
    c.query(`SELECT public.record_invocation_net_request($1,$2)`, [inv, ++nextNet]);

  it('happy path: the bound, ended run completes its invocation; a re-run is already_resolved', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await rec(inv);
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    expect(await resolveForRun(run)).toBe('completed');
    expect(await resolveForRun(run)).toBe('already_resolved');
  });

  it('CANARY PROVENANCE: a run claimed by a SMOKE can never be reconciled as the canary — the accidental-send gate-bypass', async () => {
    // The scenario: smoke-disabled asserted the switch off, the switch was ON, the worker ran
    // and SENT. That dispatch run handed to the canary command must refuse — completing the
    // smoke invocation here would let activation treat the accident as the reviewed canary.
    const inv = await open(c, crypto.randomUUID(), 'smoke', 'smoke_invoke.sql');
    await rec(inv);
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/bound to a smoke invocation.*NEVER be reconciled as the reviewed canary/s);
    // and the refusal changed NOTHING — the smoke invocation is still started, still the truth
    expect((await c.query(`SELECT status FROM public.notification_worker_invocations WHERE id=$1`, [inv])).rows[0].status).toBe('started');
  });

  it('a canary invocation that never recorded its dispatch is refused — provenance is incomplete', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/never recorded its pg_net request/);
  });

  it('ZERO invocations for the run RAISES, naming the still-pending invocation — never a silent no-op', async () => {
    await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql'); // pending, NOT bound
    const foreignRun = await newRun(true);
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [foreignRun]))
      .rejects.toThrow(/NO invocation is bound to run.*1 still pending/s);
  });

  it('a typed refusal from the generic resolve RAISES — a still-running run cannot quietly “reconcile”', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await rec(inv);
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    // run NOT ended — the generic resolve answers rejected_run_not_ended
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/refused completion — verdict rejected_run_not_ended/);
  });

  it('an ABANDONED invocation is never overwritten by reconciliation', async () => {
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await rec(inv);
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned','operator gave up') AS r`, [inv])).rows[0].r).toBe('abandoned');
    await expect(c.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run]))
      .rejects.toThrow(/ABANDONED/);
  });

  it('one run evidences at most ONE invocation — SCHEMA-level, immune even to guard-disabled corruption', async () => {
    // The activation assertion counts qualifying rows for a run; without uniqueness a
    // historical second row (a smoke beside a valid canary) could hide next to it and the
    // predicate count would still read 1. The index makes that state unconstructible.
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await rec(inv);
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    try {
      await expect(c.query(
        `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, status, worker_run_id, net_request_id, resolved_at)
         VALUES (gen_random_uuid(), 'smoke', 'ambig-b', 'completed', $1, 960001, now())`, [run]))
        .rejects.toThrow(/uq_notification_worker_invocation_run|duplicate key/);
    } finally {
      await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
    }
  });

  it('a concurrent ABANDON cannot be reported as a successful reconciliation — deterministic two-session race', async () => {
    // Session A abandons (uncommitted, holding the row); session B's reconcile BLOCKS on the
    // classification lock; after A commits, B must refuse over the ABANDONED verdict — never
    // return already_resolved as success. (Without the wrapper's FOR UPDATE, B read 'started'
    // pre-commit, passed the abandoned arm, and the generic resolve's own 'already_resolved'
    // sailed through as a completed reconciliation.)
    const inv = await open(c, crypto.randomUUID(), 'canary', 'canary_invoke.sql');
    await rec(inv);
    const run = await newRun(false);
    expect(await bind(inv, run)).toBe('bound');
    await endRun(run);
    await c.query('BEGIN');
    expect((await c.query(`SELECT public.resolve_notification_worker_invocation($1,'abandoned','operator abort') AS r`, [inv])).rows[0].r).toBe('abandoned');
    let settled = false;
    const loser = c2.query(`SELECT public.resolve_invocation_for_canary_run($1)`, [run])
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);   // provably serialized behind the uncommitted abandon
    await c.query('COMMIT');
    // the ABANDONED arm — locked classification saw the committed truth, not the stale read
    await expect(loser).rejects.toThrow(/ABANDONED/);
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
    expect(r.actionable).toBe(true);   // an old PENDING is abandonable right now
    expect(Number(r.age_seconds)).toBeGreaterThanOrEqual(11 * 60 - 5);
    expect(r.worker_run_id).toBeNull();
    expect(r.run_status).toBeNull();
    // the column set is FIXED — no payloads, no request bodies
    expect(Object.keys(r).sort()).toEqual([
      'abandon_reason', 'actionable', 'age_seconds', 'id', 'net_request_id', 'purpose',
      'requested_at', 'resolved_at', 'run_phase', 'run_status', 'source', 'stale', 'status',
      'worker_run_id',
    ]);
  });

  it('stale is an AGE signal; actionable is a VERB: a started invocation over a live run is stale but NOT actionable', async () => {
    // an OLD invocation (born 11 minutes ago — settable only at INSERT), then bound to a LIVE run
    const inv = (await c.query(
      `INSERT INTO public.notification_worker_invocations (request_id, purpose, source, requested_at)
       VALUES ($1, 'smoke', 'smoke_invoke.sql', now() - interval '11 minutes') RETURNING id`,
      [crypto.randomUUID()])).rows[0].id as string;
    const run = await newRun(false);
    await bind(inv, run);
    let mine = (await listAs(c2, ADMIN)).find((r) => r.id === inv);
    expect(mine.stale).toBe(true);          // old, yes…
    expect(mine.actionable).toBe(false);    // …but no verb exists: abandon refuses a live run
    await endRun(run);
    mine = (await listAs(c2, ADMIN)).find((r) => r.id === inv);
    expect(mine.stale).toBe(true);
    expect(mine.actionable).toBe(true);     // the run ended: resolve is available NOW
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
