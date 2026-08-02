// @vitest-environment node
// 10c-a3 PR-1 — the orphan-reconcile + email-suppression SQL verified on a REAL multi-connection Postgres server
// (embedded-postgres; no Docker, no stubs for the digest state machine). Loads the FULL chain — email delivery
// (real is_email_suppressed) + the ADR-0008 digest schema/ACL/state-machine + the two new PR-1 migrations — over
// prod-faithful default privileges, then exercises with the REAL notif_digest_* functions:
//   * tagged callback-before-record (early orphan) → defer → bind (send records id) → reconcile links; queue cleaned
//   * provider-id fallback (untagged, id matches a bound group) → apply links immediately
//   * unknown/invalid tag → loud; untagged + no match → not_digest; duplicate callback → duplicate
//   * a DELETED tagged group → tagged_group_missing (permanent) ; resolve + requeue lifecycle
//   * two-session duplicate-callback ↔ reconcile race: ONE final outcome, NO deadlock (event→group lock order)
//   * two-session concurrent complained/delivered on record_email_event (serialized; recency holds either commit order)
//   * locked-row has_more concurrency (a row another worker holds is NOT reported as remaining → no hot-loop)
//   * 100k-row bounded candidate query (EXPLAIN ANALYZE, BUFFERS → index range scan on idx_orphan_reconcile_due)
//   * the complete default-privilege ACL matrix + owner-effective append-only audit (UPDATE/DELETE/TRUNCATE)
// INERT: no worker/webhook, no digest-enabled event.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54351;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let url = '';
let seq = 0;
const NOW = "'2026-07-01 10:00:00+00'::timestamptz";
const BD = "'2026-07-01 06:00:00+00'::timestamptz";
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');
function conn() { return new Client({ connectionString: url }); }

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orphan-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise(); await epg.start();
  url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
  const c = conn(); await c.connect();
  // prod-faithful default privileges (reproduces the footgun the ACL migrations strip)
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    -- a bare, grantless role: its effective privileges == PUBLIC's (roles inherit PUBLIC), so it proxies PUBLIC in the
    -- ACL matrix without relying on has_*_privilege accepting the literal 'public'.
    CREATE ROLE probe_public;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  // email chain first → provides the REAL is_email_suppressed() the digest chain calls at runtime (no stub).
  await c.query(`CREATE TABLE public.invoices (id uuid PRIMARY KEY);`);
  await c.query(MIG('20260615110000_email_delivery_tables.sql'));
  await c.query(MIG('20260615110010_record_email_event.sql'));
  await c.query(MIG('20261006100000_email_delivery_concurrency_suppression.sql'));
  // prod-shaped digest stubs (mirror notificationDigestStateMachine.realpg.test.ts) — minus is_email_suppressed.
  await c.query(`
    CREATE TABLE public.notification_event_types (key text PRIMARY KEY, supports_digest boolean NOT NULL DEFAULT false,
      required_delivery boolean NOT NULL DEFAULT false);
    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, user_id uuid, guest_player_id uuid,
      channel text NOT NULL DEFAULT 'email', destination_normalized text NOT NULL,
      consent_status text NOT NULL DEFAULT 'unknown', consent_scope text NOT NULL DEFAULT 'global',
      consent_academy_profile_id uuid, consent_trainer_id uuid, revoked_at timestamptz,
      is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz);
    CREATE FUNCTION public.is_notification_consent_in_scope(
      _consent_scope text, _consent_academy uuid, _consent_trainer uuid, _ctx_academy uuid, _ctx_trainer uuid)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE WHEN _consent_scope = 'global' THEN true
        WHEN _consent_scope = 'tenant' THEN
              (_consent_academy IS NULL OR (_ctx_academy IS NOT NULL AND _ctx_academy = _consent_academy))
          AND (_consent_trainer IS NULL OR (_ctx_trainer IS NOT NULL AND _ctx_trainer = _consent_trainer))
          AND (_consent_academy IS NOT NULL OR _consent_trainer IS NOT NULL)
        ELSE false END $$;
    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email',
      event_type text, template_key text, status text NOT NULL DEFAULT 'pending',
      payload jsonb, public_summary jsonb, skip_reason text, destination_normalized text,
      contact_id uuid REFERENCES public.notification_contacts(id) ON DELETE SET NULL,
      recipient_person_id uuid, recipient_user_id uuid, recipient_guest_player_id uuid,
      tenant_academy_profile_id uuid, tenant_trainer_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')));
    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL, email_frequency text NOT NULL DEFAULT 'instant',
      UNIQUE (user_id, event_type));
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);`);
  for (const f of ['20261002100000_notification_digest_schema_foundation.sql',
    '20261003100000_notification_digest_acl_lockdown.sql', '20261004100000_notification_digest_state_machine.sql']) {
    await c.query(MIG(f));
  }
  await c.query(MIG('20261006110000_reconcile_orphan_provider_events.sql'));
  await c.end();
}, 180_000);

afterAll(async () => { if (epg) await epg.stop(); });

beforeEach(async () => {
  const c = conn(); await c.connect();
  try {
    // the actions table's immutable triggers block TRUNCATE even for the owner → disable around the reset.
    await c.query(`ALTER TABLE public.notification_orphan_reconcile_actions DISABLE TRIGGER USER`);
    await c.query(`TRUNCATE public.notification_digest_groups, public.notification_digest_attempts,
      public.notification_digest_group_attempts, public.notification_provider_events, public.notification_provider_circuit,
      public.notification_send_counters, public.notification_send_reservations, public.notification_worker_runs,
      public.notification_outbox, public.notification_preferences_v2, public.notification_contacts, public.persons,
      public.notification_orphan_reconcile_state, public.notification_orphan_reconcile_actions,
      public.email_address_state, public.email_delivery_events RESTART IDENTITY CASCADE`);
    await c.query(`ALTER TABLE public.notification_orphan_reconcile_actions ENABLE TRIGGER USER`);
  } finally { await c.end(); }
});

// ── digest helpers (thin re-use of the state-machine test's proven path) ────────────────────────────────────────
async function fpOf(c: pg.Client, dest: string) { return (await c.query(`SELECT public.notif_digest_destination_fingerprint($1) f`, [dest])).rows[0].f; }
async function seedMember(c: pg.Client, key: string, dest: string) {
  const fp = await fpOf(c, dest);
  const userId = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
  await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1,$2)`, [userId, dest]);
  await c.query(`INSERT INTO public.notification_outbox
    (channel, delivery_mode, recipient_key, destination_fingerprint, destination_normalized, recipient_user_id,
     event_type, template_key, template_version, group_locale, digest_frequency, recipient_timezone, digest_boundary_at, digest_item, status)
    VALUES ('email','digest',$1,$2,$3,$4,'ev','tpl',1,'nl','daily','Europe/Amsterdam', ${BD}, '{}'::jsonb, 'pending')`,
    [key, fp, dest, userId]);
}
// a group that is PREPARED + FROZEN but has NO live attempt yet → bind returns 'no_live_send' (early-orphan window).
async function toPreSend(c: pg.Client) {
  seq += 1; const key = `p:${seq}`; const dest = `u${seq}@example.com`;
  await seedMember(c, key, dest);
  const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
  await c.query(`SELECT public.materialize_notification_digest_groups($1,'email', ${NOW}, 100, 100)`, [mrun]);
  const g = (await c.query(`SELECT id FROM public.notification_digest_groups WHERE recipient_key=$1`, [key])).rows[0].id;
  const run = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
  await c.query(`SELECT public.claim_notification_digest_group($1,'email', ${NOW}, 'W')`, [run]);
  await c.query(`SELECT public.prepare_notification_digest_group($1,$2,'W', ${NOW})`, [run, g]);
  await c.query(`SELECT public.store_notification_digest_request($1,$2,'W',
    jsonb_build_object('to',$3::text,'subject','s','html','<p>x</p>'), ${NOW})`, [run, g, dest]);
  return { g, run, dest };
}
// drive an already-prepared group to a BINDABLE live send.
const begin = (c: pg.Client, run: string, g: string) => c.query(`SELECT public.begin_notification_digest_attempt($1,$2,'W', ${NOW})`, [run, g]);
// simulate the worker recording the send's provider_message_id (the real bind the worker performs on record).
const bindPm = (c: pg.Client, g: string, pm: string) => c.query(`SELECT public.notif_digest_bind_provider_message($1,$2, ${NOW}) AS r`, [g, pm]);
const dispatchRun = async (c: pg.Client) => (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
const apply = (c: pg.Client, run: string | null, eid: string, pm: string, tag: string | null, status = 'delivered') =>
  c.query(`SELECT public.apply_notification_provider_event(${run ? '$1' : 'NULL'},$2,$3,$4,$5, ${NOW}, ${NOW}) AS r`,
    run ? [run, eid, pm, tag, status] : [eid, pm, tag, status]);
const reconcile = (c: pg.Client, run: string, limit = 100, now = NOW) =>
  c.query(`SELECT * FROM public.reconcile_orphan_provider_events($1,'email', ${now}, $2)`, [run, limit]);
const qRow = async (c: pg.Client, eid: string) =>
  (await c.query(`SELECT * FROM public.notification_orphan_reconcile_state WHERE resend_event_id=$1`, [eid])).rows[0];
const evGroup = async (c: pg.Client, eid: string) =>
  (await c.query(`SELECT digest_group_id FROM public.notification_provider_events WHERE resend_event_id=$1`, [eid])).rows[0]?.digest_group_id ?? null;

describe('full-chain apply / bind / reconcile with the REAL digest functions', () => {
  it('tagged callback-before-record: orphan → defer → send binds id → reconcile links → queue cleaned', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toPreSend(c);                                  // bind → no_live_send
      expect((await apply(c, run, 'ev-eo', 'pm-eo', g)).rows[0].r).toBe('orphan');
      expect(await evGroup(c, 'ev-eo')).toBeNull();
      const q0 = await qRow(c, 'ev-eo');
      expect(q0.digest_group_id).toBe(g); expect(q0.channel).toBe('email');    // retained tag + derived channel
      // reconcile before the send binds its id → deferred (group exists, unbound)
      let r = (await reconcile(c, await dispatchRun(c))).rows[0];
      expect(r).toMatchObject({ examined: 1, linked: 0, quarantined: 0 });
      expect(r.deferred).toBe(1);
      expect((await qRow(c, 'ev-eo')).last_error_code).toBe('not_ready');
      // the send completes: begin the attempt, then the worker records the provider id (real bind)
      await begin(c, run, g);
      expect((await bindPm(c, g, 'pm-eo')).rows[0].r).toBe('ok');
      // now reconcile (past the backoff) links the orphan to its ORIGINAL tagged group, cleans the queue
      r = (await reconcile(c, await dispatchRun(c), 100, `${NOW} + interval '999 minutes'`)).rows[0];
      expect(r.linked).toBe(1);
      expect(await evGroup(c, 'ev-eo')).toBe(g);
      expect(await qRow(c, 'ev-eo')).toBeUndefined();
      expect((await c.query(`SELECT provider_status FROM public.notification_digest_groups WHERE id=$1`, [g])).rows[0].provider_status).toBe('delivered');
    } finally { await c.end(); }
  });

  it('provider-id fallback: an UNTAGGED callback whose id matches a bound group links immediately', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toPreSend(c);
      await begin(c, run, g); await bindPm(c, g, 'pm-fb');                     // group bound to pm-fb
      expect((await apply(c, run, 'ev-fb', 'pm-fb', /*tag*/ null, 'delivered')).rows[0].r).toBe('sent');
      expect(await evGroup(c, 'ev-fb')).toBe(g);
      expect(await qRow(c, 'ev-fb')).toBeUndefined();                          // never queued — direct correlation
    } finally { await c.end(); }
  });

  it('unknown tag fails loud; untagged + no match → not_digest; duplicate → duplicate', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toPreSend(c); await begin(c, run, g); await bindPm(c, g, 'pm-x');
      await expect(apply(c, run, 'ev-bad', 'pm-x', '00000000-0000-0000-0000-000000000000'))
        .rejects.toThrow(/unknown\/stale digest_group_id/);
      expect((await apply(c, run, 'ev-nd', 'pm-nomatch', null)).rows[0].r).toBe('not_digest');
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id='ev-nd'`)).rows[0].n).toBe(0);
      expect((await apply(c, run, 'ev-dup', 'pm-x', g)).rows[0].r).toBe('sent');
      expect((await apply(c, run, 'ev-dup', 'pm-x', g)).rows[0].r).toBe('duplicate');
    } finally { await c.end(); }
  });

  it('a MISSING tagged group quarantines immediately as tagged_group_missing (permanent)', async () => {
    const c = conn(); await c.connect();
    try {
      // a group deleted (retention-swept) AFTER an orphan was enrolled against it. The digest guard forbids deleting a
      // live group, so seed the post-purge state directly (owner): an orphan provider event + a queue row whose tag
      // points at a now-absent group.
      const gone = (await c.query(`SELECT gen_random_uuid() u`)).rows[0].u;
      await c.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at) VALUES ('ev-del','pm-del','delivered', ${NOW})`);
      await c.query(`INSERT INTO public.notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id, next_eligible_at) VALUES ('ev-del','email',$1, ${NOW})`, [gone]);
      const r = (await reconcile(c, await dispatchRun(c))).rows[0];
      expect(r).toMatchObject({ examined: 1, linked: 0, quarantined: 1 });
      const q = await qRow(c, 'ev-del');
      expect(q.quarantined).toBe(true); expect(q.attempts).toBe(1); expect(q.last_error_code).toBe('tagged_group_missing');
    } finally { await c.end(); }
  });

  it('apply validates a supplied run as an UNFINISHED email/dispatch run (real notif_digest_assert_run)', async () => {
    const c = conn(); await c.connect();
    try {
      const { g } = await toPreSend(c);
      const applyWith = (eid: string, runSql: string) =>
        c.query(`SELECT public.apply_notification_provider_event(${runSql},$1,'pm-rd',$2,'delivered', ${NOW}, ${NOW})`, [eid, g]);
      // missing run
      await expect(applyWith('e-rd1', `'00000000-0000-0000-0000-000000000000'::uuid`)).rejects.toThrow(/not found/i);
      // materialize-phase run → wrong phase
      const mrun = (await c.query(`SELECT public.start_notification_worker_run('w','email','materialize') AS r`)).rows[0].r;
      await expect(applyWith('e-rd2', `'${mrun}'::uuid`)).rejects.toThrow(/phase/i);
      // whatsapp-channel run → wrong channel
      const wrun = (await c.query(`SELECT public.start_notification_worker_run('w','whatsapp','dispatch') AS r`)).rows[0].r;
      await expect(applyWith('e-rd3', `'${wrun}'::uuid`)).rejects.toThrow(/channel/i);
      // finished dispatch/email run
      const frun = (await c.query(`SELECT public.start_notification_worker_run('w','email','dispatch') AS r`)).rows[0].r;
      await c.query(`SELECT public.finish_notification_worker_run($1,'succeeded')`, [frun]);
      await expect(applyWith('e-rd4', `'${frun}'::uuid`)).rejects.toThrow(/finished/i);
      // none of the rejected NEW events were stored
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id LIKE 'e-rd%'`)).rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  it('event-first idempotency with the real functions: duplicate after RUN completion, and an id collision', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toPreSend(c); await begin(c, run, g); await bindPm(c, g, 'pm-if');
      expect((await apply(c, run, 'e-if', 'pm-if', g)).rows[0].r).toBe('sent');
      // finish the run; a retry of the SAME event must still be idempotent (duplicate), not a run-finished error
      await c.query(`SELECT public.finish_notification_worker_run($1,'succeeded')`, [run]);
      const run2 = await dispatchRun(c);
      expect((await apply(c, run2, 'e-if', 'pm-if', g)).rows[0].r).toBe('duplicate');
      // a collision (same id, different provider id/status) fails loudly
      await expect(apply(c, run2, 'e-if', 'pm-DIFFERENT', g)).rejects.toThrow(/collision/i);
    } finally { await c.end(); }
  });

  it('recovery lifecycle: a tagged_mismatch is quarantined then RESOLVED (audited); a transient is REQUEUED', async () => {
    const c = conn(); await c.connect();
    try {
      // tagged mismatch: group bound to pm-A, callback tagged=g but carries pm-B
      const { g, run } = await toPreSend(c); await begin(c, run, g); await bindPm(c, g, 'pm-A');
      expect((await apply(c, run, 'ev-mm', 'pm-B', g)).rows[0].r).toBe('mismatch');
      const rr = (await reconcile(c, await dispatchRun(c))).rows[0];
      expect(rr.quarantined).toBe(1);
      expect((await qRow(c, 'ev-mm')).last_error_code).toBe('tagged_mismatch');
      expect(await evGroup(c, 'ev-mm')).toBeNull();                            // NEVER reassigned to any other group
      // resolve (owner) clears the operational backlog + preserves the provider event + audits
      expect((await c.query(`SELECT public.notification_orphan_reconcile_resolve('ev-mm','ops','bad tag; ack') ok`)).rows[0].ok).toBe(true);
      expect(await qRow(c, 'ev-mm')).toBeUndefined();
      expect((await c.query(`SELECT count(*)::int n FROM public.notification_provider_events WHERE resend_event_id='ev-mm'`)).rows[0].n).toBe(1);
      expect((await c.query(`SELECT action, actor FROM public.notification_orphan_reconcile_actions WHERE resend_event_id='ev-mm'`)).rows[0]).toMatchObject({ action: 'resolve', actor: 'ops' });
    } finally { await c.end(); }
  });
});

describe('two-session concurrency (real multi-connection)', () => {
  it('duplicate-callback ↔ reconcile race on the SAME queued orphan: reconcile links, dup is idempotent, NO deadlock', async () => {
    const eid = 'ev-rc'; const pm = 'pm-rc';
    // an early orphan (queued) whose group is now bound to the matching id → reconcile WILL link it
    const s = conn(); await s.connect();
    const { g, run } = await toPreSend(s);
    await apply(s, run, eid, pm, g);                          // bind no_live_send → orphan enqueued
    await begin(s, run, g); await bindPm(s, g, pm);           // send records id → group bound to pm
    await s.end();
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      const rrun = await dispatchRun(a);
      await a.query('BEGIN'); await b.query('BEGIN');
      // A: reconcile → link_ locks EVENT (FOR UPDATE) then GROUP (bind). Fire it and let it acquire the event.
      const recP = a.query(`SELECT * FROM public.reconcile_orphan_provider_events($1,'email', ${NOW}, 100)`, [rrun]);
      await new Promise(r => setTimeout(r, 300));
      // B: a duplicate callback for the same event — apply also locks EVENT then GROUP (SAME order → no cycle).
      const dupP = b.query(`SELECT public.apply_notification_provider_event($1,$2,$3,$4,'delivered', ${NOW}, ${NOW}) AS r`, [run, eid, pm, g]);
      const recR = (await recP).rows[0]; await a.query('COMMIT');   // A finishes + releases
      const dupR = (await dupP).rows[0].r; await b.query('COMMIT'); // B proceeds after A — never a deadlock abort
      expect(recR.examined).toBe(1); expect(recR.linked).toBe(1);
      expect(dupR).toBe('duplicate');                          // the callback never double-applies
      expect(await evGroup(a, eid)).toBe(g);                   // exactly one durable outcome
      expect(await qRow(a, eid)).toBeUndefined();
    } finally { await a.end(); await b.end(); }
  });

  it('concurrent complained + delivered on record_email_event serialize; the bounce is never lost', async () => {
    for (const [order, e1, e2] of [['cd', 'complained', 'delivered'], ['dc', 'delivered', 'complained']] as const) {
      const email = `conc-${order}@x.com`;
      const a = conn(); const b = conn(); await a.connect(); await b.connect();
      try {
        await a.query('BEGIN'); await b.query('BEGIN');
        // same instant; the FOR UPDATE row lock serializes them
        const p1 = a.query(`SELECT public.record_email_event($1,$2,NULL,$3,NULL,NULL,NULL,NULL,NULL, ${NOW})`, [e1, email, `${order}-1`]);
        await new Promise(r => setTimeout(r, 150));
        const p2 = b.query(`SELECT public.record_email_event($1,$2,NULL,$3,NULL,NULL,NULL,NULL,NULL, ${NOW})`, [e2, email, `${order}-2`]);
        await p1; await a.query('COMMIT');
        await p2; await b.query('COMMIT');
        // complaint is sticky vs a same-instant delivery → the address ends complained + suppressed, either order
        const s = (await a.query(`SELECT state, is_suppressed FROM public.email_address_state WHERE email=$1`, [email])).rows[0];
        expect(s.state).toBe('complained'); expect(s.is_suppressed).toBe(true);
      } finally { await a.end(); await b.end(); }
    }
  });

  it('locked-row has_more: a row another worker holds is NOT reported as remaining (no hot-loop)', async () => {
    const setup = conn(); await setup.connect();
    const { g, run } = await toPreSend(setup);
    await apply(setup, run, 'ev-lk', 'pm-lk', g);                             // one DUE queue row (not_ready orphan)
    await setup.end();
    const a = conn(); const b = conn(); await a.connect(); await b.connect();
    try {
      await a.query('BEGIN');
      await a.query(`SELECT 1 FROM public.notification_orphan_reconcile_state WHERE resend_event_id='ev-lk' FOR UPDATE`); // A holds it
      const r = (await b.query(`SELECT * FROM public.reconcile_orphan_provider_events($1,'email', ${NOW}, 1)`, [await dispatchRun(b)])).rows[0];
      expect(r.examined).toBe(0);          // SKIP LOCKED skipped A's row
      expect(r.has_more).toBe(false);      // examined != p_limit → the caller loop ENDS (does not spin on the locked row)
      await a.query('COMMIT');
    } finally { await a.end(); await b.end(); }
  });
});

describe('bounded at scale: the reconcile candidate query is an index range scan at 100k', () => {
  it('EXPLAIN (ANALYZE, BUFFERS) uses idx_orphan_reconcile_due, not a seq scan', async () => {
    const c = conn(); await c.connect();
    try {
      // 100k FUTURE (not-due) rows + a handful DUE — the due partial index must avoid scanning the backlog.
      // seed orphan provider_events (FK parent; digest_group_id NULL) + queue rows directly (owner). The queue's
      // digest_group_id has no FK (a group may be purged), so a random uuid is fine — the PLAN only touches the queue.
      await c.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
        SELECT 'f'||i, 'pmf'||i, 'delivered', ${NOW} FROM generate_series(1,100000) i`);
      await c.query(`INSERT INTO public.notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id, next_eligible_at)
        SELECT 'f'||i, 'email', gen_random_uuid(), ${NOW} + interval '10 days' FROM generate_series(1,100000) i`);
      await c.query(`INSERT INTO public.notification_provider_events (resend_event_id, provider_message_id, status, occurred_at)
        SELECT 'd'||i, 'pmd'||i, 'delivered', ${NOW} FROM generate_series(1,5) i`);
      await c.query(`INSERT INTO public.notification_orphan_reconcile_state (resend_event_id, channel, digest_group_id, next_eligible_at)
        SELECT 'd'||i, 'email', gen_random_uuid(), ${NOW} - interval '1 minute' FROM generate_series(1,5) i`);
      await c.query(`ANALYZE public.notification_orphan_reconcile_state`);
      // Extract the reconcile candidate SELECT from the DEPLOYED function definition (pg_get_functiondef) — NOT a
      // handwritten copy — so if the shipped RPC's predicate drifts, this EXPLAIN drifts with it.
      const fnDef = (await c.query(
        `SELECT pg_get_functiondef('public.reconcile_orphan_provider_events(uuid,text,timestamptz,int)'::regprocedure) AS d`)).rows[0].d as string;
      const m = fnDef.match(/SELECT rs\.resend_event_id[\s\S]*?SKIP LOCKED/);
      expect(m, 'candidate SELECT must be extractable from the deployed function').toBeTruthy();
      const candidate = m![0].replace(/p_channel/g, `'email'`).replace(/v_now/g, NOW).replace(/p_limit/g, '100');
      // the extracted query must still carry the index-relevant predicates (a drift that drops them is caught here)
      expect(candidate).toMatch(/NOT rs\.quarantined/);
      expect(candidate).toMatch(/rs\.next_eligible_at <=/);
      const plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate}`)).rows[0]['QUERY PLAN'];
      const planStr = JSON.stringify(plan);
      expect(planStr).toMatch(/idx_orphan_reconcile_due/);   // index range scan on the due partial index
      expect(planStr).not.toMatch(/Seq Scan/);               // never a backlog seq-scan at 100k
    } finally { await c.end(); }
  }, 60_000);
});

describe('default-privilege ACL matrix + owner-effective append-only audit', () => {
  it('the COMPLETE PUBLIC/anon/authenticated/service_role matrix — all 7 table privileges + sequence + every function', async () => {
    const c = conn(); await c.connect();
    try {
      const ROLES = ['probe_public', 'anon', 'authenticated', 'service_role'];
      const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
      const SEQ_PRIVS = ['USAGE', 'SELECT', 'UPDATE'];
      const tPriv = async (role: string, tbl: string, priv: string) =>
        (await c.query(`SELECT has_table_privilege($1,$2,$3) p`, [role, `public.${tbl}`, priv])).rows[0].p;
      const sPriv = async (role: string, seq: string, priv: string) =>
        (await c.query(`SELECT has_sequence_privilege($1,$2,$3) p`, [role, `public.${seq}`, priv])).rows[0].p;
      const fPriv = async (role: string, fn: string) =>
        (await c.query(`SELECT has_function_privilege($1,$2,'EXECUTE') p`, [role, `public.${fn}`])).rows[0].p;
      // ── both tables: service_role gets ONLY SELECT; PUBLIC/anon/authenticated get NOTHING; nobody else writes ──
      for (const tbl of ['notification_orphan_reconcile_state', 'notification_orphan_reconcile_actions'])
        for (const role of ROLES) for (const p of TABLE_PRIVS) {
          const expected = role === 'service_role' && p === 'SELECT';
          expect(await tPriv(role, tbl, p), `${role} ${p} on ${tbl}`).toBe(expected);
        }
      // ── the audit IDENTITY sequence: NO grants to any API role (owner-only; the SECURITY DEFINER fns advance it) ──
      for (const role of ROLES) for (const p of SEQ_PRIVS)
        expect(await sPriv(role, 'notification_orphan_reconcile_actions_id_seq', p), `${role} ${p} on seq`).toBe(false);
      // ── functions: worker RPCs → service_role EXECUTE; everything else owner-only (nobody, incl. service_role) ──
      const SERVICE_EXEC = [
        'apply_notification_provider_event(uuid,text,text,uuid,text,timestamptz,timestamptz)',
        'reconcile_orphan_provider_events(uuid,text,timestamptz,int)',
        'record_email_event(text,text,text,text,text,text,uuid,uuid,uuid,timestamptz)',
        'is_email_suppressed(text)', 'reset_email_suppression(text)',
      ];
      const OWNER_ONLY = [
        'link_notification_provider_event(text,uuid,uuid,timestamptz)', 'link_notification_provider_event(text,uuid)',
        'notification_orphan_reconcile_requeue(text,text,text)', 'notification_orphan_reconcile_resolve(text,text,text)',
        'notification_orphan_reconcile_permanent_reason(text)', 'notification_orphan_reconcile_actions_immutable()',
        'email_state_transition(text,timestamptz,timestamptz,text,text,timestamptz)', 'email_event_rank(text)',
      ];
      for (const fn of SERVICE_EXEC) {
        expect(await fPriv('service_role', fn), `service_role EXECUTE ${fn}`).toBe(true);
        for (const role of ['probe_public', 'anon', 'authenticated']) expect(await fPriv(role, fn), `${role} EXECUTE ${fn}`).toBe(false);
      }
      for (const fn of OWNER_ONLY) for (const role of ROLES)
        expect(await fPriv(role, fn), `${role} EXECUTE ${fn}`).toBe(false);
    } finally { await c.end(); }
  });

  it('the audit log is owner-effectively append-only: UPDATE, DELETE, and TRUNCATE all raise as the OWNER', async () => {
    const c = conn(); await c.connect();
    try {
      const { g, run } = await toPreSend(c); await begin(c, run, g); await bindPm(c, g, 'pm-au');
      await apply(c, run, 'ev-au', 'pm-au2', g);                              // mismatch → quarantine
      await reconcile(c, await dispatchRun(c));
      await c.query(`SELECT public.notification_orphan_reconcile_resolve('ev-au','ops','ack')`);
      // as the table OWNER (grants don't restrain the owner — the triggers do):
      await expect(c.query(`UPDATE public.notification_orphan_reconcile_actions SET actor='forged'`)).rejects.toThrow(/append-only/i);
      await expect(c.query(`DELETE FROM public.notification_orphan_reconcile_actions`)).rejects.toThrow(/append-only/i);
      await expect(c.query(`TRUNCATE public.notification_orphan_reconcile_actions`)).rejects.toThrow(/append-only/i);
      expect((await c.query(`SELECT actor FROM public.notification_orphan_reconcile_actions WHERE resend_event_id='ev-au'`)).rows[0].actor).toBe('ops');
    } finally { await c.end(); }
  });
});
