// @vitest-environment node
// PR 10c-a3 — the digest WORKER loop, driven end-to-end against a REAL multi-connection Postgres
// (embedded-postgres) with the full migration chain (10c-a1 foundation + ACL + 10c-a2 state machine + 10c-a3
// oversize/frozen-request-v2 + hash-fix) and a SCRIPTED fake Resend. Covers the required fault-injection matrix:
// disabled/misconfigured zero-mutation, two-worker concurrency, crash boundaries, multi-item split, single-item
// oversize terminalization, exact frozen-request dispatch (incl. frozen `from` + digest_group_id tag), one HTTP
// per attempt, STATE-AWARE 429 retry (begin, no re-render, same key), timeout/network ambiguity, record-failure
// → FAILED run recovery, stale-lease recovery, bounded invocation, no session cron lock, truthful reconcile.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigestWorker, DigestWorkerError, type WorkerDeps, type WorkerLimits } from '../../supabase/functions/_shared/digest-worker-core.ts';
import type { ResendSendOnceResult } from '../../supabase/functions/_shared/resend-send-once.ts';

const PORT = 54347;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let seq = 0;
const conn = () => new pg.Client({ connectionString: url });

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'digest-worker-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const c = conn(); await c.connect();
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false, required_delivery boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, user_id uuid, guest_player_id uuid, channel text NOT NULL DEFAULT 'email', destination_normalized text NOT NULL, consent_status text NOT NULL DEFAULT 'unknown', consent_scope text NOT NULL DEFAULT 'global', consent_academy_profile_id uuid, consent_trainer_id uuid, revoked_at timestamptz, is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz);
    CREATE FUNCTION public.is_notification_consent_in_scope(_a text,_b uuid,_c uuid,_d uuid,_e uuid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
    -- auth.uid() is what the N5 boundary RPC attributes an activation to. This suite has no auth
    -- schema, so it gets the same NULL-returning stand-in the other realpg suites use — the RPC
    -- must be exercised through its REAL definition, not around it.
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
    CREATE TABLE public.notification_outbox (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email', event_type text, template_key text, status text NOT NULL DEFAULT 'pending', payload jsonb, skip_reason text, destination_normalized text, contact_id uuid, recipient_person_id uuid, recipient_user_id uuid, recipient_guest_player_id uuid, tenant_academy_profile_id uuid, tenant_trainer_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT notification_outbox_status_check CHECK (status IN ('pending','processing','sent','delivered','failed','skipped','cancelled')));
    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p)) $$;
    CREATE TABLE public.notification_preferences_v2 (user_id uuid NOT NULL, event_type text NOT NULL, email_frequency text NOT NULL DEFAULT 'instant', UNIQUE (user_id, event_type));
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);`);
  for (const f of ['20261002100000_notification_digest_schema_foundation.sql', '20261003100000_notification_digest_acl_lockdown.sql',
    '20261004100000_notification_digest_state_machine.sql', '20261005100000_notification_digest_render_oversize.sql',
    '20261005110000_notification_digest_request_hash_bytea_fix.sql',
    // 10c-b E gave this its FIRST caller: the worker now drains the orphan reconcile queue, so
    // the fixture must carry the migration that defines it. Without it the drain would throw on
    // every run — which is exactly what the suite should catch if the migration is ever dropped.
    '20261006110000_reconcile_orphan_provider_events.sql',
    // N4 M1 did the same again: every dispatch run now opens by CLAIMING the pending deliberate
    // invocation (Stage-3.5 AC-6), so the invocation record + claim RPC are part of the worker's
    // runtime contract. In this suite no invocation is ever opened, so every claim is the
    // steady-state NULL — which is itself part of what these tests now prove.
    '20261016100000_notif_n4_worker_invocations.sql',
    '20261016110000_notif_n4_invocation_claim.sql',
    // …and the round-4/5 corrections that own the claim's contract: ownership is proven by the
    // identity the REQUEST carries, so this suite's runs (which carry none) are steady-state ticks
    '20261025100000_notif_n4_invocation_ownership_contract.sql',
    '20261026100000_notif_n4_dispatch_carries_invocation.sql',
    // N4 M2: per-channel kill switches gate the digest claim/materialize/begin in SQL. With no
    // kill row every prior test must behave IDENTICALLY — that unchanged-behavior guarantee is
    // part of what this chain now proves; the kill describe at the bottom proves the gates.
    '20261017100000_notif_n4_channel_kill_switches.sql',
    // N5 LAST, as the real chain applies it (20261028 > 20261017): it recreates the claim AND the
    // materializer, so applying it earlier would let the kill-switch migration overwrite the
    // activation-boundary gate and the suite would prove nothing about it.
    '20261028100000_notif_n5_activation_boundary.sql',
    '20261030100000_notif_n5_round2_dispatch_boundary.sql']) {
    await c.query(readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8'));
  }
  // N5: this suite describes a RUNNING digest pipeline, so the digest path must be OPEN — through
  // the real RPC, because the guard refuses anything else and because "someone opened it" is the
  // only way a row ever becomes eligible. Every fixture row below is created after this instant.
  await c.query(
    `SELECT public.record_notification_activation_boundary('email:digest', 'digest worker suite', gen_random_uuid())`);
  await c.end();
}, 180_000);

afterAll(async () => { if (epg) await epg.stop(); });

beforeEach(async () => {
  const c = conn(); await c.connect();
  try {
    await c.query(`TRUNCATE public.notification_digest_groups, public.notification_digest_attempts,
      public.notification_digest_group_attempts, public.notification_provider_events, public.notification_provider_circuit,
      public.notification_send_counters, public.notification_send_reservations, public.notification_worker_runs,
      -- notification_orphan_reconcile_state is NOT listed: it CASCADEs from notification_provider_events.
      -- notification_orphan_reconcile_actions must NEVER be listed — it is owner-effectively append-only
      -- (an immutable-row trigger refuses TRUNCATE), which is the point of an operator audit.
      public.notification_outbox, public.email_suppression_stub, public.notification_preferences_v2, public.notification_contacts,
      public.persons RESTART IDENTITY CASCADE`);
    // N4 M2: kill switches are SET-only by design (no SQL path clears one) — the harness resets
    // them the sanctioned way, exactly as the owner's runbook would.
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
  } finally { await c.end(); }
});

const NOW = new Date('2026-07-01T10:00:00Z');
const BD = "'2026-07-01 06:00:00+00'::timestamptz";
const FIXED_LIMITS: WorkerLimits = { maxMaterializeGroups: 200, maxMaterializeMembers: 5000, maxAttempts: 100, sweepLimit: 500, orphanReconcileLimit: 200, wallClockMs: 60_000 };

/**
 * Functions that RETURN TABLE. PostgREST gives the caller an ARRAY OF OBJECTS for these, so the
 * fixture must too — `SELECT fn(...)` would hand back a composite string and the worker would
 * read every field as undefined while looking perfectly green.
 */
const TABLE_RETURNING_RPCS = new Set(['reconcile_orphan_provider_events', 'claim_worker_invocation']);

/** Named-arg RPC caller: object keys → `p_x => $n` (jsonb-cast for object values). Throws on DB error. */
function mkRpc(c: pg.Client) {
  return async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => (args[k] !== null && typeof args[k] === 'object') ? `${k} => $${i + 1}::jsonb` : `${k} => $${i + 1}`).join(', ');
    const vals = keys.map((k) => (args[k] !== null && typeof args[k] === 'object') ? JSON.stringify(args[k]) : args[k]);
    if (TABLE_RETURNING_RPCS.has(name)) {
      const t = await c.query(`SELECT * FROM public.${name}(${named})`, vals);
      return t.rows;
    }
    const r = await c.query(`SELECT public.${name}(${named}) AS result`, vals);
    return r.rows[0]?.result ?? null;
  };
}

type Frozen = { from: string; to: string; subject: string; html: string };       // the PERSISTED request (to = string)
type SendPayload = { from: string; to: string[]; subject: string; html: string }; // the Resend request (to = array)
type SendOpts = { idempotencyKey: string; groupId: string };
type DepOverrides = Partial<Pick<WorkerDeps, 'enabled' | 'apiKeyPresent' | 'limits' | 'now'>> & {
  send?: (payload: SendPayload, opts: SendOpts) => ResendSendOnceResult;
  wrapRpc?: (rpc: WorkerDeps['rpc']) => WorkerDeps['rpc'];
  logs?: Record<string, unknown>[];
  rpcNames?: string[];   // every rpc name invoked (for the no-session-lock assertion)
  reconcileCalls?: string[];   // every run_id reconcile was attempted for (every started run)
  reconcileThrows?: boolean;   // inject a reconcile failure on EVERY call
  reconcileThrowOnCall?: number; // inject a reconcile failure on the Nth call only (1 = materialize, 2 = dispatch)
  sendCalls?: Array<{ payload: SendPayload; opts: SendOpts }>;
  frozenSeen?: Array<{ request: Frozen; idempotencyKey: string } | null>;
  tokenSuffix?: string;
};

function mkDeps(c: pg.Client, o: DepOverrides = {}): WorkerDeps {
  const base = mkRpc(c);
  let reconcileN = 0;
  const named: WorkerDeps['rpc'] = (n, a) => { o.rpcNames?.push(n); return base(n, a); };
  const rawRpc = o.wrapRpc ? o.wrapRpc(named) : named;
  const sendCalls = o.sendCalls ?? [];
  const defaultSend = (): ResendSendOnceResult => ({ kind: 'response', httpStatus: 202, providerMessageId: 're_' + (++seq), errorName: null, retryAfterSeconds: null });
  return {
    enabled: o.enabled ?? true,
    apiKeyPresent: o.apiKeyPresent ?? true,
    channel: 'email',
    from: 'PadelTrainer.ai <noreply@app.padeltrainer.ai>',
    limits: o.limits ?? FIXED_LIMITS,
    rpc: rawRpc,
    readGroupState: async (g) => {
      const r = await c.query(`SELECT state FROM public.notification_digest_groups WHERE id=$1`, [g]);
      return r.rows[0]?.state ?? null;
    },
    loadMembers: async (g) => {
      const r = await c.query(`SELECT destination_normalized, digest_item, group_locale FROM public.notification_outbox WHERE digest_group_id=$1 AND status='pending' ORDER BY created_at, id`, [g]);
      return r.rows.map((row) => ({ destination: row.destination_normalized, digestItem: row.digest_item, locale: row.group_locale }));
    },
    loadFrozen: async (g) => {
      const r = await c.query(`SELECT frozen_request, provider_idempotency_key FROM public.notification_digest_groups WHERE id=$1`, [g]);
      const row = r.rows[0];
      const out = (!row || !row.frozen_request || !row.provider_idempotency_key)
        ? null : { request: row.frozen_request as Frozen, idempotencyKey: row.provider_idempotency_key as string };
      o.frozenSeen?.push(out);   // capture the PERSISTED request the worker read (it is scrubbed once terminal)
      return out;
    },
    reconcile: async (runId) => {
      reconcileN += 1;
      o.reconcileCalls?.push(runId);
      if (o.reconcileThrows || o.reconcileThrowOnCall === reconcileN) throw new Error('reconcile blew up');
      const r = await c.query(`SELECT family, metric, count FROM public.reconcile_notification_digest_run($1)`, [runId]);
      return r.rows.map((row) => ({ family: row.family, metric: row.metric, count: Number(row.count) }));
    },
    sendOnce: (payload, opts) => {
      sendCalls.push({ payload, opts });
      return Promise.resolve(o.send ? o.send(payload, opts) : defaultSend());
    },
    now: o.now ?? (() => NOW),
    monotonicNowMs: (() => { let t = 0; return () => (t += 1); })(),
    newToken: () => `notification-digest-worker:${o.tokenSuffix ?? 'w'}:${++seq}`,
    log: (e) => { (o.logs ?? []).push(e); },
  };
}

async function seedDigestGroup(c: pg.Client, key: string, dest: string, items: object[], createdAt?: string) {
  const fp = (await c.query(`SELECT public.notif_digest_destination_fingerprint($1) f`, [dest])).rows[0].f;
  const uid = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
  await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [uid, dest]);
  for (const item of items) {
    await c.query(`INSERT INTO public.notification_outbox
      (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized, recipient_user_id,
       event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone,
       digest_boundary_at, digest_item, status, created_at)
      VALUES ('email','digest',$1,$2,$3,$4,'ev','tpl',1,'en','daily','Europe/Amsterdam', ${BD}, $5, 'pending',
              coalesce($6::timestamptz, now()))`,
      [key, fp, dest, uid, JSON.stringify(item), createdAt ?? null]);
  }
}
const gstate = async (c: pg.Client, g: string) => (await c.query(`SELECT * FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0];

describe('10c-a3 digest worker — inertness + happy path + dispatch contract', () => {
  it('DISABLED and MISCONFIGURED both make ZERO database mutations (distinct statuses)', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 'x' }]);
      const names: string[] = [];
      const s1 = await runDigestWorker(mkDeps(c, { enabled: false, rpcNames: names }));
      expect(s1.status).toBe('disabled');                              // switch off → healthy no-op
      const s2 = await runDigestWorker(mkDeps(c, { apiKeyPresent: false, rpcNames: names }));
      expect(s2.status).toBe('misconfigured');                         // enabled-but-unconfigured → distinct
      expect(names.length).toBe(0);                                    // NO rpc calls at all in either case
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_worker_runs`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE status<>'pending'`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('happy path: materialize→…→send→record delivers; sends the EXACT persisted frozen request + idempotency key; ONE HTTP per attempt', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 'Booking confirmed', url: 'https://x/1' }]);
      const sendCalls: DepOverrides['sendCalls'] = [];
      const frozenSeen: DepOverrides['frozenSeen'] = [];
      const s = await runDigestWorker(mkDeps(c, { sendCalls, frozenSeen }));
      expect(s.status).toBe('ok'); expect(s.materialized).toBe(1); expect(s.sent).toBe(1); expect(s.recorded).toBe(1);
      const g = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g.state).toBe('sent'); expect(g.provider_message_id).toMatch(/^re_/);
      expect(g.frozen_request).toBeNull();          // scrubbed on terminal (no PII retained post-send)
      // the worker sent the EXACT request the STATE MACHINE persisted (captured at loadFrozen, pre-scrub) — a
      // re-render would diverge — with the PERSISTED idempotency key dg:v1:<group>.
      const persisted = frozenSeen[0]!;
      expect(persisted.idempotencyKey).toBe('dg:v1:' + g.id);
      expect(persisted.request.from).toBe('PadelTrainer.ai <noreply@app.padeltrainer.ai>'); // sender FROZEN in the request
      expect(sendCalls.length).toBe(1);
      // the send carries the WHOLE frozen request (single-string `to` → Resend array), byte-for-byte.
      expect(sendCalls[0].payload).toEqual({ from: persisted.request.from, to: [persisted.request.to], subject: persisted.request.subject, html: persisted.request.html });
      expect(sendCalls[0].opts.idempotencyKey).toBe(persisted.idempotencyKey);
      expect(sendCalls[0].opts.groupId).toBe(g.id);                    // the digest_group_id correlation tag
      // exactly one attempt, one HTTP call
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g.id])).rows[0].n).toBe(1);
    } finally { await c.end(); }
  });

  it('bounded: maxAttempts caps claims per invocation even with more due groups', async () => {
    const c = conn(); await c.connect();
    try {
      for (let i = 0; i < 5; i++) await seedDigestGroup(c, `p:${i}`, `u${i}@example.com`, [{ title: 't' }]);
      const s = await runDigestWorker(mkDeps(c, { limits: { ...FIXED_LIMITS, maxAttempts: 1 } }));
      expect(s.claimed).toBe(1);                                       // only one group processed
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE state='sent'`)).rows[0].n).toBe(1);
    } finally { await c.end(); }
  });

  it('truthful run finish: a sweep (run-level) failure reconciles the dispatch run + finishes it failed + re-throws the ORIGINAL error', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // make the SWEEP (a run-level step) throw → the dispatch run must finish 'failed'
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'reconcile_notification_digest_stale' ? Promise.reject(new Error('boom-sweep')) : r(n, a));
      const reconcileCalls: string[] = [];
      await expect(runDigestWorker(mkDeps(c, { wrapRpc, reconcileCalls }))).rejects.toThrow('boom-sweep'); // original error, not masked
      const run = (await c.query(`SELECT status, ended_at FROM public.notification_worker_runs WHERE phase='dispatch' ORDER BY started_at DESC LIMIT 1`)).rows[0];
      expect(run.status).toBe('failed'); expect(run.ended_at).not.toBeNull();
      expect(reconcileCalls.length).toBe(1);   // the dispatch run was reconciled best-effort on the failure path
    } finally { await c.end(); }
  });

  it('materialize-phase failure: the MATERIALIZE run is reconciled + finished failed, and the original error propagates', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'materialize_notification_digest_groups' ? Promise.reject(new Error('boom-mat')) : r(n, a));
      const reconcileCalls: string[] = [];
      await expect(runDigestWorker(mkDeps(c, { wrapRpc, reconcileCalls }))).rejects.toThrow('boom-mat');
      const mat = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE phase='materialize' ORDER BY started_at DESC LIMIT 1`)).rows[0];
      const disp = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE phase='dispatch' ORDER BY started_at DESC LIMIT 1`)).rows[0];
      expect(mat.status).toBe('failed'); expect(disp.status).toBe('failed');
      expect(reconcileCalls.length).toBe(2);   // BOTH started runs reconciled (materialize in its catch, dispatch in the outer catch)
    } finally { await c.end(); }
  });

  it('reconcile failure is best-effort: it does not mask the original error and does not recurse', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // sweep fails (run-level) AND reconcile itself throws — the ORIGINAL sweep error must still surface, and
      // reconcile must be attempted exactly once (no recursion) then swallowed.
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'reconcile_notification_digest_stale' ? Promise.reject(new Error('boom-sweep')) : r(n, a));
      const reconcileCalls: string[] = [];
      const logs: Record<string, unknown>[] = [];
      await expect(runDigestWorker(mkDeps(c, { wrapRpc, reconcileThrows: true, reconcileCalls, logs }))).rejects.toThrow('boom-sweep');
      expect(reconcileCalls.length).toBe(1);                                   // attempted once, no recursion
      expect(logs.some((l) => l.event === 'reconcile_failed')).toBe(true);     // failure logged, not thrown
      const run = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE phase='dispatch' ORDER BY started_at DESC LIMIT 1`)).rows[0];
      expect(run.status).toBe('failed');
    } finally { await c.end(); }
  });

  it('FALSE-GREEN GUARD: a happy MATERIALIZE run whose reconcile fails → status error, run failed (not a healthy 200)', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // materialize + dispatch both succeed, but the 1st reconcile (the materialize run's) throws.
      const s = await runDigestWorker(mkDeps(c, { reconcileThrowOnCall: 1 }));
      expect(s.status).toBe('error');                 // MUTATION PIN: old reconcileSafe→[] made this 'ok'
      expect(s.reconcileErrors).toBe(1);
      expect(s.materialized).toBe(1);                 // materialize itself DID happen
      const mat = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE run_id=$1`, [s.materializeRunId])).rows[0];
      const disp = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE run_id=$1`, [s.dispatchRunId])).rows[0];
      expect(mat.status).toBe('failed');              // the affected (materialize) run is failed
      expect(disp.status).toBe('failed');             // and the invocation is not provable → dispatch failed too
    } finally { await c.end(); }
  });

  it('FALSE-GREEN GUARD: a happy DISPATCH run whose reconcile fails → status error, dispatch run failed', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // 1st reconcile (materialize) ok, 2nd (dispatch) throws.
      const s = await runDigestWorker(mkDeps(c, { reconcileThrowOnCall: 2 }));
      expect(s.status).toBe('error'); expect(s.reconcileErrors).toBe(1);
      const mat = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE run_id=$1`, [s.materializeRunId])).rows[0];
      const disp = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE run_id=$1`, [s.dispatchRunId])).rows[0];
      expect(mat.status).toBe('succeeded');           // materialize reconcile was fine
      expect(disp.status).toBe('failed');
    } finally { await c.end(); }
  });

  it('a thrown run-level failure preserves the original error AND carries a safe partial summary (run IDs + counts)', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'reconcile_notification_digest_stale' ? Promise.reject(new Error('boom-sweep')) : r(n, a));
      let caught: unknown;
      try { await runDigestWorker(mkDeps(c, { wrapRpc })); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(DigestWorkerError);
      const dwe = caught as DigestWorkerError;
      expect(dwe.message).toContain('boom-sweep');                 // original error preserved (message + originalError)
      expect((dwe.originalError as Error).message).toBe('boom-sweep');
      expect(dwe.summary.status).toBe('error');
      expect(dwe.summary.dispatchRunId).toBeTruthy();              // the failed dispatch run id is carried for the alert
      // the safe summary must not carry PII (it is IDs + counts only)
      expect(JSON.stringify(dwe.summary).includes('@')).toBe(false);
    } finally { await c.end(); }
  });

  it('happy run reconciles BOTH the materialize and dispatch runs', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      const reconcileCalls: string[] = [];
      const s = await runDigestWorker(mkDeps(c, { reconcileCalls }));
      expect(s.status).toBe('ok');
      expect(reconcileCalls).toContain(s.materializeRunId);
      expect(reconcileCalls).toContain(s.dispatchRunId);
      expect(Array.isArray(s.reconcileMaterialize)).toBe(true);
      expect(Array.isArray(s.reconcile)).toBe(true);
    } finally { await c.end(); }
  });
});

describe('10c-a3 digest worker — fault injection', () => {
  it('timeout/network → ambiguous (uncertain, request_ready), no false send', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      const s = await runDigestWorker(mkDeps(c, { send: () => ({ kind: 'transport', transport: 'timeout', message: 't/o' }) }));
      expect(s.recorded).toBe(1); expect(s.sent).toBe(0);
      const g = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g.state).toBe('request_ready'); expect(g.uncertain_since).not.toBeNull();
    } finally { await c.end(); }
  });

  it('a 429 with Retry-After defers (retryable), reservations released; a 422 terminalizes failed', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'r:1', 'a@example.com', [{ title: 't' }]);
      await runDigestWorker(mkDeps(c, { send: () => ({ kind: 'response', httpStatus: 429, providerMessageId: null, errorName: 'rate_limit_exceeded', retryAfterSeconds: 30 }) }));
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='r:1'`)).rows[0].state).toBe('request_ready');
      await seedDigestGroup(c, 't:1', 'b@example.com', [{ title: 't' }]);
      await runDigestWorker(mkDeps(c, { send: (p) => (p.to[0] === 'b@example.com'
        ? { kind: 'response', httpStatus: 422, providerMessageId: null, errorName: 'validation_error', retryAfterSeconds: null }
        : { kind: 'response', httpStatus: 202, providerMessageId: 're_x', errorName: null, retryAfterSeconds: null }) }));
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='t:1'`)).rows[0].state).toBe('failed_terminal');
    } finally { await c.end(); }
  });

  it('single-item RENDER oversize → terminalized oversize_failed (never loops)', async () => {
    const c = conn(); await c.connect();
    try {
      // one item whose RAW bytes ≤ 90 KB but whose ESCAPED render blows past it ("<" → "&lt;", 4×).
      await seedDigestGroup(c, 'o:1', 'a@example.com', [{ title: '<'.repeat(30000) }]);
      const sendCalls: DepOverrides['sendCalls'] = [];
      const s = await runDigestWorker(mkDeps(c, { sendCalls }));
      expect(s.oversizeFailed).toBe(1); expect(sendCalls.length).toBe(0);   // never sent
      expect((await c.query(`SELECT state, terminal_reason FROM public.notification_digest_groups WHERE recipient_key='o:1'`)).rows[0]).toMatchObject({ state: 'oversize_failed', terminal_reason: 'render_oversize' });
    } finally { await c.end(); }
  });

  it('oversize finalizer is a PROVER: rejects small / wrong-destination / multi-item / non-prepared calls', async () => {
    const c = conn(); await c.connect();
    try {
      const rpc = mkRpc(c);
      const nowIso = NOW.toISOString();
      const fpOf = async (d: string) => (await c.query(`SELECT public.notif_digest_destination_fingerprint($1) f`, [d])).rows[0].f;
      // drive a SINGLE-member group to 'prepared', owned by W/drun.
      await seedDigestGroup(c, 'g1:1', 'a@example.com', [{ title: 'x' }]);
      const mrun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'materialize' });
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: nowIso, p_max_groups: 100, p_max_members_per_call: 100 });
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='g1:1'`)).rows[0].id;
      const drun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'dispatch' });
      await rpc('claim_notification_digest_group', { p_run_id: drun, p_channel: 'email', p_now: nowIso, p_worker: 'W' });
      await rpc('prepare_notification_digest_group', { p_run_id: drun, p_group_id: g, p_worker: 'W', p_now: nowIso });
      const bigHtml = '<p>' + 'x'.repeat(93000) + '</p>';   // > 90 KB
      const fin = (req: object) => rpc('finalize_notification_digest_render_oversize', { p_run_id: drun, p_group_id: g, p_worker: 'W', p_frozen_request: req, p_now: nowIso });
      const fpA = await fpOf('a@example.com');
      // (a) a request WITHIN budget cannot terminalize — it must PROVE oversize server-side.
      await expect(fin({ from: 'S <s@x.com>', to: 'a@example.com', subject: 's', html: '<p>tiny</p>' })).rejects.toThrow(/not oversize/i);
      // (b) an oversize request whose destination doesn't match the group fingerprint is rejected.
      await expect(fin({ from: 'S <s@x.com>', to: 'attacker@evil.com', subject: 's', html: bigHtml })).rejects.toThrow(/destination|fingerprint/i);
      expect(fpA).toBeTruthy();
      // (c) a multi-item group is reducible → must split, never terminalize (even with a genuinely oversize render).
      await seedDigestGroup(c, 'g2:1', 'b@example.com', [{ title: 'x' }, { title: 'y' }]);
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: nowIso, p_max_groups: 100, p_max_members_per_call: 100 });
      const g2 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='g2:1'`)).rows[0].id;
      await rpc('claim_notification_digest_group', { p_run_id: drun, p_channel: 'email', p_now: nowIso, p_worker: 'W' });
      await rpc('prepare_notification_digest_group', { p_run_id: drun, p_group_id: g2, p_worker: 'W', p_now: nowIso });
      await expect(rpc('finalize_notification_digest_render_oversize', { p_run_id: drun, p_group_id: g2, p_worker: 'W', p_frozen_request: { from: 'S <s@x.com>', to: 'b@example.com', subject: 's', html: bigHtml }, p_now: nowIso })).rejects.toThrow(/split/i);
      // (d) a non-'prepared' (here request_ready) group is rejected — only prepared, no live reservations to strand.
      await rpc('store_notification_digest_request', { p_run_id: drun, p_group_id: g, p_worker: 'W', p_frozen_request: { from: 'S <s@x.com>', to: 'a@example.com', subject: 's', html: '<p>x</p>' }, p_now: nowIso });
      await expect(fin({ from: 'S <s@x.com>', to: 'a@example.com', subject: 's', html: bigHtml })).rejects.toThrow(/not owned\/prepared/i);
    } finally { await c.end(); }
  });

  it('multi-item RENDER oversize → split into children that then send (never terminalized whole)', async () => {
    const c = conn(); await c.connect();
    try {
      // 44 items whose RAW bytes total ~36 KB (one group under the 90 KB / 50-item budget), but whose titles are
      // all "<" — HTML-escaped to "&lt;" (4×), the render balloons to ~143 KB (>90 KB) → split into two 22-item
      // children of ~72 KB each, which both fit and send. A single split level (no cascade).
      const items = Array.from({ length: 44 }, () => ({ title: '<'.repeat(800) }));
      await seedDigestGroup(c, 's:1', 'a@example.com', items);
      const s = await runDigestWorker(mkDeps(c, { limits: { ...FIXED_LIMITS, maxAttempts: 50 } }));
      expect(s.oversizeSplit).toBeGreaterThanOrEqual(1);
      const parent = (await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='s:1' AND parent_group_id IS NULL`)).rows[0];
      expect(parent.state).toBe('superseded');
      const kids = (await c.query(`SELECT state FROM public.notification_digest_groups WHERE parent_group_id IS NOT NULL`)).rows;
      expect(kids.length).toBeGreaterThanOrEqual(2);
      expect(kids.every((k) => k.state === 'sent')).toBe(true);         // every child fit + sent
    } finally { await c.end(); }
  });

  it('record-failure: run is reported FAILED (never a healthy 200), the attempt stays live, a later run recovers it', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // first run: record throws AFTER the send → group left 'sending' with an unrecorded attempt. The failure is
      // caught (independent groups keep going) but the RUN is unhealthy: status 'error' → the run row is 'failed'.
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'record_notification_digest_result' ? Promise.reject(new Error('db blip')) : r(n, a));
      const s1 = await runDigestWorker(mkDeps(c, { wrapRpc }));
      expect(s1.status).toBe('error'); expect(s1.groupErrors).toBe(1); // a failed group is NEVER a healthy run
      const run = (await c.query(`SELECT status FROM public.notification_worker_runs WHERE run_id=$1`, [s1.dispatchRunId])).rows[0];
      expect(run.status).toBe('failed');
      const g1 = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g1.state).toBe('sending');
      // second run, ≥15 min later: claim's stale-lease reclaim recovers the group (sending → request_ready +
      // uncertainty), then re-attempts it under the SAME dg:v1 key (Resend dedupes → no double delivery) →
      // converges to 'sent'. Two attempts, one idempotency key.
      const later = new Date(NOW.getTime() + 20 * 60 * 1000);
      await runDigestWorker(mkDeps(c, { now: () => later }));
      const g2 = await gstate(c, g1.id);
      expect(g2.state).toBe('sent');                                    // recovered + delivered, not stuck
      const atts = (await c.query(`SELECT count(*)::int n, count(DISTINCT provider_idempotency_key)::int k FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g1.id])).rows[0];
      expect(atts.n).toBe(2); expect(atts.k).toBe(1);
    } finally { await c.end(); }
  });

  it('state-aware RETRY: a 429 returns the group to request_ready; the next run re-attempts via begin — NO re-render — reusing the identical frozen request + dg:v1 key', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 'retry me', url: 'https://x/1' }]);
      // run 1 — 429 → request_ready (a live retry), frozen request persisted.
      const send1: DepOverrides['sendCalls'] = [];
      await runDigestWorker(mkDeps(c, { sendCalls: send1, send: () => ({ kind: 'response', httpStatus: 429, providerMessageId: null, errorName: 'rate_limit_exceeded', retryAfterSeconds: 1 }) }));
      const g1 = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g1.state).toBe('request_ready'); expect(g1.frozen_request).not.toBeNull();
      const frozenAfter1 = g1.frozen_request; const hashAfter1 = g1.request_hash;
      // run 2 — later so available_at has passed; the group is claimed IN request_ready. The worker must NOT
      // call prepare/store/split — only begin → send the SAME persisted request. Assert no re-render happened.
      const later = new Date(NOW.getTime() + 5 * 60 * 1000);
      const send2: DepOverrides['sendCalls'] = []; const names2: string[] = [];
      const s2 = await runDigestWorker(mkDeps(c, { now: () => later, sendCalls: send2, rpcNames: names2 }));
      expect(s2.sent).toBe(1);
      expect(names2).not.toContain('prepare_notification_digest_group');   // no re-prepare
      expect(names2).not.toContain('store_notification_digest_request');   // no re-store / re-render
      const g2 = await gstate(c, g1.id);
      expect(g2.state).toBe('sent');
      // the request the second attempt sent is byte-identical to the one frozen before the first attempt.
      expect(send2.length).toBe(1);
      expect(send1[0].payload).toEqual(send2[0].payload);
      expect(send1[0].opts.idempotencyKey).toBe(send2[0].opts.idempotencyKey); // one dg:v1 key across retries
      // send == the persisted request (single-string `to` → array); the frozen row never changed between attempts.
      expect(send2[0].payload).toEqual({ from: frozenAfter1.from, to: [frozenAfter1.to], subject: frozenAfter1.subject, html: frozenAfter1.html });
      // two attempts total, both under the same idempotency key.
      const atts = (await c.query(`SELECT count(*)::int n, count(DISTINCT provider_idempotency_key)::int k FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g1.id])).rows[0];
      expect(atts.n).toBe(2); expect(atts.k).toBe(1);
      expect(hashAfter1).toBeTruthy();
    } finally { await c.end(); }
  });

  it('PII-safe logs: a thrown error that echoes an email + token is REDACTED before it reaches the log', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // inject a per-group failure whose message carries a recipient email + a secret-ish token.
      const token = 'sk_live_' + 'a'.repeat(40);
      const wrapRpc: DepOverrides['wrapRpc'] = (r) => (n, a) => (n === 'record_notification_digest_result'
        ? Promise.reject(new Error(`delivery to victim@example.com with token ${token} failed`)) : r(n, a));
      const logs: Record<string, unknown>[] = [];
      await runDigestWorker(mkDeps(c, { wrapRpc, logs }));
      const ge = logs.find((l) => l.event === 'group_error');
      expect(ge).toBeTruthy();
      const err = String(ge!.error);
      expect(err).not.toContain('victim@example.com');   // no recipient PII
      expect(err).not.toContain('sk_live_');              // no token
      expect(err).toContain('[redacted-email]');          // proof the redactor ran
    } finally { await c.end(); }
  });

  it('no session-scoped cron lock: the worker NEVER calls try_lock_cron_job / unlock_cron_job (state-machine claims are the boundary)', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      const names: string[] = [];
      const s = await runDigestWorker(mkDeps(c, { rpcNames: names }));
      expect(names).not.toContain('try_lock_cron_job');
      expect(names).not.toContain('unlock_cron_job');
      expect(names).toContain('claim_notification_digest_group');   // it DID drive the real claim path
      expect(Array.isArray(s.reconcile)).toBe(true);                // and always reconciles the run
      expect(s.dispatchRunId).toBeTruthy();                         // …exposing the safe run id
    } finally { await c.end(); }
  });

  it('two concurrent workers never double-send: each group sent exactly once', async () => {
    const c0 = conn(); await c0.connect();
    try { for (let i = 0; i < 6; i++) await seedDigestGroup(c0, `p:${i}`, `u${i}@example.com`, [{ title: 't' }]); } finally { await c0.end(); }
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      await Promise.all([
        runDigestWorker(mkDeps(a, { tokenSuffix: 'A' })),
        runDigestWorker(mkDeps(b, { tokenSuffix: 'B' })),
      ]);
      const cc = conn(); await cc.connect();
      // every group is sent, and each has exactly ONE recorded attempt (no double-send)
      const dup = (await cc.query(`SELECT count(*)::int n FROM (SELECT digest_group_id FROM public.notification_digest_attempts WHERE recorded_at IS NOT NULL GROUP BY digest_group_id HAVING count(*)>1) x`)).rows[0].n;
      const sent = (await cc.query(`SELECT count(*)::int n FROM public.notification_digest_groups WHERE state='sent'`)).rows[0].n;
      await cc.end();
      expect(dup).toBe(0); expect(sent).toBe(6);
    } finally { await a.end(); await b.end(); }
  });

  it('stale-lease recovery: a crashed worker\'s "sending" group is reclaimed on the next run', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:1', 'a@example.com', [{ title: 't' }]);
      // simulate a crash after begin: the send throws → the group is left 'sending', stale-locked, with a live
      // (unrecorded) attempt. The run is unhealthy (caught group error) but not thrown.
      const s1 = await runDigestWorker(mkDeps(c, { send: () => { throw new Error('process died mid-send'); } }));
      expect(s1.status).toBe('error');
      const g1 = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='p:1'`)).rows[0];
      expect(g1.state).toBe('sending');
      // next run (past the stale lease): the crashed group is reclaimed → re-attempted under the SAME dg:v1 key
      // → delivered. Two attempts, one key (idempotent — no double delivery).
      const later = new Date(NOW.getTime() + 30 * 60 * 1000);
      await runDigestWorker(mkDeps(c, { now: () => later }));
      const g2 = await gstate(c, g1.id);
      expect(g2.state).toBe('sent');
      const atts = (await c.query(`SELECT count(*)::int n, count(DISTINCT provider_idempotency_key)::int k FROM public.notification_digest_attempts WHERE digest_group_id=$1`, [g1.id])).rows[0];
      expect(atts.n).toBe(2); expect(atts.k).toBe(1);
    } finally { await c.end(); }
  });
});

// ===========================================================================
describe('10c-b E — the orphan provider-event lifecycle', () => {
  it('an UNCORRELATED callback is enrolled, then linked by the worker drain', async () => {
    // The gap E closes: until now nothing drained the orphan queue. The SQL shipped INERT and said
    // so — "Deploy BEFORE any webhook may ack an `orphan` (PR-2)" — so an enrolled callback sat
    // there for ever and its group aged out through the stale sweep as if the send had gone
    // unanswered.
    //
    // HOW THIS FIXTURE RELATES TO PRODUCTION, stated rather than implied. The precondition for an
    // orphan is "the tagged group has no live send to correlate against" (bind → no_live_send).
    // That is NOT the HTTP race: production commits begin_notification_digest_attempt before the
    // request, so a callback racing the response finds a live attempt and binds directly. It is
    // reached instead when the tagged group holds no live attempt at all. Which production
    // sequences arrive there is 10c-a3's premise for building the queue, not something this test
    // claims to prove — and it is NOT the oversize split either: a superseded parent is retired
    // before any provider request, so nothing ever carries its tag. So the fixture constructs the
    // classifier's precondition DIRECTLY (materialize without dispatching) and is honest that
    // what it exercises is the DRAIN. The webhook's own record-then-apply ORDER is exercised
    // separately, against production code, in resend-webhook-events.test.ts.
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:orph', 'orph@example.com', [{ title: 't' }]);
      // Materialize WITHOUT dispatching (maxAttempts 0): the group exists but has no attempt at
      // all, so there is nothing to correlate a provider message id against. That is precisely
      // the window in which a callback can arrive first — and note a crashed send is NOT it: the
      // attempt row is live by then, so the bind succeeds and the transition applies immediately.
      await runDigestWorker(mkDeps(c, { limits: { ...FIXED_LIMITS, maxAttempts: 0 } }));
      const gid = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:orph'`)).rows[0].id;

      const outcome = (await c.query(
        `SELECT public.apply_notification_provider_event(
           p_run_id => NULL, p_resend_event_id => 'evt_early', p_provider_message_id => 're_early',
           p_digest_group_id => $1, p_status => 'delivered',
           p_occurred_at => $2::timestamptz, p_now => $2::timestamptz) AS r`,
        // the fixture clock, not wall time: the drain runs at NOW, and a row enrolled at real
        // "now" would not be due yet.
        [gid, NOW.toISOString()])).rows[0].r;
      expect(outcome, 'nothing to correlate yet → enrolled, not applied and not lost').toBe('orphan');
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_orphan_reconcile_state`)).rows[0].n).toBe(1);

      // The next run dispatches the group (binding re_early) and, in the SAME invocation, drains
      // the queue — so the early callback finally reaches its group.
      const summary = await runDigestWorker(mkDeps(c, {
        send: () => ({ kind: 'response', httpStatus: 202, providerMessageId: 're_early', errorName: null, retryAfterSeconds: null }),
      }));
      expect(summary.orphansExamined).toBeGreaterThanOrEqual(1);
      expect(summary.orphansLinked).toBe(1);
      const linked = (await c.query(
        `SELECT digest_group_id FROM public.notification_provider_events WHERE resend_event_id='evt_early'`)).rows[0];
      expect(linked.digest_group_id, 'correlated to its ORIGINAL tagged group').toBe(gid);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_orphan_reconcile_state`)).rows[0].n)
        .toBe(0);
    } finally { await c.end(); }
  });

  it('an IN-BAND drain error makes the run unhealthy — the SQL catches link failures on purpose', async () => {
    // reconcile_orphan_provider_events deliberately catches a link failure and RETURNS it as
    // `errors` rather than aborting the drain, so a worker that only watched the throw path
    // reported a run that stranded evidence — and quarantined it — as a healthy 200 with no
    // alert. This drives the real SQL into that shape: an orphan whose tagged group ends up
    // bound to a DIFFERENT provider message id can never be linked to it.
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:orph3', 'orph3@example.com', [{ title: 't' }]);
      await runDigestWorker(mkDeps(c, { limits: { ...FIXED_LIMITS, maxAttempts: 0 } }));
      const gid = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='p:orph3'`)).rows[0].id;
      await c.query(
        `SELECT public.apply_notification_provider_event(
           p_run_id => NULL, p_resend_event_id => 'evt_gone', p_provider_message_id => 're_gone',
           p_digest_group_id => $1, p_status => 'delivered',
           p_occurred_at => $2::timestamptz, p_now => $2::timestamptz)`, [gid, NOW.toISOString()]);

      // the group then sends under a DIFFERENT provider message id, so the enrolled event can
      // never be linked to the group its tag names
      const summary = await runDigestWorker(mkDeps(c, {
        send: () => ({ kind: 'response', httpStatus: 202, providerMessageId: 're_other', errorName: null, retryAfterSeconds: null }),
      }));
      expect(summary.orphanErrors, 'the RPC returned normally, but it returned an error').toBeGreaterThanOrEqual(1);
      expect(summary.status, 'stranded evidence must never read as a healthy 200').toBe('error');

      // ...and a QUARANTINED orphan keeps the run red on EVERY later invocation, until a human
      // resolves it. Failing only on the run that parked it would leave a permanent
      // operator-required item behind a single best-effort Slack call.
      await c.query(`UPDATE public.notification_orphan_reconcile_state
                        SET quarantined = true, last_error_code = 'tagged_mismatch', attempts = 1`);
      const later = await runDigestWorker(mkDeps(c));
      expect(later.orphanErrors, 'a quarantined row is excluded from the drain itself').toBe(0);
      expect(later.orphansQuarantined, 'but it is still parked, and still counted').toBeGreaterThanOrEqual(1);
      expect(later.status, 'so the run stays unhealthy until someone acts').toBe('error');
    } finally { await c.end(); }
  });

  it('a drain that THROWS makes the run unhealthy — never a silent 200', async () => {
    // The queue is the only path by which an early callback reaches its group, so a broken drain
    // reported as healthy would hide groups that go on to age out as undelivered.
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'p:orph2', 'orph2@example.com', [{ title: 't' }]);
      const base = mkDeps(c);
      const summary = await runDigestWorker({
        ...base,
        rpc: async (name, args) => {
          if (name === 'reconcile_orphan_provider_events') throw new Error('drain exploded');
          return base.rpc(name, args);
        },
      });
      expect(summary.orphanErrors).toBe(1);
      expect(summary.status, 'an unhealthy run is never reported as a healthy 200').toBe('error');
      // ...and the send itself still happened: a drain failure must not stop delivery.
      expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE recipient_key='p:orph2'`))
        .rows[0].state).toBe('sent');
    } finally { await c.end(); }
  });
});

describe('N4 M2 — the channel kill switch over the digest engine', () => {
  const kill = (c: pg.Client, channel = 'email') =>
    c.query(`INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
             VALUES ($1, 'test kill', gen_random_uuid())`, [channel]);

  it('killed BEFORE the pass: claim + materialize idle — no group forms, nothing sends, the members stay pending', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'k:1', 'a@example.com', [{ title: 'x' }]);
      await kill(c);
      const sendCalls: DepOverrides['sendCalls'] = [];
      const s = await runDigestWorker(mkDeps(c, { sendCalls }));
      expect(s.status).toBe('ok');            // a kill is an ORDERLY idle, not a run failure
      expect(s.materialized).toBe(0);
      expect(s.claimed).toBe(0);
      expect(s.sent).toBe(0);
      expect(sendCalls.length).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_groups`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_outbox WHERE status <> 'pending'`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('killed BETWEEN claim and begin: begin PARKS via NULL — no attempt row, no budget burn, the group stays request_ready', async () => {
    const c = conn(); await c.connect();
    try {
      const rpc = mkRpc(c);
      const nowIso = NOW.toISOString();
      await seedDigestGroup(c, 'k:2', 'a@example.com', [{ title: 'x' }]);
      const mrun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'materialize' });
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: nowIso, p_max_groups: 100, p_max_members_per_call: 100 });
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='k:2'`)).rows[0].id;
      const drun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'dispatch' });
      expect(await rpc('claim_notification_digest_group', { p_run_id: drun, p_channel: 'email', p_now: nowIso, p_worker: 'W' })).toBe(g);
      await rpc('prepare_notification_digest_group', { p_run_id: drun, p_group_id: g, p_worker: 'W', p_now: nowIso });
      await rpc('store_notification_digest_request', { p_run_id: drun, p_group_id: g, p_worker: 'W', p_frozen_request: { from: 'S <s@x.com>', to: 'a@example.com', subject: 's', html: '<p>x</p>' }, p_now: nowIso });
      expect((await gstate(c, g)).state).toBe('request_ready');
      await kill(c);   // lands with the group one step from the provider
      // begin — the step that mints the attempt — PARKS with the breaker's own defer transition
      expect(await rpc('begin_notification_digest_attempt', { p_run_id: drun, p_group_id: g, p_worker: 'W', p_now: nowIso })).toBeNull();
      const parked = await gstate(c, g);
      expect(parked.state).toBe('request_ready');
      expect(parked.locked_by).toBeNull();                       // genuinely RELEASED, not stranded on the lease
      expect(new Date(parked.available_at).getTime()).toBeGreaterThan(NOW.getTime());  // bounded backoff
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_attempts`)).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_digest_group_attempts WHERE action='deferred'`)).rows[0].n).toBe(1);
      // …the NEXT pass cannot re-claim it while killed…
      const drun2 = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'dispatch' });
      const later = new Date(NOW.getTime() + 3600_000).toISOString();
      expect(await rpc('claim_notification_digest_group', { p_run_id: drun2, p_channel: 'email', p_now: later, p_worker: 'W' })).toBeNull();
      // …and the moment the kill is lifted (runbook reset) the parked group is claimable AGAIN —
      // request_ready + unowned is a legal due shape, no stale window needed
      await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
      await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
      await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
      expect(await rpc('claim_notification_digest_group', { p_run_id: drun2, p_channel: 'email', p_now: later, p_worker: 'W' })).toBe(g);
    } finally { await c.end(); }
  });

  it("killed BETWEEN claim and prepare: the worker gets the TYPED park ('channel_killed'), counts it deferred, renders nothing", async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'k:4', 'a@example.com', [{ title: 'x' }]);
      const sendCalls: DepOverrides['sendCalls'] = [];
      // the deterministic mid-run kill: the moment the REAL claim returns this group, the kill
      // row lands — before the worker's next rpc (prepare) fires
      let killed = false;
      const s = await runDigestWorker(mkDeps(c, {
        sendCalls,
        wrapRpc: (rpc) => async (name, args) => {
          const out = await rpc(name, args);
          if (name === 'claim_notification_digest_group' && out && !killed) {
            killed = true;
            await kill(c);
          }
          return out;
        },
      }));
      expect(s.status).toBe('ok');
      expect(s.deferred).toBe(1);
      expect(s.sent).toBe(0);
      expect(sendCalls.length).toBe(0);
      const g = (await c.query(`SELECT * FROM public.notification_digest_groups WHERE recipient_key='k:4'`)).rows[0];
      expect(g.state).toBe('leased');            // the lease is KEPT (no legal unowned-leased shape)…
      expect(g.locked_by).not.toBeNull();        // …and rides the bounded stale-reclaim window
    } finally { await c.end(); }
  });

  it('a WHATSAPP kill leaves the email digest fully live — channels are independent', async () => {
    const c = conn(); await c.connect();
    try {
      await seedDigestGroup(c, 'k:3', 'a@example.com', [{ title: 'x' }]);
      await kill(c, 'whatsapp');
      const sendCalls: DepOverrides['sendCalls'] = [];
      const s = await runDigestWorker(mkDeps(c, { sendCalls }));
      expect(s.sent).toBe(1);
      expect(sendCalls.length).toBe(1);
    } finally { await c.end(); }
  });
});

describe('N5 — the digest path may not shape historical work into groups', () => {
  const past = () => new Date(Date.now() - 6 * 3600_000).toISOString();

  it('a PRE-boundary row is never materialized, and never joins a post-boundary group', async () => {
    const c = conn(); await c.connect();
    try {
      const rpc = mkRpc(c);
      const nowIso = NOW.toISOString();
      // the same recipient key and destination, so both rows belong to ONE canonical group: the
      // member scan is the only thing that can keep them apart, and a missing predicate there
      // delivers the backlog INSIDE a legitimately formed digest.
      await seedDigestGroup(c, 'n5:1', 'n5@example.com', [{ title: 'historical' }], past());
      await seedDigestGroup(c, 'n5:1', 'n5@example.com', [{ title: 'fresh' }]);
      const mrun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'materialize' });
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: nowIso, p_max_groups: 100, p_max_members_per_call: 100 });
      const rows = (await c.query(
        `SELECT digest_item ->> 'title' AS title, digest_group_id FROM public.notification_outbox
          WHERE recipient_key = 'n5:1' ORDER BY created_at`)).rows;
      expect(rows.map((r) => r.title)).toEqual(['historical', 'fresh']);
      expect(rows[0].digest_group_id).toBeNull();       // the backlog row stays outside every group
      expect(rows[1].digest_group_id).not.toBeNull();
      const g = (await c.query(
        `SELECT item_count FROM public.notification_digest_groups WHERE id = $1`, [rows[1].digest_group_id])).rows[0];
      expect(Number(g.item_count)).toBe(1);             // …and the group it did form carries ONLY it
    } finally { await c.end(); }
  });

  it('an INERT digest path forms NO groups at all — the engine-enable cannot hand activation a backlog', async () => {
    const c = conn(); await c.connect();
    try {
      const rpc = mkRpc(c);
      // close the path for this connection's world by proving the gate, not by editing state:
      // a fresh database has it inert, so drop this suite's opened boundary the sanctioned way
      await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard`);
      await c.query(`UPDATE public.notification_activation_boundaries
                        SET state='inert', boundary_at=NULL, request_id=NULL, reason=NULL WHERE path='email:digest'`);
      await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard`);
      try {
        await seedDigestGroup(c, 'n5:inert', 'inert@example.com', [{ title: 'x' }]);
        const mrun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'materialize' });
        const formed = await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: NOW.toISOString(), p_max_groups: 100, p_max_members_per_call: 100 });
        expect(formed).toBe(0);
        expect((await c.query(
          `SELECT count(*)::int n FROM public.notification_digest_groups WHERE recipient_key='n5:inert'`)).rows[0].n).toBe(0);
        expect((await c.query(
          `SELECT digest_group_id FROM public.notification_outbox WHERE recipient_key='n5:inert'`)).rows[0].digest_group_id).toBeNull();
      } finally {
        // …and re-open it for the rest of the suite, through the REAL RPC
        await c.query(`SELECT public.record_notification_activation_boundary('email:digest','re-opened after the inert case', gen_random_uuid())`);
      }
    } finally { await c.end(); }
  });
});

describe('N5 round 2 — a group that predates the boundary never reaches the provider', () => {
  it('an EXISTING group holding a pre-boundary member is passed over by the claim, and nothing is sent', async () => {
    const c = conn(); await c.connect();
    try {
      const rpc = mkRpc(c);
      const nowIso = NOW.toISOString();
      // form the group legitimately (post-boundary), then BACKDATE its member: the shape a group
      // materialized before the path was opened would have, and the one round 1 could not see —
      // materialization had already happened, so its gate no longer applies.
      await seedDigestGroup(c, 'n5b:1', 'n5b@example.com', [{ title: 'historical' }]);
      const mrun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'materialize' });
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: nowIso, p_max_groups: 100, p_max_members_per_call: 100 });
      const g = (await c.query(`SELECT id, state FROM public.notification_digest_groups WHERE recipient_key='n5b:1'`)).rows[0];
      expect(g.state).toBe('pending');
      await c.query(
        `UPDATE public.notification_outbox SET created_at = now() - interval '9 hours' WHERE digest_group_id = $1`, [g.id]);

      const drun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'dispatch' });
      const claimed = await rpc('claim_notification_digest_group', { p_run_id: drun, p_channel: 'email', p_now: nowIso, p_worker: 'W' });
      expect(claimed).toBeNull();                       // passed over: no ownership, so no send path
      const after = (await c.query(`SELECT state, locked_by, terminal_at FROM public.notification_digest_groups WHERE id=$1`, [g.id])).rows[0];
      expect(after).toMatchObject({ state: 'pending', locked_by: null, terminal_at: null });   // and NOT terminalized behind the operator's back

      // …while a group whose members are all post-boundary is claimed normally
      await seedDigestGroup(c, 'n5b:2', 'n5b2@example.com', [{ title: 'fresh' }]);
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: nowIso, p_max_groups: 100, p_max_members_per_call: 100 });
      const g2 = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='n5b:2'`)).rows[0];
      expect(await rpc('claim_notification_digest_group', { p_run_id: drun, p_channel: 'email', p_now: nowIso, p_worker: 'W' })).toBe(g2.id);
    } finally { await c.end(); }
  });

  it('an INERT digest path dispatches nothing, even for a group that already exists', async () => {
    const c = conn(); await c.connect();
    try {
      const rpc = mkRpc(c);
      await seedDigestGroup(c, 'n5b:3', 'n5b3@example.com', [{ title: 'x' }]);
      const mrun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'materialize' });
      await rpc('materialize_notification_digest_groups', { p_run_id: mrun, p_channel: 'email', p_now: NOW.toISOString(), p_max_groups: 100, p_max_members_per_call: 100 });
      const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key='n5b:3'`)).rows[0];
      await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard`);
      await c.query(`UPDATE public.notification_activation_boundaries
                        SET state='inert', boundary_at=NULL, request_id=NULL, reason=NULL WHERE path='email:digest'`);
      await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard`);
      try {
        const drun = await rpc('start_notification_worker_run', { p_worker: 'W', p_channel: 'email', p_phase: 'dispatch' });
        expect(await rpc('claim_notification_digest_group', { p_run_id: drun, p_channel: 'email', p_now: NOW.toISOString(), p_worker: 'W' })).toBeNull();
        expect((await c.query(`SELECT locked_by FROM public.notification_digest_groups WHERE id=$1`, [g.id])).rows[0].locked_by).toBeNull();
      } finally {
        await c.query(`SELECT public.record_notification_activation_boundary('email:digest','re-opened after the inert dispatch case', gen_random_uuid())`);
      }
    } finally { await c.end(); }
  });
});
