import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

/**
 * N4 M2 — the per-channel KILL SWITCHES, instant side (contract CRITICAL 2 + HIGH 5).
 * Digest-side gates (claim/materialize/begin) are proven in digestWorker.realpg.test.ts over
 * the full engine; what lives here:
 *
 *  * the kill surface is SET-ONLY, owner-effectively: no UPDATE/DELETE/TRUNCATE by any path,
 *    and NO function in the schema can clear a kill;
 *  * claim_notification_outbox_batch refuses a killed channel FIRST — before the cap-cancel
 *    and the reap — with ZERO ledger mutations (a reapable stale row survives untouched);
 *  * kill-set and claim share the per-channel advisory lock: deterministic, both directions;
 *  * release gives claimed rows back — pending, the claim's attempt increment undone, a
 *    backoff — token-guarded, digest rows untouched;
 *  * channels are independent; the pre-provider read is service-role-only.
 *
 * REAL DDL doctrine: the outbox, event-types and restrictions tables and every function under
 * test come from the actual migrations, extracted verbatim — a hand-built stand-in is exactly
 * what hid the r.id-vs-run_id defect from M1's first battery.
 */

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
let c2: InstanceType<typeof Client>;
const PORT = 54439;
const MIG = (f: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8');

const ADMIN = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';

const killDirect = async (channel = 'email') =>
  c.query(`INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id)
           VALUES ($1, 'test kill', gen_random_uuid())`, [channel]);
const adminKill = async (client: InstanceType<typeof Client>, uid: string | null, channel = 'email', req?: string, reason = 'ops decided') => {
  await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  try {
    return (await client.query(`SELECT public.admin_activate_channel_kill($1,$2,$3) AS r`,
      [channel, reason, req ?? crypto.randomUUID()])).rows[0].r as string;
  } finally {
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  }
};
const seedRow = async (over: Partial<{ status: string; channel: string; locked_at: string; locked_by: string; attempts: number; max_attempts: number; delivery_mode: string; created_at: string }> = {}) => {
  const r = await c.query(
    `INSERT INTO public.notification_outbox
       (channel, event_type, template_key, status, destination_normalized, scheduled_for,
        locked_at, locked_by, attempts, max_attempts, delivery_mode, payload, idempotency_key, recipient_user_id,
        created_at)
     VALUES ($1, 'ev_test', 'tpl', $2, 'a@example.com', now() - interval '1 minute',
             $3, $4, $5, $6, $7, jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, '22222222-2222-4222-8222-222222222222',
             coalesce($8::timestamptz, now()))
     RETURNING id`,
    [over.channel ?? 'email', over.status ?? 'pending', over.locked_at ?? null, over.locked_by ?? null,
     over.attempts ?? 0, over.max_attempts ?? 3, over.delivery_mode ?? null, over.created_at ?? null]);
  return r.rows[0].id as string;
};
const claim = async (client: InstanceType<typeof Client>, worker = 'w:test', channel = 'email') =>
  (await client.query(`SELECT * FROM public.claim_notification_outbox_batch($1, $2, 20, 15)`, [channel, worker])).rows;
const rowOf = async (id: string) =>
  (await c.query(`SELECT * FROM public.notification_outbox WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n4kill-rp-'));
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
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE TYPE public.app_role AS ENUM ('player', 'trainer', 'admin');
  `);
  const rolesMig = MIG('20260115184937_a9f9b073-efb2-4069-8c85-10e3c65c6124.sql');
  const userRolesDdl = rolesMig.match(/CREATE TABLE public\.user_roles \([\s\S]*?\);/)?.[0];
  const hasRole = rolesMig.match(/CREATE OR REPLACE FUNCTION public\.has_role[\s\S]*?\$\$;/)?.[0];
  if (!userRolesDdl || !hasRole) throw new Error('user_roles/has_role not found');
  await c.query(userRolesDdl);
  await c.query(hasRole);
  await c.query(`INSERT INTO auth.users (id) VALUES ($1), ($2)`, [ADMIN, PLAYER]);
  await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1,'admin'), ($2,'player')`, [ADMIN, PLAYER]);

  // REAL DDL: the outbox + event catalog from the foundation migration; the digest columns the
  // claim's predicates read from the digest foundation; the restrictions table from N3.
  // minimal FK targets the real outbox DDL references (shape-only stubs; nothing under test
  // reads them — the tables under test are extracted verbatim below)
  await c.query(`
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, email text);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    CREATE TABLE public.invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  // the REAL contacts DDL (M6's indexes and the search read its real columns)
  {
    const f0 = MIG('20260910100000_notification_foundation_schema.sql');
    const contactsDdl = f0.match(/CREATE TABLE public\.notification_contacts \([\s\S]*?\n\);/)?.[0];
    if (!contactsDdl) throw new Error('contacts DDL not found');
    await c.query(contactsDdl);
  }
  await c.query(`SELECT 1`);
  await c.query(`
    SELECT 1;
  `);
  const foundation = MIG('20260910100000_notification_foundation_schema.sql');
  const outboxDdl = foundation.match(/CREATE TABLE public\.notification_outbox \([\s\S]*?\);/)?.[0];
  const eventsDdl = foundation.match(/CREATE TABLE public\.notification_event_types \([\s\S]*?\);/)?.[0];
  if (!outboxDdl || !eventsDdl) throw new Error('outbox/event_types DDL not found in the foundation migration');
  await c.query(eventsDdl);
  await c.query(outboxDdl);
  const digestFoundation = MIG('20261002100000_notification_digest_schema_foundation.sql');
  const outboxAlter = digestFoundation.match(/ALTER TABLE public\.notification_outbox\n(?: {2}ADD COLUMN IF NOT EXISTS[\s\S]*?;)/)?.[0];
  if (!outboxAlter) throw new Error('outbox digest ALTER not found');
  await c.query(outboxAlter);
  const eventsAlter = digestFoundation.match(/ALTER TABLE public\.notification_event_types\n(?: {2}ADD COLUMN IF NOT EXISTS digest_engine_enabled[\s\S]*?;)/)?.[0];
  if (!eventsAlter) throw new Error('event_types digest ALTER not found');
  await c.query(eventsAlter);
  const n3 = MIG('20261015110000_notif_n3_academy_restrictions.sql');
  const restrictionsDdl = n3.match(/CREATE TABLE public\.academy_notification_restrictions \([\s\S]*?\);/)?.[0];
  if (!restrictionsDdl) throw new Error('restrictions DDL not found');
  await c.query(restrictionsDdl);
  await c.query(`INSERT INTO public.notification_event_types (key, category, audience, priority) VALUES ('ev_test', 'booking', 'player', 'transactional')`);

  // M4's read surface joins the digest/runs/orphan tables — REAL DDL, extracted verbatim
  const dig = MIG('20261002100000_notification_digest_schema_foundation.sql');
  for (const t of ['notification_worker_runs', 'notification_digest_groups', 'notification_digest_attempts',
    'notification_provider_circuit', 'notification_provider_events']) {
    const ddl = dig.match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?public\\.${t} \\([\\s\\S]*?\\n\\);`))?.[0];
    if (!ddl) throw new Error(`${t} DDL not found in the digest foundation`);
    await c.query(ddl);
  }
  // digest_group_id references the groups table, so its ALTER runs after the groups DDL
  const groupIdAlter = dig.match(/ALTER TABLE public\.notification_outbox\n {2}ADD COLUMN IF NOT EXISTS digest_group_id[\s\S]*?;/)?.[0];
  if (!groupIdAlter) throw new Error('digest_group_id ALTER not found');
  await c.query(groupIdAlter);
  const orph = MIG('20261006110000_reconcile_orphan_provider_events.sql');
  const orphDdl = orph.match(/CREATE TABLE (?:IF NOT EXISTS )?public\.notification_orphan_reconcile_state \([\s\S]*?\n\);/)?.[0];
  if (!orphDdl) throw new Error('orphan state DDL not found');
  await c.query(orphDdl);
  const edev = MIG('20260615110000_email_delivery_tables.sql');
  const edevDdl = edev.match(/CREATE TABLE (?:IF NOT EXISTS )?public\.email_delivery_events \([\s\S]*?\n\);/)?.[0];
  if (!edevDdl) throw new Error('email_delivery_events DDL not found');
  await c.query(edevDdl);
  // ...and the foundation migration's GENERALIZED-delivery-log ALTER: outbox_id is the causal
  // join the history reader uses (missing it here once hid the real column from review)
  const edevAlter = foundation.match(/ALTER TABLE public\.email_delivery_events\n {2}ADD COLUMN IF NOT EXISTS channel[\s\S]*?;/)?.[0];
  if (!edevAlter) throw new Error('email_delivery_events generalization ALTER not found');
  await c.query(edevAlter);
  await c.query(MIG('20261016100000_notif_n4_worker_invocations.sql'));   // gauges expose invocations
  await c.query(MIG('20261016110000_notif_n4_invocation_claim.sql'));      // the invocation admin reader is part of the pinned surface
  await c.query(MIG('20261017100000_notif_n4_channel_kill_switches.sql'));
  // M3: the ops audit — redefines admin_activate_channel_kill THROUGH the audit (global
  // request lock → audit replay → channel lock), so every admin test below exercises the
  // audited, newest definition.
  await c.query(MIG('20261018100000_notif_n4_admin_ops_audit.sql'));
  await c.query(MIG('20261019100000_notif_n4_admin_reads.sql'));
  // M5 needs: the group-attempts ledger table + the ledger/finalize pair (REAL, extracted from
  // the state machine) and the WHOLE orphan migration (its recovery fns are what M5 wraps)
  const gaDdl = dig.match(/CREATE TABLE (?:IF NOT EXISTS )?public\.notification_digest_group_attempts \([\s\S]*?\n\);/)?.[0];
  if (!gaDdl) throw new Error('group_attempts DDL not found');
  await c.query(gaDdl);
  const sm = MIG('20261004100000_notification_digest_state_machine.sql');
  for (const fn of ['notif_digest_ledger', 'notif_digest_finalize_group']) {
    const def = sm.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\([\\s\\S]*?\\n(?:END )?\\$\\$(?:\\s+LANGUAGE\\s+plpgsql)?;`))?.[0];
    if (!def) throw new Error(`${fn} not found in the state machine`);
    await c.query(def);
  }
  // M6's preview index targets the v2 preferences table — real DDL, extracted
  const prefsDdl = foundation.match(/CREATE TABLE public\.notification_preferences_v2 \([\s\S]*?\n\);/)?.[0];
  if (!prefsDdl) throw new Error('preferences_v2 DDL not found');
  await c.query(prefsDdl);
  await c.query(MIG('20261006110000_reconcile_orphan_provider_events.sql'));
  await c.query(MIG('20261020100000_notif_n4_send_enabling_recovery.sql'));
  // M6 applies here too so the surface pin stays COMPLETE. Its expression INDEXES resolve
  // their function at CREATE time — the REAL fingerprint fn (newest definition), extracted.
  {
    const hashFix = MIG('20261005110000_notification_digest_request_hash_bytea_fix.sql');
    const fpFn = hashFix.match(/CREATE OR REPLACE FUNCTION public\.notif_digest_destination_fingerprint[\s\S]*?\$\$;/)?.[0];
    if (!fpFn) throw new Error('fingerprint fn not found');
    await c.query(fpFn);
  }
  await c.query(MIG('20261021100000_notif_n4_readiness_preview_search.sql'));
  await c.query(MIG('20261022100000_notif_n4_seam_corrections.sql'));
  await c.query(MIG('20261023100000_notif_n4_seam_corrections_round2.sql'));
  await c.query(MIG('20261024100000_notif_n4_seam_corrections_round3.sql'));
  await c.query(MIG('20261025100000_notif_n4_invocation_ownership_contract.sql'));
  // N5: the no-backlog activation boundary — the claim under test now gates on it
  await c.query(MIG('20261028100000_notif_n5_activation_boundary.sql'));
  await c.query(MIG('20261029100000_notif_n5_readiness_and_backlog_disposal.sql'));
  await c.query(MIG('20261030100000_notif_n5_round2_dispatch_boundary.sql'));
  await c.query(MIG('20261031100000_notif_n6_kill_clear.sql'));
}, 180_000);

afterAll(async () => { await c2?.end(); await c?.end(); await epg?.stop(); });

beforeEach(async () => {
  // clearing a kill is deliberately impossible through SQL — the harness resets the sanctioned
  // way (the same escape the owner's runbook documents)
  await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
  await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
  await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
  await c.query(`ALTER TABLE public.notification_admin_audit DISABLE TRIGGER trg_notif_admin_audit_guard;`);
  await c.query(`DELETE FROM public.notification_admin_audit;`);
  await c.query(`ALTER TABLE public.notification_admin_audit ENABLE TRIGGER trg_notif_admin_audit_guard;`);
  await c.query(`ALTER TABLE public.notification_admin_rejected_attempts DISABLE TRIGGER trg_notif_admin_rejected_guard;`);
  await c.query(`DELETE FROM public.notification_admin_rejected_attempts;`);
  await c.query(`ALTER TABLE public.notification_admin_rejected_attempts ENABLE TRIGGER trg_notif_admin_rejected_guard;`);
  await c.query(`ALTER TABLE public.notification_admin_requests DISABLE TRIGGER trg_notif_admin_requests_guard;`);
  await c.query(`DELETE FROM public.notification_admin_requests;`);
  await c.query(`ALTER TABLE public.notification_admin_requests ENABLE TRIGGER trg_notif_admin_requests_guard;`);
  await c.query(`DELETE FROM public.notification_outbox;`);
  await c.query(`DELETE FROM public.notification_provider_events;`);
  await c.query(`DELETE FROM public.notification_provider_circuit;`);
  await c.query(`DELETE FROM public.notification_digest_attempts;`);
  await c.query(`DELETE FROM public.notification_digest_groups;`);
  await c.query(`DELETE FROM public.notification_worker_runs;`);
  await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
  await c.query(`DELETE FROM public.notification_worker_invocations;`);
  await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
  await c.query(`DELETE FROM public.academy_notification_restrictions;`);
});

describe('admin_activate_channel_kill — the only write, admin-checked, request-id idempotent', () => {
  it('fail-closed: anonymous and non-admin callers are refused; admin succeeds', async () => {
    await expect(adminKill(c2, null)).rejects.toThrow(/platform admin only/);
    await expect(adminKill(c2, PLAYER)).rejects.toThrow(/platform admin only/);
    expect(await adminKill(c2, ADMIN)).toBe('killed');
    const row = (await c.query(`SELECT * FROM public.notification_channel_kill_switches WHERE channel='email'`)).rows[0];
    expect(row.activated_by).toBe(ADMIN);
    expect(row.reason).toBe('ops decided');
  });

  it('an exact request replay returns the same verdict; a reused id on another channel is refused', async () => {
    const req = crypto.randomUUID();
    expect(await adminKill(c2, ADMIN, 'email', req)).toBe('killed');
    expect(await adminKill(c2, ADMIN, 'email', req)).toBe('killed');   // network-retry replay
    // a reused id carrying a DIFFERENT decision (other reason) is refused TYPED — and recorded
    expect(await adminKill(c2, ADMIN, 'email', req, 'some other reason')).toBe('rejected_request_reuse');
    expect(await adminKill(c2, ADMIN, 'whatsapp', req)).toBe('rejected_request_reuse');
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(1);
  });

  it("a second, different kill request on an already-killed channel is 'already_killed' — the FIRST evidence stands", async () => {
    const req1 = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req1, 'first reason');
    expect(await adminKill(c2, ADMIN, 'email', crypto.randomUUID(), 'second reason')).toBe('already_killed');
    const row = (await c.query(`SELECT reason, request_id FROM public.notification_channel_kill_switches WHERE channel='email'`)).rows[0];
    expect(row.reason).toBe('first reason');
    expect(row.request_id).toBe(req1);
  });

  it('reason and channel are validated', async () => {
    await expect(adminKill(c2, ADMIN, 'email', undefined, 'x')).rejects.toThrow(/reason/);
    await expect(adminKill(c2, ADMIN, 'push')).rejects.toThrow(/unknown channel/);
  });
});

describe('SET-ONLY, owner-effectively — nothing clears a kill', () => {
  it('UPDATE, DELETE and TRUNCATE are refused even as the owner', async () => {
    await killDirect();
    await expect(c.query(`UPDATE public.notification_channel_kill_switches SET reason = 'edited' WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await expect(c.query(`DELETE FROM public.notification_channel_kill_switches WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await expect(c.query(`TRUNCATE public.notification_channel_kill_switches`))
      .rejects.toThrow(/SET-ONLY/);
  });

  it('exactly ONE function can clear a kill, it is runbook-only, and no ADMIN function can', async () => {
    // N4's contract was "nothing clears a kill", and the catalog proved it. N6 changed that on
    // purpose: "guard-disable + DELETE as superuser" is not a procedure, it is an invitation to
    // improvise on the control that decides whether mail resumes. What must still hold is that
    // the way back is ONE reviewed function, reachable only by the runbook — never by the page.
    const fns = (await c.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'
        AND (p.proname ILIKE '%kill%' OR pg_get_functiondef(p.oid) ILIKE '%notification_channel_kill_switches%')
    `)).rows.map((r) => r.proname as string).sort();
    expect(fns).toEqual([
      'admin_activate_channel_kill',
      'admin_notification_event_states',
      'admin_notification_gauges',
      'admin_notification_readiness',           // M6: reads kill state into the envelope
      'admin_preview_notification_decision',    // M6: kill context on the provenance row
      'clear_notification_channel_kill',        // N6: the ONE way back
      'is_notification_channel_killed',
      'notif_channel_kill_gate',
      'notif_channel_kill_guard',
      'preview_notification_channel_kill_clear',// …and its read-only preview
      'release_notification_claims_on_kill',
    ]);
    // exactly one clearing function, and it is NOT part of the admin surface
    const clearing = fns.filter((f) => /clear|deactivate|remove|unkill|resume|enable/.test(f)
      && !/^preview_/.test(f));
    expect(clearing).toEqual(['clear_notification_channel_kill']);
    expect(clearing[0]).not.toMatch(/^admin_/);
    // …and the API roles cannot execute it: un-killing is an owner/runbook decision
    for (const role of ['anon', 'authenticated']) {
      expect((await c.query(
        `SELECT has_function_privilege($1, 'public.clear_notification_channel_kill(text,uuid,int,text,uuid)', 'EXECUTE') AS ok`,
        [role])).rows[0].ok, `${role} must not be able to clear a kill`).toBe(false);
    }
    expect((await c.query(
      `SELECT has_function_privilege('service_role', 'public.clear_notification_channel_kill(text,uuid,int,text,uuid)', 'EXECUTE') AS ok`))
      .rows[0].ok).toBe(true);
    // and none of the OTHER functions touches the table destructively
    for (const f of ['admin_activate_channel_kill', 'notif_channel_kill_gate', 'is_notification_channel_killed',
                     'release_notification_claims_on_kill', 'admin_notification_gauges', 'admin_notification_event_states']) {
      const def = (await c.query(
        `SELECT pg_get_functiondef(p.oid) d FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`, [f])).rows[0].d as string;
      expect(def, `${f} must not delete a kill`).not.toMatch(/DELETE\s+FROM\s+public\.notification_channel_kill_switches/i);
      expect(def, `${f} must not update a kill`).not.toMatch(/UPDATE\s+public\.notification_channel_kill_switches/i);
    }
  });

  it('a live channel claims normally (sanity), and the reap works', async () => {
    const fresh = await seedRow();
    const reapable = await seedRow({ status: 'processing', locked_at: new Date(Date.now() - 30 * 60_000).toISOString(), locked_by: 'w:dead', attempts: 3, max_attempts: 3 });
    const rows = await claim(c);
    expect(rows.map((r) => r.outbox_id)).toEqual([fresh]);
    expect((await rowOf(reapable)).status).toBe('failed');       // reaped: out of retries + stale
  });

  it('killed: the claim returns EMPTY and the reapable row is UNTOUCHED — no cap-cancel, no reap, no claim', async () => {
    const fresh = await seedRow();
    const reapable = await seedRow({ status: 'processing', locked_at: new Date(Date.now() - 30 * 60_000).toISOString(), locked_by: 'w:dead', attempts: 3, max_attempts: 3 });
    await killDirect('email');
    expect(await claim(c)).toEqual([]);
    const f = await rowOf(fresh);
    expect(f.status).toBe('pending');
    expect(f.attempts).toBe(0);                                   // the claim increment never happened
    expect((await rowOf(reapable)).status).toBe('processing');    // the reap did NOT run — zero mutations
  });

  it('killed: even a cap-cancellable restricted row is untouched — the cap-cancel is also gated', async () => {
    const acadId = crypto.randomUUID();
    await c.query(`INSERT INTO public.academy_profiles (id) VALUES ($1)`, [acadId]);
    await c.query(`INSERT INTO public.academy_notification_restrictions (academy_profile_id, event_type, channel, max_frequency) VALUES ($1,'ev_test','email','off')`, [acadId]);
    const restricted = (await c.query(
      `INSERT INTO public.notification_outbox (channel, event_type, template_key, status, destination_normalized, scheduled_for, tenant_academy_profile_id, payload, idempotency_key, recipient_user_id)
       VALUES ('email','ev_test','tpl','pending','a@example.com', now() - interval '1 minute', $1, jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, '22222222-2222-4222-8222-222222222222') RETURNING id`, [acadId])).rows[0].id;
    await killDirect('email');
    expect(await claim(c)).toEqual([]);
    expect((await rowOf(restricted)).status).toBe('pending');     // not even skipped: NO mutations
    // …and once un-killed (runbook reset), the same claim cap-cancels it — proving the seed was live
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    await claim(c);
    expect((await rowOf(restricted)).status).toBe('skipped');
  });

  it('channels are independent: a whatsapp kill leaves the email claim live', async () => {
    const fresh = await seedRow();
    await killDirect('whatsapp');
    expect((await claim(c)).map((r) => r.outbox_id)).toEqual([fresh]);
  });

  it('DETERMINISTIC kill-vs-claim, direction 1: the kill BLOCKS behind an in-flight claim, the NEXT claim refuses', async () => {
    await seedRow();
    await c.query('BEGIN');
    const first = await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w:race',20,15)`);
    expect(first.rows.length).toBe(1);
    let settled = false;
    const killer = adminKill(c2, ADMIN, 'email').finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);            // the kill waits out the claim transaction
    await c.query('COMMIT');
    expect(await killer).toBe('killed');
    await seedRow();
    expect(await claim(c)).toEqual([]);     // strictly-after: the next claim sees the kill
  });

  it('DETERMINISTIC kill-vs-claim, direction 2: a claim BLOCKS behind an in-flight kill, then refuses', async () => {
    await seedRow();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    await c.query(`SELECT public.admin_activate_channel_kill('email','race test',$1)`, [crypto.randomUUID()]);
    let settled = false;
    const claimer = claim(c2, 'w:race2').finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);            // the claim waits behind the uncommitted kill
    await c.query('COMMIT');
    expect(await claimer).toEqual([]);      // …and refuses once it lands
  });
});

describe('the pre-provider re-check and the admin RPC under concurrency — deterministic', () => {
  it('is_notification_channel_killed WAITS OUT an uncommitted kill, then answers true — never races past it', async () => {
    // the round-2 P1: a lock-free read could not see the admin's uncommitted kill INSERT and
    // answered false while the kill transaction was open — the worker reached the provider.
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    await c.query(`SELECT public.admin_activate_channel_kill('email','race kill',$1)`, [crypto.randomUUID()]);
    let settled = false;
    const check = c2.query(`SELECT public.is_notification_channel_killed('email') AS k`)
      .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);                 // provably serialized behind the open kill
    await c.query('COMMIT');
    expect((await check).rows[0].k).toBe(true);  // …and sees the committed truth
  });

  it('two CONCURRENT identical kill requests CONVERGE on killed — the loser replays, never diverges', async () => {
    const req = crypto.randomUUID();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    expect((await c.query(`SELECT public.admin_activate_channel_kill('email','ops decided',$1) AS r`, [req])).rows[0].r).toBe('killed');
    let settled = false;
    const loser = adminKill(c2, ADMIN, 'email', req, 'ops decided').finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);                 // serialized on the REQUEST lock
    await c.query('COMMIT');
    expect(await loser).toBe('killed');          // exact replay — NOT 'already_killed'
  });
});


describe('release_notification_claims_on_kill — defer, never terminal, never budget burn', () => {
  it('releases the claiming worker’s rows: pending again, the attempt increment undone, a backoff set', async () => {
    const id = await seedRow();
    const rows = await claim(c, 'w:mine');
    expect(rows.length).toBe(1);
    expect((await rowOf(id)).attempts).toBe(1);                   // the claim charged an attempt
    const n = (await c.query(`SELECT public.release_notification_claims_on_kill('email','w:mine') AS n`)).rows[0].n;
    expect(n).toBe(1);
    const r = await rowOf(id);
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);                                   // …and the release gave it back
    expect(r.locked_by).toBeNull();
    expect(new Date(r.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it('token-guarded: another worker’s token releases NOTHING', async () => {
    const id = await seedRow();
    await claim(c, 'w:mine');
    expect((await c.query(`SELECT public.release_notification_claims_on_kill('email','w:other') AS n`)).rows[0].n).toBe(0);
    expect((await rowOf(id)).status).toBe('processing');
  });

  it('digest members are structurally out of scope', async () => {
    const dig = await seedRow({ status: 'processing', locked_by: 'w:mine', locked_at: new Date().toISOString(), attempts: 1, delivery_mode: 'digest' });
    expect((await c.query(`SELECT public.release_notification_claims_on_kill('email','w:mine') AS n`)).rows[0].n).toBe(0);
    expect((await rowOf(dig)).status).toBe('processing');
  });
});

describe('ACLs', () => {
  it('the read and the release are service-role paths; the kill table itself is reachable by NO api role', async () => {
    const as = async (role: string, sql: string) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as('anon', `SELECT public.is_notification_channel_killed('email')`)).toBe('42501');
    expect(await as('authenticated', `SELECT public.is_notification_channel_killed('email')`)).toBe('42501');
    expect(await as('service_role', `SELECT public.is_notification_channel_killed('email')`)).toBeNull();
    expect(await as('anon', `SELECT public.release_notification_claims_on_kill('email','w')`)).toBe('42501');
    expect(await as('service_role', `SELECT * FROM public.notification_channel_kill_switches`)).toBe('42501');
    expect(await as('authenticated', `INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id) VALUES ('email','x y z', gen_random_uuid())`)).toBe('42501');
  });
});

describe('N4 M3 — the ops audit: every decision recorded, exactly once, immutably', () => {
  const audits = async (req?: string) =>
    (await c.query(
      req
        ? `SELECT * FROM public.notification_admin_audit WHERE request_id = $1 ORDER BY created_at`
        : `SELECT * FROM public.notification_admin_audit ORDER BY created_at`,
      req ? [req] : [])).rows;
  const listAs = async (client: InstanceType<typeof Client>, uid: string | null, args = 'NULL, NULL, NULL') => {
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try {
      return (await client.query(`SELECT * FROM public.admin_list_notification_audit(${args})`)).rows;
    } finally {
      await client.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    }
  };

  it('a kill writes ONE typed audit row: actor, action, target, old live → new killed, applied', async () => {
    const req = crypto.randomUUID();
    expect(await adminKill(c2, ADMIN, 'email', req, 'incident 42')).toBe('killed');
    const rows = await audits(req);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      actor: ADMIN, action: 'channel_kill', target: 'email',
      old_value: 'live', new_value: 'killed', outcome: 'applied', reason: 'incident 42',
    });
  });

  it("a FRESH request against an already-killed channel gets its OWN row (old=killed, new=killed, already_killed) — the first kill's evidence untouched", async () => {
    const req1 = crypto.randomUUID();
    const req2 = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req1, 'first');
    expect(await adminKill(c2, ADMIN, 'email', req2, 'second look')).toBe('already_killed');
    expect((await audits(req2))[0]).toMatchObject({
      old_value: 'killed', new_value: 'killed', outcome: 'already_killed', reason: 'second look',
    });
    // the kill row still carries the FIRST decision
    const kill = (await c.query(`SELECT reason, request_id FROM public.notification_channel_kill_switches WHERE channel='email'`)).rows[0];
    expect(kill.reason).toBe('first');
    expect(kill.request_id).toBe(req1);
    expect((await audits()).length).toBe(2);
  });

  it('an exact replay returns the ORIGINAL result and writes NO second entry — for both outcomes', async () => {
    const req1 = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req1, 'first');
    expect(await adminKill(c2, ADMIN, 'email', req1, 'first')).toBe('killed');
    expect((await audits(req1)).length).toBe(1);
    const req2 = crypto.randomUUID();
    expect(await adminKill(c2, ADMIN, 'email', req2, 'again')).toBe('already_killed');
    expect(await adminKill(c2, ADMIN, 'email', req2, 'again')).toBe('already_killed');  // replayed from the audit
    expect((await audits(req2)).length).toBe(1);
  });

  it('a reused id carrying a DIFFERENT decision: typed refusal verdict, the ATTEMPT recorded, the decision untouched', async () => {
    const req = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req, 'first');
    expect(await adminKill(c2, ADMIN, 'whatsapp', req, 'first')).toBe('rejected_request_reuse');
    expect(await adminKill(c2, ADMIN, 'email', req, 'other words')).toBe('rejected_request_reuse');
    expect((await audits(req)).length).toBe(1);   // the DECISION table still holds exactly the original
    // …and the rejected-attempt record preserves who tried WHAT, against which original decision
    const rej = (await c.query(`SELECT * FROM public.notification_admin_rejected_attempts WHERE request_id=$1 ORDER BY created_at`, [req])).rows;
    expect(rej.length).toBe(2);
    expect(rej[0]).toMatchObject({ actor: ADMIN, action: 'channel_kill', target: 'whatsapp', reason: 'first' });
    expect(rej[0].conflict_with).toContain('bound to a channel_kill decision');   // the original decision, named — never its raw content
    expect(rej[1]).toMatchObject({ target: 'email', reason: 'other words' });
    // the rejected record is append-only like everything else on this surface
    await expect(c.query(`DELETE FROM public.notification_admin_rejected_attempts`)).rejects.toThrow(/append-only/);
  });

  it('the rejected-attempts READER: admin-only, newest-first, real cursor, half-cursor refused — evidence is reachable', async () => {
    const listRej = async (uid: string | null, args = 'NULL, NULL, NULL') => {
      await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
      try {
        return (await c2.query(`SELECT * FROM public.admin_list_notification_rejected(${args})`)).rows;
      } finally {
        await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
      }
    };
    await expect(listRej(null)).rejects.toThrow(/platform admin only/);
    await expect(listRej(PLAYER)).rejects.toThrow(/platform admin only/);
    const req = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req, 'first');
    expect(await adminKill(c2, ADMIN, 'whatsapp', req, 'first')).toBe('rejected_request_reuse');
    expect(await adminKill(c2, ADMIN, 'email', req, 'later words')).toBe('rejected_request_reuse');
    const page1 = await listRej(ADMIN, 'NULL, NULL, 1');
    expect(page1.length).toBe(1);
    expect(page1[0].reason).toBe('later words');   // newest first
    const exactTs = (await c.query(`SELECT created_at::text AS t FROM public.notification_admin_rejected_attempts WHERE id=$1`, [page1[0].id])).rows[0].t;
    const page2 = await listRej(ADMIN, `'${exactTs}'::timestamptz, '${page1[0].id}'::uuid, 5`);
    expect(page2.length).toBe(1);
    expect(page2[0].target).toBe('whatsapp');
    await expect(listRej(ADMIN, `now()::timestamptz, NULL, 2`)).rejects.toThrow(/BOTH created_at and id/);
    await expect(listRej(ADMIN, `NULL, gen_random_uuid(), 2`)).rejects.toThrow(/BOTH created_at and id/);
    // and the schema types the ATTEMPT record too — an owner-direct impossible target refuses
    await expect(c.query(
      `INSERT INTO public.notification_admin_rejected_attempts (actor, request_id, action, target, reason, conflict_with)
       VALUES ($1, gen_random_uuid(), 'channel_kill', 'arbitrary', 'smuggled', 'conflict text')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_rejected_coherent/);
  });

  it('the schema refuses INCOHERENT audit evidence even from the owner — typed fields, not just lengths', async () => {
    await expect(c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, gen_random_uuid(), 'channel_kill', 'arbitrary', 'foo', 'bar', 'applied', 'smuggled row')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_audit_coherent/);
    await expect(c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, gen_random_uuid(), 'channel_kill', 'email', 'killed', 'killed', 'applied', 'wrong old for applied')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_audit_coherent/);
  });

  it('a HALF-cursor is refused — both fields or neither, never a silent drop or restart', async () => {
    await adminKill(c2, ADMIN, 'email', crypto.randomUUID(), 'one');
    await expect(listAs(c2, ADMIN, `now()::timestamptz, NULL, 2`)).rejects.toThrow(/BOTH created_at and id/);
    await expect(listAs(c2, ADMIN, `NULL, gen_random_uuid(), 2`)).rejects.toThrow(/BOTH created_at and id/);
  });

  it('append-only, owner-effectively: UPDATE, DELETE and TRUNCATE are refused; the global uniqueness holds at the schema', async () => {
    const req = crypto.randomUUID();
    await adminKill(c2, ADMIN, 'email', req, 'first');
    await expect(c.query(`UPDATE public.notification_admin_audit SET reason='edited'`)).rejects.toThrow(/append-only/);
    await expect(c.query(`DELETE FROM public.notification_admin_audit`)).rejects.toThrow(/append-only/);
    await expect(c.query(`TRUNCATE public.notification_admin_audit`)).rejects.toThrow(/append-only/);
    // one id = one decision, enforced by the schema even past the RPC
    await expect(c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, $2, 'channel_kill', 'whatsapp', 'live', 'killed', 'applied', 'smuggled')`, [ADMIN, req]))
      .rejects.toThrow(/uq_notification_admin_audit_request|duplicate key/);
  });

  it('the keyset reader: admin-only, newest-first, a REAL cursor (no drift, no overlap), clamped', async () => {
    await expect(listAs(c2, null)).rejects.toThrow(/platform admin only/);
    await expect(listAs(c2, PLAYER)).rejects.toThrow(/platform admin only/);
    await adminKill(c2, ADMIN, 'email', crypto.randomUUID(), 'one');
    await adminKill(c2, ADMIN, 'email', crypto.randomUUID(), 'two');
    await adminKill(c2, ADMIN, 'whatsapp', crypto.randomUUID(), 'three');
    const page1 = await listAs(c2, ADMIN, 'NULL, NULL, 2');
    expect(page1.length).toBe(2);
    expect(page1[0].reason).toBe('three');    // newest first
    // the cursor must carry FULL microsecond precision — node-pg's Date is millisecond-only,
    // and a truncated cursor silently drops same-millisecond rows (found as a flake here)
    const exactTs = (await c.query(`SELECT created_at::text AS t FROM public.notification_admin_audit WHERE id=$1`, [page1[1].id])).rows[0].t;
    const page2 = await listAs(c2, ADMIN, `'${exactTs}'::timestamptz, '${page1[1].id}'::uuid, 2`);
    expect(page2.length).toBe(1);
    expect(page2[0].reason).toBe('one');
    // clamp: a hostile limit is bounded, structural no-error
    expect((await listAs(c2, ADMIN, 'NULL, NULL, 10000000')).length).toBe(3);
  });

  it('ACL: no API role reaches the audit table directly', async () => {
    const as = async (role: string, sql: string) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as('anon', `SELECT * FROM public.notification_admin_audit`)).toBe('42501');
    expect(await as('authenticated', `SELECT * FROM public.notification_admin_audit`)).toBe('42501');
    expect(await as('service_role', `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason) VALUES (gen_random_uuid(), gen_random_uuid(), 'channel_kill', 'email', 'live', 'killed', 'applied', 'nope')`)).toBe('42501');
  });
});

describe('N4 M4 — the fixed-column admin read surface', () => {
  const asAdmin = async (sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };
  const asUid = async (uid: string | null, sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };
  const seedGroup = async (over: Partial<{ channel: string; state: string; uncertain: boolean }> = {}) => {
    const r = await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state, uncertain_since)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, $1, 'ev_test', 'p:1', 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), $2, $3)
       RETURNING id`,
      [over.channel ?? 'email', over.state ?? 'pending', over.uncertain ? new Date().toISOString() : null]);
    return r.rows[0].id as string;
  };

  it('every reader is admin-fail-closed', async () => {
    const calls = [
      `SELECT * FROM public.admin_notification_gauges()`,
      `SELECT * FROM public.admin_list_notification_outbox()`,
      `SELECT * FROM public.admin_list_digest_groups()`,
      `SELECT * FROM public.admin_list_worker_runs()`,
      `SELECT * FROM public.admin_notification_event_states()`,
    ];
    for (const sql of calls) {
      await expect(asUid(null, sql)).rejects.toThrow(/platform admin only/);
      await expect(asUid(PLAYER, sql)).rejects.toThrow(/platform admin only/);
    }
  });

  it('gauges: counts by status, oldest-pending split, kill + quarantine + invocation exposure — typed rows', async () => {
    await seedRow();                                         // pending email
    await seedRow({ status: 'processing', locked_at: new Date(Date.now() - 5 * 60_000).toISOString(), locked_by: 'w:g' });
    await seedGroup({ uncertain: true, state: 'awaiting_evidence' });
    await killDirect('whatsapp');
    await c.query(`INSERT INTO public.notification_worker_invocations (request_id, purpose, source) VALUES (gen_random_uuid(), 'smoke', 'gauge-test')`);
    const rows = await asAdmin(`SELECT * FROM public.admin_notification_gauges()`);
    const g = (metric: string, channel: string | null) =>
      rows.find((r) => r.metric === metric && r.channel === channel);
    expect(Number(g('outbox_pending', 'email').value)).toBe(1);
    expect(g('outbox_pending', 'email').capped).toBe(false);
    expect(Number(g('outbox_processing', 'email').value)).toBe(1);
    expect(Number(g('oldest_processing_seconds', 'email').value)).toBeGreaterThanOrEqual(4 * 60);
    expect(Number(g('oldest_uncertain_seconds', 'email').value)).toBeGreaterThanOrEqual(0);
    expect(Number(g('channel_killed', 'whatsapp').value)).toBe(1);
    expect(Number(g('channel_killed', 'email').value)).toBe(0);
    expect(Number(g('invocations_unresolved', null).value)).toBe(1);
    expect(Number(g('orphans_quarantined', null).value)).toBe(0);
    expect(g('orphans_quarantined', null).capped).toBe(false);
    // the EVENT dimension: which event carries the backlog
    const byEvent = rows.find((r) => r.metric === 'outbox_by_event_pending' && r.channel === 'email');
    expect(byEvent.event_type).toBe('ev_test');
    expect(Number(byEvent.value)).toBe(1);
  });

  it('SATURATION is honest: a 10k+ event caps at 10000 with capped=true, and the OTHER event still gets its exact count', async () => {
    // set-based fixture: 10001 pending rows for ev_bulk, 1 for ev_test — a channel-wide sample
    // would have omitted ev_test entirely; per-pair counting must report BOTH truthfully
    await c.query(`INSERT INTO public.notification_event_types (key, category, audience, priority) VALUES ('ev_bulk', 'booking', 'player', 'transactional') ON CONFLICT (key) DO NOTHING`);
    await c.query(
      `INSERT INTO public.notification_outbox (channel, event_type, template_key, status, destination_normalized, scheduled_for, payload, idempotency_key, recipient_user_id)
       SELECT 'email', 'ev_bulk', 'tpl', 'pending', 'a@example.com', now(), '{}'::jsonb, 'sat-' || g, '${PLAYER}'
         FROM generate_series(1, 10001) g`);
    await seedRow();   // one ev_test pending row
    const rows = await asAdmin(`SELECT * FROM public.admin_notification_gauges()`);
    const bulk = rows.find((r) => r.metric === 'outbox_by_event_pending' && r.event_type === 'ev_bulk');
    expect(Number(bulk.value)).toBe(10000);
    expect(bulk.capped).toBe(true);
    const small = rows.find((r) => r.metric === 'outbox_by_event_pending' && r.event_type === 'ev_test');
    expect(Number(small.value)).toBe(1);      // NOT omitted, NOT capped — proven zero-vs-omitted distinction
    expect(small.capped).toBe(false);
    const total = rows.find((r) => r.metric === 'outbox_pending' && r.channel === 'email');
    expect(Number(total.value)).toBe(10000);  // the channel gauge saturates too
    expect(total.capped).toBe(true);
  }, 60_000);

  it('the outbox feed: EXACT fixed columns (no payload, redacted destination), filters, bounds, half-cursor', async () => {
    const id = await seedRow();
    const rows = await asAdmin(`SELECT * FROM public.admin_list_notification_outbox('email', NULL, 'pending', 7, NULL, NULL, 10)`);
    expect(rows.map((r) => r.id)).toContain(id);
    expect(Object.keys(rows[0]).sort()).toEqual([
      'attempts', 'channel', 'created_at', 'delivery_mode', 'destination_redacted', 'error_class',
      'event_type', 'id', 'max_attempts', 'scheduled_for', 'skip_reason', 'status', 'template_key',
      'tenant_academy_profile_id', 'tenant_trainer_id', 'updated_at',
    ]);
    expect(await asAdmin(`SELECT * FROM public.admin_list_notification_outbox('whatsapp', NULL, NULL, 7, NULL, NULL, 10)`)).toEqual([]);
    await expect(asAdmin(`SELECT * FROM public.admin_list_notification_outbox(NULL, NULL, NULL, 0, NULL, NULL, 10)`)).rejects.toThrow(/1\.\.90/);
    await expect(asAdmin(`SELECT * FROM public.admin_list_notification_outbox(NULL, NULL, NULL, 91, NULL, NULL, 10)`)).rejects.toThrow(/1\.\.90/);
    await expect(asAdmin(`SELECT * FROM public.admin_list_notification_outbox(NULL, NULL, NULL, 7, now()::timestamptz, NULL, 10)`)).rejects.toThrow(/BOTH/);
  });

  it('the digest-group feed: fixed columns (no frozen_request, no fingerprint), state filter, bounds', async () => {
    await seedGroup({ state: 'request_ready' });
    const rows = await asAdmin(`SELECT * FROM public.admin_list_digest_groups('email', 'request_ready', 7, NULL, NULL, 10)`);
    expect(rows.length).toBe(1);
    const cols = Object.keys(rows[0]);
    expect(cols).not.toContain('frozen_request');
    expect(cols).not.toContain('destination_fingerprint');
    expect(cols).not.toContain('canonical_group_key');
    await expect(asAdmin(`SELECT * FROM public.admin_list_digest_groups(NULL, NULL, 91, NULL, NULL, 10)`)).rejects.toThrow(/1\.\.90/);
  });

  it('delivery history: the typed timeline — attempts, provider events, orphan state; never a body', async () => {
    const g = await seedGroup({ state: 'sent' });
    const ob = (await c.query(
      `INSERT INTO public.notification_outbox (channel, event_type, template_key, status, destination_normalized, destination_redacted, scheduled_for, payload, idempotency_key, recipient_user_id, delivery_mode, digest_group_id)
       VALUES ('email','ev_test','tpl','sent','a@example.com','a***@example.com', now(), '{"secret":"NEVER"}'::jsonb, gen_random_uuid()::text, $1, 'digest', $2) RETURNING id`,
      [PLAYER, g])).rows[0].id;
    await c.query(
      `INSERT INTO public.notification_digest_attempts (digest_group_id, provider_idempotency_key, outcome_class, http_status, provider_message_id)
       VALUES ($1, 'dg:v1:k', 'accepted', 200, 're_123')`, [g]);
    // the provider-event FK is composite: (group, provider_message_id) must match the group's binding
    await c.query(`UPDATE public.notification_digest_groups SET provider_message_id = 're_123', provider_status = 'delivered', provider_status_rank = 3 WHERE id = $1`, [g]);
    await c.query(
      `INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at)
       VALUES ('ev_1', 're_123', $1, 'delivered', now())`, [g]);
    // a raw provider error echoing a destination — it must NEVER cross this boundary
    await c.query(`UPDATE public.notification_outbox SET provider_message_id = 're_inst_1', last_error = 'SMTP 550: NEVER-b <victim@example.com> rejected' WHERE id = $1`, [ob]);
    await c.query(
      `INSERT INTO public.email_delivery_events (resend_event_id, resend_email_id, outbox_id, event_type, bounce_type, reason, recipient_email, occurred_at)
       VALUES ('edev_1', 're_inst_1', $1, 'bounced', 'hard', 'reason with NEVER-c marker', 'victim@example.com', now())`, [ob]);
    // a send_failed event deliberately has NO provider id — the causal outbox_id join is what
    // keeps it visible (a provider-id join would lose every pre-acceptance failure)
    await c.query(
      `INSERT INTO public.email_delivery_events (resend_event_id, resend_email_id, outbox_id, event_type, reason, recipient_email, occurred_at)
       VALUES ('edev_2', NULL, $1, 'send_failed', 'provider 500 with NEVER-d', 'victim@example.com', now())`, [ob]);
    const rows = await asAdmin(`SELECT * FROM public.admin_notification_delivery_history('${ob}'::uuid)`);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('outbox_created');
    expect(kinds).toContain('outbox_state');
    expect(kinds).toContain('digest_attempt');
    expect(kinds).toContain('provider_event');
    expect(kinds).toContain('delivery_event');               // the INSTANT ledger reaches the timeline
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('NEVER');                     // payload, raw error AND event reason are all tight
    expect(dump).not.toContain('victim@example.com');        // no raw recipient from any arm
    expect(rows.find((r) => r.kind === 'outbox_state').b).toBe('provider_error');  // classified, not echoed
    // label-SHAPED hostile values are still PII — the classifier is an ALLOWLIST, not a shape rule
    const cls = async (e: string) => (await c.query(`SELECT public.notif_error_class($1) AS r`, [e])).rows[0].r;
    expect(await cls('31612345678')).toBe('provider_error');       // a bare phone number
    expect(await cls('john_smith')).toBe('provider_error');        // a username
    expect(await cls('sk_live_abc123')).toBe('provider_error');    // token-ish (dot/dash-free)
    expect(await cls('stuck_in_processing')).toBe('stuck_in_processing');  // ours pass
    expect(await cls('invalid_phone')).toBe('invalid_phone');
    const de = rows.find((r) => r.kind === 'delivery_event' && r.a === 'bounced');
    expect(de.b).toBe('hard');
    expect(rows.some((r) => r.kind === 'delivery_event' && r.a === 'send_failed')).toBe(true);   // NULL provider id still visible
    expect(rows.find((r) => r.kind === 'outbox_created').c).toBe('a***@example.com');
    // bounded: clamp + real composite cursor + half-cursor refusal
    // the cursor needs FULL microsecond precision — select at::text alongside (node-pg's Date
    // truncates to ms, which silently broke same-millisecond pagination; found as a flake)
    const page1 = await asAdmin(`SELECT h.*, h.at::text AS at_text FROM public.admin_notification_delivery_history('${ob}'::uuid, NULL, NULL, 2) h`);
    expect(page1.length).toBe(2);
    const page2 = await asAdmin(`SELECT * FROM public.admin_notification_delivery_history('${ob}'::uuid, '${page1[1].at_text}'::timestamptz, '${page1[1].ref}', 50)`);
    expect(page2.length).toBe(rows.length - 2);
    await expect(asAdmin(`SELECT * FROM public.admin_notification_delivery_history('${ob}'::uuid, now()::timestamptz, NULL, 5)`)).rejects.toThrow(/BOTH/);
    await expect(asAdmin(`SELECT * FROM public.admin_notification_delivery_history(gen_random_uuid())`)).rejects.toThrow(/does not exist/);
  });

  it('event states: per-authority columns, the VISIBLE unverifiable env line, and the honest tri-state', async () => {
    const rows = await asAdmin(`SELECT * FROM public.admin_notification_event_states()`);
    const email = rows.find((r) => r.event_type === 'ev_test' && r.channel === 'email');
    const wa = rows.find((r) => r.event_type === 'ev_test' && r.channel === 'whatsapp');
    expect(email.catalog_supported).toBe(true);
    // the env line names the switch that ACTUALLY governs each channel/path
    expect(email.send_env).toContain('DIGEST_SEND_ENABLED');
    expect(email.send_env).toContain('unverifiable');
    expect(wa.send_env).toContain('WHATSAPP_SEND_ENABLED');   // the instant whatsapp switch
    expect(wa.send_env).toContain('unverifiable');
    expect(email.cron_state).toBe('unavailable');            // no pg_cron here — the honest arm
    expect(email.kill_state).toBe('live');
    // the paths CONCLUDE SEPARATELY: instant has no cron/env authority; digest has both
    expect(email.instant_conclusion).toBe('sendable');
    // engine-off is NOT a digest stop (it gates ENQUEUE only; existing groups drain) — the cron
    // being inactive/absent is, and this harness has no pg_cron ('unavailable') so the verdict
    // rests on the unverifiable env
    expect(email.digest_conclusion).toBe('unknown');
    expect(wa.catalog_supported).toBe(false);
    expect(wa.instant_conclusion).toBe('stopped');           // unsupported is a definitive stop
    // …but WHATSAPP HAS NO DIGEST PATH AT ALL (the resolver routes only email into digests and
    // the worker is email-only), so any digest verdict there — 'stopped' or 'unknown' — implies
    // digest work that cannot exist
    expect(wa.digest_conclusion).toBe('not_applicable');
    // …and a SUPPORTED whatsapp event still cannot read sendable: WHATSAPP_SEND_ENABLED gates
    // the INSTANT path and no SQL can read it (the seam the per-milestone reviews could not see)
    await c.query(`UPDATE public.notification_event_types SET supports_whatsapp = true WHERE key = 'ev_test'`);
    const waOn = (await asAdmin(`SELECT * FROM public.admin_notification_event_states()`))
      .find((r) => r.event_type === 'ev_test' && r.channel === 'whatsapp');
    expect(waOn.instant_conclusion).toBe('unknown');
    expect(waOn.digest_conclusion).toBe('not_applicable');   // supported or not: no digest path
    await c.query(`UPDATE public.notification_event_types SET supports_whatsapp = false WHERE key = 'ev_test'`);
    // kill flips the authority AND both conclusions
    await killDirect('email');
    const after = await asAdmin(`SELECT * FROM public.admin_notification_event_states()`);
    const emailKilled = after.find((r) => r.event_type === 'ev_test' && r.channel === 'email');
    expect(emailKilled.kill_state).toBe('killed');
    expect(emailKilled.instant_conclusion).toBe('stopped');
    expect(emailKilled.digest_conclusion).toBe('stopped');
    // an OPEN CIRCUIT stops the DIGEST path but NOT the instant one — the instant claim never
    // reads the breaker, and reporting otherwise let instant email send under a "stopped" badge
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at) VALUES ('email','open','provider_5xx', now())`);
    const withCircuit = (await asAdmin(`SELECT * FROM public.admin_notification_event_states()`))
      .find((r) => r.event_type === 'ev_test' && r.channel === 'email');
    expect(withCircuit.instant_conclusion).toBe('sendable');   // truthful: the claim ignores it
    expect(withCircuit.digest_conclusion).toBe('stopped');
    await c.query(`DELETE FROM public.notification_provider_circuit`);
    // engine ON + cron unavailable: the digest path can never conclude past unknown (the env
    // has the last word and SQL cannot read it) — while the INSTANT path stays sendable
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = true WHERE key = 'ev_test'`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    const dig = await asAdmin(`SELECT * FROM public.admin_notification_event_states()`);
    const digEmail = dig.find((r) => r.event_type === 'ev_test' && r.channel === 'email');
    expect(digEmail.digest_conclusion).toBe('unknown');
    expect(digEmail.instant_conclusion).toBe('sendable');    // the engine flag is not an instant authority
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false WHERE key = 'ev_test'`);
  });
});

describe('N4 M5 — send-enabling recovery: every verdict recorded, evidence always wins', () => {
  const call = async (uid: string | null, sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };
  const TRIP = '2026-08-05T10:00:00.000Z';
  const seedCircuit = (state = 'open', reason = 'provider_5xx') =>
    c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at) VALUES ('email', $1, $2, $3::timestamptz)`, [state, reason, TRIP]);
  const resetSql = (req: string, over: Partial<{ state: string; reason: string; trip: string; why: string }> = {}) =>
    `SELECT public.admin_reset_notification_circuit('email', '${over.state ?? 'open'}', '${over.reason ?? 'provider_5xx'}', '${over.trip ?? TRIP}'::timestamptz, '${over.why ?? 'provider recovered'}', '${req}') AS r`;
  let orphanSeq = 0;
  const seedOrphan = async (quarantined: boolean, code: string) => {
    const g = (await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state, provider_message_id, provider_status, provider_status_rank)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, 'email', 'ev_test', 'p:o' || $1, 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), 'sent', 're_orph_' || $1, 'sent', 1)
       RETURNING id`, [String(++orphanSeq)])).rows[0].id;
    const ev = `orph_ev_${orphanSeq}`;
    await c.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, digest_group_id, status, occurred_at) VALUES ($1, 're_orph_' || $2, $3, 'delivered', now())`, [ev, String(orphanSeq), g]);
    await c.query(`INSERT INTO public.notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id, attempts, last_error_code, next_eligible_at, quarantined) VALUES ($1, 'email', $4, 3, $2, now(), $3)`, [ev, code, quarantined, g]);
    return ev;
  };
  const rejections = async (action: string) =>
    (await c.query(`SELECT * FROM public.notification_admin_rejected_attempts WHERE action = $1 ORDER BY created_at`, [action])).rows;

  it('every recovery RPC is admin-fail-closed', async () => {
    for (const sql of [
      resetSql(crypto.randomUUID()),
      `SELECT public.admin_cancel_digest_group(gen_random_uuid(), 'pending', 'why not', gen_random_uuid())`,
      `SELECT public.admin_resolve_notification_orphan('x', 'why not', gen_random_uuid())`,
      `SELECT public.admin_requeue_notification_orphan('x', 'why not', gen_random_uuid())`,
      `SELECT * FROM public.admin_preview_circuit_release('email')`,
    ]) {
      await expect(call(null, sql)).rejects.toThrow(/platform admin only/);
      await expect(call(PLAYER, sql)).rejects.toThrow(/platform admin only/);
    }
  });

  it('circuit reset: exact typed confirmation resets, audits open→closed, and replays without a second entry', async () => {
    await seedCircuit();
    const req = crypto.randomUUID();
    expect((await call(ADMIN, resetSql(req)))[0].r).toBe('reset');
    const cb = (await c.query(`SELECT * FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0];
    expect(cb.state).toBe('closed');
    expect(cb.reason).toBeNull();
    expect(cb.tripped_at).toBeNull();
    const audit = (await c.query(`SELECT * FROM public.notification_admin_audit WHERE request_id=$1`, [req])).rows;
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({ action: 'circuit_reset', target: 'email', old_value: 'open', new_value: 'closed', outcome: 'applied' });
    expect((await call(ADMIN, resetSql(req)))[0].r).toBe('reset');   // exact replay
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_admin_audit WHERE request_id=$1`, [req])).rows[0].n).toBe(1);
  });

  it('circuit reset refusals: kill, open invocation, correlation_mismatch, stale confirmation — each typed AND recorded', async () => {
    await seedCircuit();
    await killDirect('email');
    expect((await call(ADMIN, resetSql(crypto.randomUUID())))[0].r).toBe('rejected_channel_killed');
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`INSERT INTO public.notification_worker_invocations (request_id, purpose, source) VALUES (gen_random_uuid(), 'canary', 'm5-test')`);
    expect((await call(ADMIN, resetSql(crypto.randomUUID())))[0].r).toBe('rejected_invocation_open');
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await c.query(`DELETE FROM public.notification_worker_invocations;`);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
    // stale confirmation: the caller saw an EARLIER trip
    expect((await call(ADMIN, resetSql(crypto.randomUUID(), { trip: '2026-08-05T09:00:00.000Z' })))[0].r).toBe('rejected_stale_state');
    // correlation_mismatch: categorical — evidence cannot be reset true
    await c.query(`UPDATE public.notification_provider_circuit SET reason = 'correlation_mismatch' WHERE channel = 'email'`);
    expect((await call(ADMIN, resetSql(crypto.randomUUID(), { reason: 'correlation_mismatch' })))[0].r).toBe('rejected_correlation_mismatch');
    const rej = await rejections('circuit_reset');
    expect(rej.length).toBe(4);
    expect(rej.map((r) => r.conflict_with)).toEqual([
      'channel is killed',
      'a deliberate worker invocation is unresolved',
      expect.stringContaining('stale confirmation'),
      expect.stringContaining('correlation_mismatch hold'),
    ]);
    // the circuit is STILL not closed — no refusal touched it
    expect((await c.query(`SELECT state FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0].state).toBe('open');
  });

  it("a MISSING circuit row reads 'already_closed' — audited as the no-op decision it is", async () => {
    const req = crypto.randomUUID();
    expect((await call(ADMIN, resetSql(req)))[0].r).toBe('already_closed');
    expect((await c.query(`SELECT outcome FROM public.notification_admin_audit WHERE request_id=$1`, [req])).rows[0].outcome).toBe('already_closed');
  });

  it('group cancel: pre-dispatch only — cancels through the state machine, members skipped, history preserved', async () => {
    const g = (await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, 'email', 'ev_test', 'p:c1', 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), 'pending') RETURNING id`)).rows[0].id;
    const member = (await c.query(
      `INSERT INTO public.notification_outbox (channel, event_type, template_key, status, destination_normalized, scheduled_for, payload, idempotency_key, recipient_user_id, delivery_mode, digest_group_id)
       VALUES ('email','ev_test','tpl','pending','a@example.com', now(), jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, '${PLAYER}', 'digest', $1) RETURNING id`, [g])).rows[0].id;
    const req = crypto.randomUUID();
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${g}', 'pending', 'wrong audience', '${req}') AS r`))[0].r).toBe('cancelled');
    const after = (await c.query(`SELECT state, terminal_reason FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0];
    expect(after.state).toBe('retry_stopped');
    expect(after.terminal_reason).toBe('admin_cancel');
    expect((await c.query(`SELECT status FROM public.notification_outbox WHERE id=$1`, [member])).rows[0].status).toBe('skipped');
    expect((await c.query(`SELECT outcome, old_value, new_value FROM public.notification_admin_audit WHERE request_id=$1`, [req])).rows[0])
      .toMatchObject({ outcome: 'applied', old_value: 'pending', new_value: 'retry_stopped' });
    // replay converges
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${g}', 'pending', 'wrong audience', '${req}') AS r`))[0].r).toBe('cancelled');
  });

  it('group cancel refusals: send/uncertainty evidence and stale confirmations refuse, typed and recorded', async () => {
    const mk = async (state: string, attempts = 0) => (await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state, provider_attempts_started)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, 'email', 'ev_test', 'p:c' || gen_random_uuid()::text, 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), $1, $2) RETURNING id`, [state, attempts])).rows[0].id;
    const withAttempts = await mk('request_ready', 1);
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${withAttempts}', 'request_ready', 'stop it', '${crypto.randomUUID()}') AS r`))[0].r)
      .toBe('rejected_not_pre_dispatch');
    const pendingG = await mk('pending');
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${pendingG}', 'leased', 'stop it', '${crypto.randomUUID()}') AS r`))[0].r)
      .toBe('rejected_stale_state');
    const rej = await rejections('group_cancel');
    expect(rej.length).toBe(2);
    expect(rej[0].conflict_with).toContain('not pre-dispatch');
    expect(rej[1].conflict_with).toContain('stale confirmation');
    // neither refusal touched a group
    expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE id=$1`, [withAttempts])).rows[0].state).toBe('request_ready');
  });

  it('orphan resolve: permanent + quarantined only — the wrapped fn acts, evidence survives, audit lands', async () => {
    const ev = await seedOrphan(true, 'tagged_mismatch');
    const req = crypto.randomUUID();
    expect((await call(ADMIN, `SELECT public.admin_resolve_notification_orphan('${ev}', 'confirmed mismatch', '${req}') AS r`))[0].r).toBe('resolved');
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_orphan_reconcile_state WHERE resend_event_id=$1`, [ev])).rows[0].n).toBe(0);
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id=$1`, [ev])).rows[0].n).toBe(1);  // evidence NEVER deleted
    expect((await c.query(`SELECT action FROM public.notification_orphan_reconcile_actions WHERE resend_event_id=$1`, [ev])).rows[0].action).toBe('resolve');
    expect((await c.query(`SELECT outcome, old_value, new_value FROM public.notification_admin_audit WHERE request_id=$1`, [req])).rows[0])
      .toMatchObject({ outcome: 'applied', old_value: 'quarantined', new_value: 'resolved' });
  });

  it('orphan requeue: transient + quarantined only — back to the worker; every misclassification typed and recorded', async () => {
    const ev = await seedOrphan(true, 'link_update_conflict');
    expect((await call(ADMIN, `SELECT public.admin_requeue_notification_orphan('${ev}', 'transient blip', '${crypto.randomUUID()}') AS r`))[0].r).toBe('requeued');
    expect((await c.query(`SELECT quarantined, last_error_code FROM public.notification_orphan_reconcile_state WHERE resend_event_id=$1`, [ev])).rows[0])
      .toMatchObject({ quarantined: false, last_error_code: 'requeued' });
    // misclassifications
    const evPerm = await seedOrphan(true, 'tagged_mismatch');
    expect((await call(ADMIN, `SELECT public.admin_requeue_notification_orphan('${evPerm}', 'oops', '${crypto.randomUUID()}') AS r`))[0].r).toBe('rejected_permanent_reason');
    const evLive = await seedOrphan(false, 'link_update_conflict');
    expect((await call(ADMIN, `SELECT public.admin_resolve_notification_orphan('${evLive}', 'oops', '${crypto.randomUUID()}') AS r`))[0].r).toBe('rejected_not_quarantined');
    const evTransQ = await seedOrphan(true, 'link_update_conflict');
    expect((await call(ADMIN, `SELECT public.admin_resolve_notification_orphan('${evTransQ}', 'oops', '${crypto.randomUUID()}') AS r`))[0].r).toBe('rejected_not_permanent');
    expect((await call(ADMIN, `SELECT public.admin_resolve_notification_orphan('missing_ev', 'oops', '${crypto.randomUUID()}') AS r`))[0].r).toBe('rejected_not_found');
    expect((await rejections('orphan_requeue')).length).toBe(1);
    expect((await rejections('orphan_resolve')).length).toBe(3);
  });

  it('SEAM 10: two actors racing ONE request id across DIFFERENT channels — the loser is refused with a TYPED verdict', async () => {
    const A2 = 'ae000000-0000-4000-8000-000000000002';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [A2]);
    await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [A2]);
    const shared = crypto.randomUUID();
    try {
      // session 1 kills EMAIL inside an OPEN transaction: it holds the global request-id lock
      await c.query('BEGIN');
      await c.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
      expect((await c.query(`SELECT public.admin_activate_channel_kill('email','first admin',$1) AS r`, [shared])).rows[0].r)
        .toBe('killed');
      // session 2 kills WHATSAPP with the SAME uuid. Different channel ⇒ a DIFFERENT channel
      // lock, so before the global request-id lock existed both ran the collision check on a
      // pre-insert snapshot and the loser died on the kill table's unique index — taking its
      // rejected-attempt evidence down with it.
      let settled = false;
      const loser = adminKill(c2, A2, 'whatsapp', shared, 'second admin').finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 200));
      expect(settled).toBe(false);                          // provably serialized on the id
      await c.query('COMMIT');
      expect(await loser).toBe('rejected_id_collision');    // typed, not a raw 23505
      expect((await c.query(
        `SELECT count(*)::int n FROM public.notification_admin_rejected_attempts WHERE actor = $1`, [A2])).rows[0].n).toBe(1);
      expect((await c.query(
        `SELECT verdict FROM public.notification_admin_requests WHERE actor = $1`, [A2])).rows[0].verdict)
        .toBe('rejected_id_collision');
      expect((await c.query(
        `SELECT count(*)::int n FROM public.notification_channel_kill_switches WHERE channel='whatsapp'`)).rows[0].n).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.query(`SELECT set_config('request.jwt.claim.sub', '', false)`).catch(() => {});
    }
  });

  it('the preview shows what a reset RELEASES — and says plainly that the instant backlog is not part of it', async () => {
    await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, 'email', 'ev_test', 'p:pr', 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), 'request_ready')`);
    await seedRow();
    const rows = await call(ADMIN, `SELECT * FROM public.admin_preview_circuit_release('email')`);
    expect(Number(rows.find((r) => r.metric === 'digest_groups_request_ready').value)).toBe(1);
    // the instant claim never reads the breaker, so closing it releases NOTHING here — the
    // metric name must not invite "reset the circuit to unstick instant email"
    expect(rows.map((r) => r.metric)).not.toContain('instant_rows_pending');
    expect(Number(rows.find((r) => r.metric === 'instant_rows_pending_not_released').value)).toBe(1);
    const claimSrc = (await c.query(
      `SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='claim_notification_outbox_batch'`)).rows[0].prosrc as string;
    expect(claimSrc).not.toContain('notification_provider_circuit');   // the claim that proves it
  });

  it('NO retry exists: the COMPLETE admin surface is pinned — nothing shaped like a resend', async () => {
    const fns = (await c.query(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname LIKE 'admin\\_%'
    `)).rows.map((r) => r.proname as string).sort();
    expect(fns).toEqual([
      'admin_activate_channel_kill',
      'admin_cancel_digest_group',
      'admin_dispose_pre_boundary_backlog',
      'admin_list_digest_groups',
      'admin_list_notification_audit',
      'admin_list_notification_orphans',
      'admin_list_notification_outbox',
      'admin_list_notification_rejected',
      'admin_list_worker_invocations',
      'admin_list_worker_runs',
      'admin_notification_activation_boundaries',
      'admin_notification_delivery_history',
      'admin_notification_event_states',
      'admin_notification_gauges',
      'admin_notification_readiness',
      'admin_preview_circuit_release',
      'admin_preview_notification_decision',
      'admin_preview_notification_recipients',
      'admin_requeue_notification_orphan',
      'admin_reset_notification_circuit',
      'admin_resolve_notification_orphan',
      'admin_search_notification_destination',
    ]);
    for (const f of fns) expect(f).not.toMatch(/retry|resend|redeliver/);
  });
});

describe('N4 M5 round-2 — the request registry and the invocation-window lock', () => {
  const call = async (uid: string | null, sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };
  const TRIP = '2026-08-05T10:00:00.000Z';
  const seedCircuit = () =>
    c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at) VALUES ('email', 'open', 'provider_5xx', $1::timestamptz)`, [TRIP]);
  const resetSql = (req: string, over: Partial<{ state: string; reason: string; trip: string; why: string }> = {}) =>
    `SELECT public.admin_reset_notification_circuit('email', '${over.state ?? 'open'}', '${over.reason ?? 'provider_5xx'}', '${over.trip ?? TRIP}'::timestamptz, '${over.why ?? 'provider recovered'}', '${req}') AS r`;

  it('a REFUSAL consumes the id: the corrected retry is conflicting reuse, only a FRESH id can proceed', async () => {
    await seedCircuit();
    const req = crypto.randomUUID();
    // stale confirmation → refused, id CONSUMED
    expect((await call(ADMIN, resetSql(req, { trip: '2026-08-05T09:00:00.000Z' })))[0].r).toBe('rejected_stale_state');
    // the 'corrected' retry under the SAME id — the round-2 P1: this used to RESET
    expect((await call(ADMIN, resetSql(req)))[0].r).toBe('rejected_request_reuse');
    expect((await c.query(`SELECT state FROM public.notification_provider_circuit WHERE channel='email'`)).rows[0].state).toBe('open');
    // the EXACT stale retry replays its original refusal — no new records
    const before = (await c.query(`SELECT count(*)::int n FROM public.notification_admin_rejected_attempts`)).rows[0].n;
    expect((await call(ADMIN, resetSql(req, { trip: '2026-08-05T09:00:00.000Z' })))[0].r).toBe('rejected_stale_state');
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_admin_rejected_attempts`)).rows[0].n).toBe(before);
    // a fresh id with the CORRECT confirmation proceeds
    expect((await call(ADMIN, resetSql(crypto.randomUUID())))[0].r).toBe('reset');
  });

  it('the fingerprint is COMPLETE: changing only the expected version (or only the group expected state) is reuse', async () => {
    await seedCircuit();
    const req = crypto.randomUUID();
    expect((await call(ADMIN, resetSql(req, { trip: '2026-08-05T09:00:00.000Z' })))[0].r).toBe('rejected_stale_state');
    // ONLY expected_tripped_at differs → a different decision, never a replay
    expect((await call(ADMIN, resetSql(req, { trip: '2026-08-05T08:00:00.000Z' })))[0].r).toBe('rejected_request_reuse');
    // group cancel: only expected_state differs
    const g = (await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, 'email', 'ev_test', 'p:fp', 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), 'pending') RETURNING id`)).rows[0].id;
    const req2 = crypto.randomUUID();
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${g}', 'leased', 'why not', '${req2}') AS r`))[0].r).toBe('rejected_stale_state');
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${g}', 'pending', 'why not', '${req2}') AS r`))[0].r).toBe('rejected_request_reuse');
    expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0].state).toBe('pending');
  });

  it('concurrent IDENTICAL refused calls converge on ONE first verdict — deterministic', async () => {
    await seedCircuit();
    const req = crypto.randomUUID();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    expect((await c.query(resetSql(req, { trip: '2026-08-05T09:00:00.000Z' }))).rows[0].r).toBe('rejected_stale_state');
    let settled = false;
    const loser = call(ADMIN, resetSql(req, { trip: '2026-08-05T09:00:00.000Z' })).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);   // serialized on the global request lock
    await c.query('COMMIT');
    expect((await loser)[0].r).toBe('rejected_stale_state');   // the ONE first verdict, replayed
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_admin_requests WHERE request_id=$1`, [req])).rows[0].n).toBe(1);
  });

  it('the reset WAITS OUT an in-flight invocation open — and then refuses; the reverse order also serializes', async () => {
    await seedCircuit();
    // direction 1: an invoker holds the open lock with its pending row uncommitted
    await c.query('BEGIN');
    await c.query(`SELECT public.open_notification_worker_invocation('canary', 'race-test', $1)`, [crypto.randomUUID()]);
    let settled = false;
    const resetP = call(ADMIN, resetSql(crypto.randomUUID())).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);   // the reset provably waits on the invocation-open lock
    await c.query('COMMIT');
    expect((await resetP)[0].r).toBe('rejected_invocation_open');   // …and then SEES the window
    // clean up the invocation; direction 2: a reset transaction blocks a new open
    await c.query(`ALTER TABLE public.notification_worker_invocations DISABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await c.query(`DELETE FROM public.notification_worker_invocations;`);
    await c.query(`ALTER TABLE public.notification_worker_invocations ENABLE TRIGGER trg_notif_worker_invocation_guard;`);
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ADMIN]);
    expect((await c.query(resetSql(crypto.randomUUID()))).rows[0].r).toBe('reset');   // holds the open lock
    let settled2 = false;
    const openP = c2.query(`SELECT public.open_notification_worker_invocation('canary', 'race-test-2', $1) AS id`, [crypto.randomUUID()])
      .finally(() => { settled2 = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(settled2).toBe(false);  // the open provably waits behind the reset
    await c.query('COMMIT');
    expect((await openP).rows[0].id).toBeTruthy();   // strictly-after: the open lands cleanly
  });
});

describe('N4 M5 round-3 — canonical fingerprints, registry coherence, consumed not-found, backfill', () => {
  const call = async (uid: string | null, sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };
  const TRIP = '2026-08-05T10:00:00.000Z';
  const seedCircuit = () =>
    c.query(`INSERT INTO public.notification_provider_circuit (channel, state, reason, tripped_at) VALUES ('email', 'open', 'provider_5xx', $1::timestamptz)`, [TRIP]);

  it('fingerprints are COLLISION-SAFE: delimiter-moving and literal-sentinel inputs are DIFFERENT decisions', async () => {
    await seedCircuit();
    // delimiter-moving: under raw concatenation these two tuples rendered identically
    const req = crypto.randomUUID();
    expect((await call(ADMIN, `SELECT public.admin_reset_notification_circuit('email', 'a|b', 'c', '${TRIP}'::timestamptz, 'why not', '${req}') AS r`))[0].r)
      .toBe('rejected_stale_state');
    expect((await call(ADMIN, `SELECT public.admin_reset_notification_circuit('email', 'a', 'b|c', '${TRIP}'::timestamptz, 'why not', '${req}') AS r`))[0].r)
      .toBe('rejected_request_reuse');
    // literal '<null>' vs SQL NULL: under the sentinel scheme these were the same fingerprint
    const req2 = crypto.randomUUID();
    expect((await call(ADMIN, `SELECT public.admin_reset_notification_circuit('email', 'open', NULL, '${TRIP}'::timestamptz, 'why not', '${req2}') AS r`))[0].r)
      .toBe('rejected_stale_state');
    expect((await call(ADMIN, `SELECT public.admin_reset_notification_circuit('email', 'open', '<null>', '${TRIP}'::timestamptz, 'why not', '${req2}') AS r`))[0].r)
      .toBe('rejected_request_reuse');
    // and the registry never stores raw text — every fingerprint is a sha-256 digest
    const fps = (await c.query(`SELECT fingerprint FROM public.notification_admin_requests`)).rows;
    for (const f of fps) expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the registry refuses an IMPOSSIBLE first verdict at the schema, even owner-direct', async () => {
    await expect(c.query(
      `INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict)
       VALUES ($1, gen_random_uuid(), 'circuit_reset', repeat('a', 64), 'killed')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_requests_verdict/);
    // 'rejected_request_reuse' can NEVER be a first verdict — reuse presupposes an existing row
    await expect(c.query(
      `INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict)
       VALUES ($1, gen_random_uuid(), 'channel_kill', repeat('b', 64), 'rejected_request_reuse')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_requests_verdict/);
    // the AUDIT binds each orphan action to ITS transition — crossed or non-quarantined
    // evidence dies at the schema
    await expect(c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, gen_random_uuid(), 'orphan_resolve', 'ev_x', 'quarantined', 'requeued', 'applied', 'crossed')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_audit_coherent/);
    await expect(c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, gen_random_uuid(), 'orphan_requeue', 'ev_x', 'reconciling', 'requeued', 'applied', 'not quarantined')`, [ADMIN]))
      .rejects.toThrow(/chk_notification_admin_audit_coherent/);
    await expect(c.query(
      `INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict)
       VALUES ($1, gen_random_uuid(), 'channel_kill', 'not-a-digest', 'killed')`, [ADMIN]))
      .rejects.toThrow(/fingerprint/);
  });

  it('a group-cancel against a MISSING group is a recorded verdict that consumes the id', async () => {
    const req = crypto.randomUUID();
    const ghost = crypto.randomUUID();
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${ghost}', 'pending', 'why not', '${req}') AS r`))[0].r)
      .toBe('rejected_not_found');
    expect((await c.query(`SELECT verdict FROM public.notification_admin_requests WHERE request_id=$1`, [req])).rows[0].verdict).toBe('rejected_not_found');
    // the id is consumed: a different decision under it is reuse, even against a REAL group
    const g = (await c.query(
      `INSERT INTO public.notification_digest_groups
         (canonical_group_key, group_key_hash, channel, event_type, recipient_key, destination_fingerprint,
          recipient_timezone, digest_boundary_at, available_at, state)
       VALUES (jsonb_build_object('k', gen_random_uuid()), gen_random_uuid()::text, 'email', 'ev_test', 'p:nf', 'fp:' || gen_random_uuid()::text,
               'Europe/Amsterdam', now(), now(), 'pending') RETURNING id`)).rows[0].id;
    expect((await call(ADMIN, `SELECT public.admin_cancel_digest_group('${g}', 'pending', 'why not', '${req}') AS r`))[0].r)
      .toBe('rejected_request_reuse');
    expect((await c.query(`SELECT state FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0].state).toBe('pending');
  });

  it('the M3-continuity backfill rebuilds registry rows from kill audit evidence, with the SAME fingerprint', async () => {
    const req = crypto.randomUUID();
    expect(await adminKill(c2, ADMIN, 'email', req, 'pre-M5 kill')).toBe('killed');
    // simulate the M3-era deploy state: the audit row exists, the registry row does not
    await c.query(`ALTER TABLE public.notification_admin_requests DISABLE TRIGGER trg_notif_admin_requests_guard;`);
    await c.query(`DELETE FROM public.notification_admin_requests WHERE request_id = $1`, [req]);
    await c.query(`ALTER TABLE public.notification_admin_requests ENABLE TRIGGER trg_notif_admin_requests_guard;`);
    // run the REAL backfill statement, extracted verbatim from the migration
    const mig = MIG('20261020100000_notif_n4_send_enabling_recovery.sql');
    const backfill = mig.match(/INSERT INTO public\.notification_admin_requests \(actor, request_id, action, fingerprint, verdict, created_at\)[\s\S]*?ON CONFLICT \(actor, request_id\) DO NOTHING;/)?.[0];
    if (!backfill) throw new Error('backfill statement not found in the migration');
    await c.query(backfill);
    const row = (await c.query(`SELECT verdict FROM public.notification_admin_requests WHERE request_id=$1`, [req])).rows[0];
    expect(row.verdict).toBe('killed');
    // …and the rebuilt fingerprint matches the live RPC's: an exact replay works again
    expect(await adminKill(c2, ADMIN, 'email', req, 'pre-M5 kill')).toBe('killed');
    // while a different decision under that old id is typed reuse, not a unique-violation raise
    expect(await adminKill(c2, ADMIN, 'whatsapp', req, 'pre-M5 kill')).toBe('rejected_request_reuse');
  });
});


describe('N4 M7 — the orphan reader is index-served on its OWN keyset order', () => {
  it('an index matches (updated_at DESC, resend_event_id DESC) exactly', async () => {
    const idx = (await c.query(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname='public' AND indexname='idx_orphan_state_keyset'`)).rows;
    expect(idx.length).toBe(1);
    expect(idx[0].indexdef).toContain('updated_at DESC');
    expect(idx[0].indexdef).toContain('resend_event_id DESC');
  });

  it('the READER query plans onto it — no full sort behind the LIMIT', async () => {
    const plan = (await c.query(`
      EXPLAIN (FORMAT JSON)
      SELECT s.resend_event_id, s.updated_at FROM public.notification_orphan_reconcile_state s
       ORDER BY s.updated_at DESC, s.resend_event_id DESC LIMIT 50`)).rows[0]['QUERY PLAN'];
    const txt = JSON.stringify(plan);
    expect(txt).toContain('idx_orphan_state_keyset');
    expect(txt).not.toContain('"Node Type": "Sort"');
  });
});

describe('N5 — the activation boundary: no historical work can become eligible', () => {
  const boundaryOf = async (path: string) =>
    (await c.query(`SELECT * FROM public.notification_activation_boundaries WHERE path = $1`, [path])).rows[0];
  const open = async (path: string, req = crypto.randomUUID(), reason = 'rollout step 3') =>
    (await c.query(`SELECT public.record_notification_activation_boundary($1,$2,$3) AS r`, [path, reason, req])).rows[0].r as string;

  beforeEach(async () => {
    // back to the shipped seed state: email:instant active from the earliest row, the other two inert
    await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;`);
    await c.query(`DELETE FROM public.notification_activation_boundaries;`);
    await c.query(`
      INSERT INTO public.notification_activation_boundaries (path, state, boundary_at, reason)
      VALUES ('email:instant', 'active', now() - interval '1 hour', 'suite baseline');
      INSERT INTO public.notification_activation_boundaries (path, state)
      VALUES ('email:digest', 'inert'), ('whatsapp:instant', 'inert');`);
    await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
  });

  it('the LIVE path is seeded UNBOUNDED: the contract cannot retro-drop mail that is already queued', async () => {
    // the shipped seed, not the suite baseline — read from the migration the way production runs it
    await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;`);
    await c.query(`DELETE FROM public.notification_activation_boundaries WHERE path = 'email:instant';`);
    await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
    const seed = MIG('20261028100000_notif_n5_activation_boundary.sql')
      .match(/INSERT INTO public\.notification_activation_boundaries \(path, state, boundary_at, reason\)[\s\S]*?ON CONFLICT \(path\) DO NOTHING;/)?.[0];
    if (!seed) throw new Error('the email:instant seed was not found in the migration');
    await c.query(seed);
    const row = (await c.query(`SELECT * FROM public.notification_activation_boundaries WHERE path='email:instant'`)).rows[0];
    expect(row.state).toBe('active');
    expect(String(row.boundary_at).toLowerCase()).toContain('-infinity');   // unbounded: excludes nothing
    // a row created BEFORE any snapshot the migration could have taken is still claimable — the
    // concurrent-enqueue case a min(created_at) boundary would have silently dropped
    const ancient = await seedRow({ created_at: new Date(Date.now() - 90 * 24 * 3600_000).toISOString() });
    expect((await claim(c)).map((r: { outbox_id: string }) => r.outbox_id)).toContain(ancient);
  });

  it('THE INVARIANT: a row created BEFORE the boundary is never claimed — not as fresh work, not as an orphan reclaim', async () => {
    const before = await seedRow({ created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const after = await seedRow();
    const claimed = await claim(c);
    expect(claimed.map((r: { outbox_id: string }) => r.outbox_id)).toEqual([after]);
    expect((await rowOf(before)).status).toBe('pending');          // untouched, not failed, not skipped
    expect((await rowOf(before)).attempts).toBe(0);                // …and not even an attempt spent

    // the ORPHAN-RECLAIM arm is the side door: a historical row that was mid-flight at activation
    // must not come back through it either
    await c.query(
      `UPDATE public.notification_outbox SET status='processing', locked_at = now() - interval '30 minutes', locked_by='dead' WHERE id=$1`,
      [before]);
    const again = await claim(c);
    expect(again.map((r: { outbox_id: string }) => r.outbox_id)).not.toContain(before);
    expect((await rowOf(before)).locked_by).toBe('dead');          // never re-leased
  });

  it('an INERT path claims nothing at all, and leaves no trace of having been asked', async () => {
    const wa = await seedRow({ channel: 'whatsapp' });
    expect(await claim(c, 'w:test', 'whatsapp')).toEqual([]);
    const row = await rowOf(wa);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.locked_by).toBeNull();
    // …until the path is opened, after which only rows created since qualify
    const stale = await seedRow({ channel: 'whatsapp', created_at: new Date(Date.now() - 60_000).toISOString() });
    expect(await open('whatsapp:instant')).toBe('activated');
    const fresh = await seedRow({ channel: 'whatsapp' });
    const claimed = await claim(c, 'w:test', 'whatsapp');
    expect(claimed.map((r: { outbox_id: string }) => r.outbox_id)).toEqual([fresh]);
    expect((await rowOf(stale)).status).toBe('pending');
    expect((await rowOf(wa)).status).toBe('pending');
  });

  it('opening a path is ONE-WAY and request-id idempotent — a boundary can never be moved', async () => {
    const req = crypto.randomUUID();
    expect(await open('whatsapp:instant', req)).toBe('activated');
    const first = await boundaryOf('whatsapp:instant');
    expect(await open('whatsapp:instant', req)).toBe('replayed');             // the exact retry
    expect(await open('whatsapp:instant', crypto.randomUUID())).toBe('already_active');  // anyone else: REFUSED
    expect((await boundaryOf('whatsapp:instant')).boundary_at).toEqual(first.boundary_at);
    // …and the guard binds the owner too: no UPDATE, no DELETE, no TRUNCATE
    await expect(c.query(
      `UPDATE public.notification_activation_boundaries SET boundary_at = now() - interval '1 day' WHERE path='whatsapp:instant'`))
      .rejects.toThrow(/already active since/);
    await expect(c.query(`DELETE FROM public.notification_activation_boundaries WHERE path='whatsapp:instant'`))
      .rejects.toThrow(/append-only/);
    await expect(c.query(`TRUNCATE public.notification_activation_boundaries`)).rejects.toThrow(/append-only/);
    await expect(c.query(
      `UPDATE public.notification_activation_boundaries SET state='inert' WHERE path='email:digest'`))
      .rejects.toThrow(/only transition is inert -> active/);
  });

  it('the boundary RPC refuses an unknown path, a missing request id and a thin reason', async () => {
    await expect(c.query(`SELECT public.record_notification_activation_boundary('email:carrier-pigeon','why',gen_random_uuid())`))
      .rejects.toThrow(/not a known delivery path/);
    await expect(c.query(`SELECT public.record_notification_activation_boundary('whatsapp:instant','why',NULL)`))
      .rejects.toThrow(/request_id is required/);
    await expect(c.query(`SELECT public.record_notification_activation_boundary('whatsapp:instant','no',gen_random_uuid())`))
      .rejects.toThrow(/reason \(3-500 chars\)/);
  });

  it('is not reachable by any API role: the table is definer-only and the opener is service-role-only', async () => {
    const c3 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await c3.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await c3.query(`SET ROLE ${role}`);
        await expect(c3.query(`SELECT * FROM public.notification_activation_boundaries`), `${role} must not read the table directly`).rejects.toThrow();
        await expect(c3.query(`SELECT public.record_notification_activation_boundary('whatsapp:instant','x',gen_random_uuid())`),
          `${role} must not open a delivery path`).rejects.toThrow();
        await c3.query(`RESET ROLE`);
      }
      // service_role may READ (the admin surface) but not write directly
      await c3.query(`SET ROLE service_role`);
      await c3.query(`SELECT * FROM public.notification_activation_boundaries`);
      await expect(c3.query(
        `INSERT INTO public.notification_activation_boundaries (path, state) VALUES ('email:digest','inert')`))
        .rejects.toThrow();
      await c3.query(`RESET ROLE`);
    } finally { await c3.end(); }
  });
});

describe('N5 — the readiness envelope proves the boundary, and the backlog has ONE sanctioned exit', () => {
  const asAdmin = async (sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };
  const check = async (id: string) => {
    const env = (await asAdmin(`SELECT public.admin_notification_readiness() AS e`))[0].e;
    return (env.checks as { id: string; status: string; value?: number; detail: string }[]).find((k) => k.id === id)!;
  };
  const dispose = async (path: string, req = crypto.randomUUID(), reason = 'clearing pre-activation backlog', limit = 500) =>
    (await asAdmin(
      `SELECT * FROM public.admin_dispose_pre_boundary_backlog('${path}', '${reason}', '${req}'::uuid, ${limit})`))[0];

  beforeEach(async () => {
    await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;`);
    await c.query(`DELETE FROM public.notification_activation_boundaries;`);
    await c.query(`
      INSERT INTO public.notification_activation_boundaries (path, state, boundary_at, reason)
      VALUES ('email:instant', 'active', now() - interval '1 hour', 'suite baseline');
      INSERT INTO public.notification_activation_boundaries (path, state)
      VALUES ('email:digest', 'inert'), ('whatsapp:instant', 'inert');`);
    await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
  });

  it('durable_activation_boundary is REAL now: it passes on a coherent set and fails when the mechanism is incomplete', async () => {
    const ok = await check('durable_activation_boundary');
    expect(ok.status).toBe('pass');
    expect(ok.detail).toContain('email:digest=inert');
    expect(ok.detail).toContain('email:instant=active since');
    // a missing path row means a send authority would be gating on nothing
    await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;`);
    await c.query(`DELETE FROM public.notification_activation_boundaries WHERE path = 'whatsapp:instant';`);
    await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
    const bad = await check('durable_activation_boundary');
    expect(bad.status).toBe('fail');
    expect(bad.detail).toContain('expected 3 delivery paths, found 2');
    // …and the envelope's overall verdict is dragged down with it
    const env = (await asAdmin(`SELECT public.admin_notification_readiness() AS e`))[0].e;
    expect(env.readiness).toBe('fail');
  });

  it('pre_activation_backlog_eligible_count counts what the boundary is refusing, and reaches zero only by disposal', async () => {
    expect((await check('pre_activation_backlog_eligible_count')).status).toBe('pass');   // nothing yet
    const old1 = await seedRow({ created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const old2 = await seedRow({ created_at: new Date(Date.now() - 3 * 3600_000).toISOString() });
    const fresh = await seedRow();
    const c1 = await check('pre_activation_backlog_eligible_count');
    expect(c1.status).toBe('fail');
    expect(c1.value).toBe(2);                                    // the fresh row is not backlog
    expect(c1.detail).toContain('2 pending row(s)');
    expect(c1.detail).toContain('0 non-terminal group(s)');      // the same fact one hop later
    expect(c1.detail).toContain('admin_dispose_pre_boundary_backlog');

    const r = await dispose('email:instant');
    expect(r.verdict).toBe('disposed');
    expect(r.disposed).toBe(2);
    expect((await rowOf(old1)).status).toBe('skipped');
    expect((await rowOf(old1)).skip_reason).toBe('pre_activation_boundary');
    expect((await rowOf(old2)).status).toBe('skipped');
    expect((await rowOf(fresh)).status).toBe('pending');          // live work untouched
    expect((await check('pre_activation_backlog_eligible_count')).status).toBe('pass');
    // the audit row carries the SIZE of the act, not merely that it happened
    const audit = (await c.query(
      `SELECT * FROM public.notification_admin_audit WHERE action = 'backlog_dispose'`)).rows;
    expect(audit.length).toBe(1);
    expect(audit[0]).toMatchObject({ target: 'email:instant', old_value: '2', new_value: 'pre_activation_boundary', outcome: 'applied' });
  });

  it('disposal is admin-fail-closed, request-id idempotent, and REFUSES an inert or unknown path', async () => {
    await expect(c2.query(
      `SELECT * FROM public.admin_dispose_pre_boundary_backlog('email:instant','why not',gen_random_uuid(),10)`))
      .rejects.toThrow(/platform admin only/);
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [PLAYER]);
    await expect(c2.query(
      `SELECT * FROM public.admin_dispose_pre_boundary_backlog('email:instant','why not',gen_random_uuid(),10)`))
      .rejects.toThrow(/platform admin only/);
    await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);

    // an INERT path has no boundary, so nothing there is provably historical
    expect((await dispose('email:digest')).verdict).toBe('rejected_path_inert');
    expect((await dispose('email:carrier-pigeon')).verdict).toBe('rejected_unknown_path');
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_admin_rejected_attempts WHERE action='backlog_dispose'`)).rows[0].n).toBe(2);

    // idempotency: the SAME request id returns the recorded decision and disposes nothing twice
    await seedRow({ created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const req = crypto.randomUUID();
    expect((await dispose('email:instant', req)).disposed).toBe(1);
    const replay = await dispose('email:instant', req);
    expect(replay.verdict).toBe('disposed');
    expect(replay.disposed).toBe(0);                              // the replay moves nothing
    // …and a retry that WIDENS the batch is conflicting reuse, not a replay
    expect((await dispose('email:instant', req, 'clearing pre-activation backlog', 900)).verdict)
      .toBe('rejected_request_reuse');
  });

  it('disposal touches ONLY pending pre-boundary rows on the named path — never a sent row, never another channel', async () => {
    const older = new Date(Date.now() - 2 * 3600_000).toISOString();
    const sent = await seedRow({ status: 'sent', created_at: older });
    const wa = await seedRow({ channel: 'whatsapp', created_at: older });
    const digest = await seedRow({ delivery_mode: 'digest', created_at: older });
    const target = await seedRow({ created_at: older });
    const r = await dispose('email:instant');
    expect(r.disposed).toBe(1);
    expect((await rowOf(target)).status).toBe('skipped');
    expect((await rowOf(sent)).status).toBe('sent');              // terminal work is not re-decided
    expect((await rowOf(wa)).status).toBe('pending');             // another channel's queue
    expect((await rowOf(digest)).status).toBe('pending');         // the digest path is its own boundary
  });
});

describe('N5 — the admin read of the delivery paths', () => {
  const asAdmin = async (sql: string) => {
    await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
    try { return (await c2.query(sql)).rows; }
    finally { await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };

  it('reports every path, its boundary, and what is stuck behind it — admin fail-closed', async () => {
    await c.query(`ALTER TABLE public.notification_activation_boundaries DISABLE TRIGGER trg_notif_activation_boundary_guard;`);
    await c.query(`DELETE FROM public.notification_activation_boundaries;`);
    await c.query(`
      INSERT INTO public.notification_activation_boundaries (path, state, boundary_at, reason)
      VALUES ('email:instant', 'active', now() - interval '1 hour', 'suite baseline');
      INSERT INTO public.notification_activation_boundaries (path, state)
      VALUES ('email:digest', 'inert'), ('whatsapp:instant', 'inert');`);
    await c.query(`ALTER TABLE public.notification_activation_boundaries ENABLE TRIGGER trg_notif_activation_boundary_guard;`);
    await seedRow({ created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await seedRow();                                        // live work: never counted as backlog
    await seedRow({ channel: 'whatsapp', created_at: new Date(Date.now() - 2 * 3600_000).toISOString() });

    for (const uid of [null, PLAYER]) {
      await c2.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
      await expect(c2.query(`SELECT * FROM public.admin_notification_activation_boundaries()`)).rejects.toThrow();
      await c2.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
    }
    const rows = await asAdmin(`SELECT * FROM public.admin_notification_activation_boundaries()`);
    expect(rows.map((r) => r.path)).toEqual(['email:digest', 'email:instant', 'whatsapp:instant']);
    const instant = rows.find((r) => r.path === 'email:instant')!;
    expect(instant.state).toBe('active');
    expect(instant.pending_before_boundary).toBe(1);
    expect(instant.pending_before_boundary_capped).toBe(false);
    // an INERT path counts nothing: without a boundary, nothing there is provably historical
    expect(rows.find((r) => r.path === 'whatsapp:instant')!.pending_before_boundary).toBe(0);
    expect(rows.find((r) => r.path === 'email:digest')!.boundary_at).toBeNull();
  });
});

describe('N6 — clearing a kill: the one reviewed way back', () => {
  const preview = async (channel: string) =>
    (await c.query(`SELECT * FROM public.preview_notification_channel_kill_clear($1)`, [channel])).rows[0];
  const clear = async (channel: string, killReq: string, req = crypto.randomUUID(),
                       reason = 'incident closed', expectedPending?: number) => {
    const n = expectedPending ?? (await preview(channel))?.pending_now ?? 0;
    return (await c.query(`SELECT * FROM public.clear_notification_channel_kill($1,$2,$3,$4,$5)`,
      [channel, killReq, n, reason, req])).rows[0];
  };
  const killWith = async (req: string, channel = 'email') => {
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [ADMIN]);
    try { await c.query(`SELECT public.admin_activate_channel_kill($1,'incident 7',$2)`, [channel, req]); }
    finally { await c.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); }
  };

  it('clears the EXACT kill it was shown, audits it beside the original, and says what it released', async () => {
    const killReq = crypto.randomUUID();
    await killWith(killReq);
    await seedRow(); await seedRow();                                  // queued while the channel was dead
    expect(await claim(c)).toEqual([]);                                // …and provably going nowhere
    const r = await clear('email', killReq);
    expect(r.verdict).toBe('cleared');
    expect(r.pending_released).toBe(2);                                // the operator learns the size first
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(0);
    // the DECISION survives its row: kill and clear, both immutable, in order
    const audit = (await c.query(
      `SELECT action, old_value, new_value, outcome FROM public.notification_admin_audit
        WHERE action IN ('channel_kill','channel_kill_cleared') ORDER BY created_at`)).rows;
    expect(audit.map((a) => a.action)).toEqual(['channel_kill', 'channel_kill_cleared']);
    expect(audit[1]).toMatchObject({ old_value: 'killed', new_value: 'live', outcome: 'applied' });
    expect((await claim(c)).length).toBe(2);                           // and mail resumes
  });

  it('REFUSES a kill it was not shown — a different live kill is a different incident', async () => {
    const killReq = crypto.randomUUID();
    await killWith(killReq);
    const r = await clear('email', crypto.randomUUID());
    expect(r.verdict).toBe('rejected_stale_kill');
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(1);
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_admin_rejected_attempts WHERE action='channel_kill_cleared'`)).rows[0].n).toBe(1);
    // …and clearing a channel that is not killed at all is its own typed refusal
    expect((await clear('whatsapp', crypto.randomUUID())).verdict).toBe('rejected_not_killed');
    // the real one still clears
    expect((await clear('email', killReq)).verdict).toBe('cleared');
  });

  it('is request-id idempotent, and the guard still refuses every OTHER way out', async () => {
    const killReq = crypto.randomUUID();
    await killWith(killReq);
    const req = crypto.randomUUID();
    expect((await clear('email', killReq, req)).verdict).toBe('cleared');
    expect((await clear('email', killReq, req)).verdict).toBe('cleared');   // replayed from the registry
    // a second kill, and the ordinary ways out are still closed
    const killReq2 = crypto.randomUUID();
    await killWith(killReq2);
    await expect(c.query(`DELETE FROM public.notification_channel_kill_switches WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await expect(c.query(`UPDATE public.notification_channel_kill_switches SET reason='x' WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await expect(c.query(`TRUNCATE public.notification_channel_kill_switches`)).rejects.toThrow(/SET-ONLY/);
    // …including publishing the WRONG id into the guard's key
    await c.query(`SELECT set_config('notif.kill_clear_request', $1, false)`, [crypto.randomUUID()]);
    await expect(c.query(`DELETE FROM public.notification_channel_kill_switches WHERE channel='email'`))
      .rejects.toThrow(/SET-ONLY/);
    await c.query(`SELECT set_config('notif.kill_clear_request', '', false)`);
    expect((await clear('email', killReq2)).verdict).toBe('cleared');
  });

  it('the confirmation is about a number the operator SAW: a queue that grew is refused', async () => {
    const killReq = crypto.randomUUID();
    await killWith(killReq);
    await seedRow();
    const seen = (await preview('email')).pending_now;       // what the preview showed: 1
    expect(seen).toBe(1);
    await seedRow(); await seedRow();                        // …and three more arrive while they think
    const r = await clear('email', killReq, crypto.randomUUID(), 'incident closed', seen);
    expect(r.verdict).toBe('rejected_backlog_grew');
    expect(r.pending_released).toBe(3);                      // the refusal SAYS what it found
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(1);
    // a SHRINK is never a reason to refuse — someone disposing of the queue is good news
    expect((await clear('email', killReq, crypto.randomUUID(), 'incident closed', 99)).verdict).toBe('cleared');
  });

  it('the preview reads without changing anything, and says nothing when the channel is live', async () => {
    expect(await preview('email')).toBeUndefined();          // not killed → no row
    const killReq = crypto.randomUUID();
    await killWith(killReq);
    await seedRow();
    const p = await preview('email');
    expect(p).toMatchObject({ channel: 'email', kill_request_id: killReq, pending_now: 1 });
    expect(p.reason).toBe('incident 7');
    expect(p.killed_for).toBeTruthy();
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(1);
    expect((await clear('email', killReq)).verdict).toBe('cleared');
  });

  it('the bound is TRANSACTIONAL: an enqueue cannot slip in between the count and the clear', async () => {
    // the advisory lock the claims share does not cover enqueue_notification, so without the
    // outbox SHARE lock a producer could commit rows after the count and before the kill is gone —
    // and more mail would resume than the operator confirmed.
    const killReq = crypto.randomUUID();
    await killWith(killReq);
    await seedRow();
    const seen = (await preview('email')).pending_now;
    await c.query('BEGIN');
    await c.query(`SELECT * FROM public.clear_notification_channel_kill($1,$2,$3,$4,$5)`,
      [ 'email', killReq, seen, 'incident closed', crypto.randomUUID() ]);
    // …a concurrent INSERT must WAIT for this transaction rather than land inside its window
    let settled = false;
    const late = c2.query(
      `INSERT INTO public.notification_outbox (channel, event_type, template_key, status, destination_normalized,
         scheduled_for, payload, idempotency_key, recipient_user_id)
       VALUES ('email','ev_test','tpl','pending','late@example.com', now(), '{}'::jsonb, gen_random_uuid()::text, $1)`,
      [PLAYER]).finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(false);                       // provably serialized behind the clear
    await c.query('COMMIT');
    await late;
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_channel_kill_switches`)).rows[0].n).toBe(0);
  });

  it('is not reachable by any API role — un-killing is a runbook decision, not a page control', async () => {
    const c3 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await c3.connect();
    try {
      for (const role of ['anon', 'authenticated']) {
        await c3.query(`SET ROLE ${role}`);
        await expect(c3.query(
          `SELECT * FROM public.clear_notification_channel_kill('email', gen_random_uuid(), 0, 'x', gen_random_uuid())`),
          `${role} must not clear a kill`).rejects.toThrow();
        await c3.query(`RESET ROLE`);
      }
    } finally { await c3.end(); }
  });
});
