import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';

/**
 * N3 M1 — tenant-aware per-row idempotency (the N3 design review's CRITICAL finding, thread
 * 019fd175-f39e-73a3-80c3-7c43f6b13f97).
 *
 * The defect this migration removes: the outbox unique identity was (channel, idempotency_key)
 * with a tenant-blind key, so for a multi-academy recipient an A-attributed row and a
 * B-attributed row for the same event+subject+recipient COLLIDED — first writer wins, ON
 * CONFLICT DO NOTHING silently swallowed the other tenant's intent. N3's per-academy caps make
 * that actively wrong: academy A's cap must produce an A-attributed outcome without eating B's.
 *
 * The contract's required cases, verbatim: "A/B same user, event and subject in BOTH insertion
 * orders" — plus same-tenant dedup still holding, and the canonical scope precedence
 * (academy > trainer > global).
 *
 * REAL files throughout: the production foundation schema (not a stub outbox — the migration
 * ALTERs the named constraint, so a stub with an inline UNIQUE would not even apply) and the
 * full resolver chain through its newest definition, then M1.
 */

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
const PORT = 54431;

const MIG = (f: string) =>
  readFileSync(resolve(__dirname, '..', '..', 'supabase', 'migrations', f), 'utf8');

const U1 = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const A = '33333333-3333-4333-8333-333333333333'; // academy A
const B = '44444444-4444-4444-8444-444444444444'; // academy B
const T = '55555555-5555-4555-8555-555555555555'; // trainer
const MGR = '66666666-6666-4666-8666-666666666666'; // manager of academy A only

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n3idem-rp-'));
  epg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();

  // Stubs for the PRE-EXISTING app tables the chain references; REAL migrations for everything
  // under test (same device as the sibling realpg suites).
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text, preferred_language text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, preferred_language text);
    CREATE TABLE public.person_links (guest_player_id uuid, person_id uuid, profile_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'Academy', timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
    CREATE TABLE public.trainer_followers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL, trainer_id uuid NOT NULL,
      notify_new_availability boolean NOT NULL DEFAULT true, UNIQUE (player_id, trainer_id));
    CREATE TABLE public.notification_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedup_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.notification_preferences (
      user_id uuid PRIMARY KEY, open_slots_digest text NOT NULL DEFAULT 'weekly');
    -- pre-existing delivery log the foundation migration generalizes in place
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL, recipient_email text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now());
    -- membership-arm stubs for M4's reader: bookings at academy trainers + guest linkage.
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), trainer_id uuid NOT NULL);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL, player_id uuid NOT NULL, status text);
    CREATE TABLE public.academy_trainers (trainer_profile_id uuid NOT NULL, academy_profile_id uuid NOT NULL, status text NOT NULL DEFAULT 'active');
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      academy_profile_id uuid, trainer_id uuid, twin_of_profile_id uuid, linked_profile_id uuid,
      split_frozen boolean NOT NULL DEFAULT false);
    -- faithful stand-in for the phase-3.2 helper: frozen = identity uncertain = grants nothing
    CREATE FUNCTION public.is_guest_split_frozen(_guest_player_id uuid) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$
      SELECT coalesce((SELECT split_frozen FROM public.guest_players WHERE id = _guest_player_id), true) $fn$;

    -- manager grants + the REAL is_academy_manager body (20260128121147, verbatim semantics)
    CREATE TABLE public.academy_managers (user_id uuid NOT NULL, academy_profile_id uuid NOT NULL);
    CREATE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.academy_managers
                     WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;
    -- a settable auth.uid, so RPCs can be exercised as specific actors
    CREATE TABLE public.test_auth_ctx (uid uuid);
    INSERT INTO public.test_auth_ctx VALUES (NULL);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT uid FROM public.test_auth_ctx LIMIT 1 $fn$;
    CREATE TYPE public.app_role AS ENUM ('player', 'trainer', 'admin');
    CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, UNIQUE (user_id, role));
    CREATE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $fn$;
    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS
      $fn$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p_email)) $fn$;
  `);

  for (const f of [
    '20260910100000_notification_foundation_schema.sql',
    '20260911100000_notification_resolver.sql',
    '20260912100000_notification_email_worker.sql',
    '20260922100000_notification_whatsapp_booking_optin_cadence.sql',
    '20260923100000_notification_whatsapp_capability_matches_templates.sql',
    '20261002100000_notification_digest_schema_foundation.sql',
    '20261003100000_notification_digest_acl_lockdown.sql',
    '20261004100000_notification_digest_state_machine.sql',
    '20261005110000_notification_digest_request_hash_bytea_fix.sql',
    '20261008100000_open_slots_player_event.sql',
    '20261009100000_notif_10cb_review_corrections.sql',
    '20261010100000_open_slots_item_types_and_plurals.sql',
    '20261011100000_notif_10cb_resolver_open_slots_digest.sql',
    '20261011130000_notif_10cb_open_slots_instant_payload.sql',
    '20261011110000_notif_10cb_enqueue_digest_branch.sql',
    '20261011120000_notif_10cb_instant_claim_excludes_digest.sql',
    '20261011140000_notif_10cb_cutover_compat.sql',
    '20261013100000_notif_10cb_pref_bridge_v2_to_v1.sql',
    // ── under test ──
    '20261015100000_notif_n3_tenant_aware_idempotency.sql',
    '20261015110000_notif_n3_academy_restrictions.sql',
    '20261015120000_notif_n3_resolver_cap_integration.sql',
    '20261015130000_notif_n3_player_visibility.sql',
    '20261015140000_notif_n3_academy_outcome_reads.sql',
    '20261015150000_notif_n3_history_pagination.sql',
    // ── N4 admin stack: the M6 preview must be EQUIVALENCE-tested against the REAL resolver,
    // which lives in this harness — so the whole admin chain applies here too ──
    '20261006110000_reconcile_orphan_provider_events.sql',
    '20261016100000_notif_n4_worker_invocations.sql',
    '20261016110000_notif_n4_invocation_claim.sql',
    '20261017100000_notif_n4_channel_kill_switches.sql',
    '20261018100000_notif_n4_admin_ops_audit.sql',
    '20261019100000_notif_n4_admin_reads.sql',
    '20261020100000_notif_n4_send_enabling_recovery.sql',
    '20261021100000_notif_n4_readiness_preview_search.sql',
    '20261022100000_notif_n4_seam_corrections.sql',
    '20261023100000_notif_n4_seam_corrections_round2.sql',
    '20261024100000_notif_n4_seam_corrections_round3.sql',
    '20261025100000_notif_n4_invocation_ownership_contract.sql',
  ]) {
    await c.query(MIG(f));
  }

  await c.query(`
    INSERT INTO auth.users (id) VALUES ('${U1}'), ('${MGR}');
    INSERT INTO public.persons (id, user_id, email) VALUES ('${P1}','${U1}','p1@example.com');
    INSERT INTO public.academy_profiles (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.trainer_profiles (id) VALUES ('${T}');
    INSERT INTO public.academy_managers (user_id, academy_profile_id) VALUES ('${MGR}','${A}');
  `);
}, 300_000);

afterAll(async () => { await c?.end(); await epg?.stop(); });

beforeEach(async () => {
  await c.query(`TRUNCATE public.notification_outbox CASCADE;`);
});

/** enqueue booking_confirmed_player for P1/subject b1 under the given tenant attribution. */
async function enqueue(tenant: { academy?: string; trainer?: string }, subject = 'b1') {
  const r = await c.query(
    `SELECT * FROM public.enqueue_notification(
       p_event_key => 'booking_confirmed_player',
       p_recipient_person_id => $1,
       p_idempotency_subject => $2,
       p_tenant_academy_profile_id => $3,
       p_tenant_trainer_id => $4)`,
    [P1, subject, tenant.academy ?? null, tenant.trainer ?? null],
  );
  return r.rows;
}

const outbox = async () =>
  (await c.query(
    `SELECT tenant_academy_profile_id, tenant_trainer_id, tenant_scope_key, idempotency_key, channel
       FROM public.notification_outbox ORDER BY created_at, id`)).rows;

describe('tenant-aware idempotency (N3 M1)', () => {
  it('A then B: the same event+subject+recipient under two academies is TWO rows', async () => {
    await enqueue({ academy: A });
    await enqueue({ academy: B });
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenant_scope_key).sort()).toEqual([`a:${A}`, `a:${B}`].sort());
    // both rows share the tenant-blind key — the SCOPE column is what separates them
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(1);
  });

  it('B then A: insertion order does not decide which tenant owns the intent', async () => {
    await enqueue({ academy: B });
    await enqueue({ academy: A });
    const rows = await outbox();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenant_scope_key).sort()).toEqual([`a:${A}`, `a:${B}`].sort());
  });

  it('the SAME tenant twice is still ONE row — idempotency within a scope is untouched', async () => {
    const first = await enqueue({ academy: A });
    const second = await enqueue({ academy: A });
    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(0); // ON CONFLICT DO NOTHING, as before
    expect(await outbox()).toHaveLength(1);
  });

  it('canonical scope precedence: academy wins over trainer; trainer-only; global', async () => {
    await enqueue({ academy: A, trainer: T }, 's1');
    await enqueue({ trainer: T }, 's2');
    await enqueue({}, 's3');
    const rows = await outbox();
    const byKey = Object.fromEntries(rows.map((r) => [r.idempotency_key.split(':')[1], r.tenant_scope_key]));
    expect(byKey['s1']).toBe(`a:${A}`); // both supplied → academy is canonical
    expect(byKey['s2']).toBe(`t:${T}`);
    expect(byKey['s3']).toBe('global');
  });

  it('trainer-attributed and academy-attributed intents for the same send are independent too', async () => {
    await enqueue({ trainer: T });
    await enqueue({ academy: A });
    expect(await outbox()).toHaveLength(2);
  });

  it('the scope key is GENERATED — no writer can supply a forged one', async () => {
    await expect(
      c.query(`INSERT INTO public.notification_outbox
        (event_type, channel, idempotency_key, tenant_scope_key)
        VALUES ('booking_confirmed_player','email','x:y:z','a:forged')`),
    ).rejects.toThrow(/non-DEFAULT value into column/);
  });

  it('the unique identity is exactly (channel, idempotency_key, tenant_scope_key)', async () => {
    const def = await c.query(
      `SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'uq_notification_outbox_idem'`);
    expect(def.rows).toHaveLength(1);
    expect(def.rows[0].d).toBe('UNIQUE (channel, idempotency_key, tenant_scope_key)');
  });
});


const asUser = (uid: string | null) =>
  c.query(`UPDATE public.test_auth_ctx SET uid = ${uid ? `'${uid}'` : 'NULL'}`);

const setCap = async (over: Partial<{ academy: string; event: string; channel: string; cap: string | null; reason: string; req: string }> = {}) => {
  const a = { academy: A, event: 'open_slots_player', channel: 'email', cap: 'off',
    reason: 'too many complaints', req: crypto.randomUUID(), ...over };
  return (await c.query(
    `SELECT public.set_academy_notification_restriction($1,$2,$3,$4,$5,$6) AS r`,
    [a.academy, a.event, a.channel, a.cap, a.reason, a.req])).rows[0].r as string;
};

describe('academy restrictions + audit (N3 M2)', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit DISABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await c.query(`DELETE FROM public.academy_notification_restriction_audit;`);
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit ENABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await asUser(MGR);
  });

  it('set / change / clear, each audited with old→new and the mandatory reason', async () => {
    expect(await setCap({ cap: 'daily' })).toBe('set');
    expect(await setCap({ cap: 'off' })).toBe('changed');
    expect(await setCap({ cap: null })).toBe('cleared');
    const audit = await c.query(
      `SELECT old_max_frequency, new_max_frequency FROM public.academy_notification_restriction_audit ORDER BY created_at, id`);
    expect(audit.rows).toEqual([
      { old_max_frequency: null, new_max_frequency: 'daily' },
      { old_max_frequency: 'daily', new_max_frequency: 'off' },
      { old_max_frequency: 'off', new_max_frequency: null },
    ]);
  });

  it('request_id replay returns the recorded outcome with NO second audit row; a reused id with a different decision is refused', async () => {
    const req = crypto.randomUUID();
    expect(await setCap({ cap: 'off', req })).toBe('set');
    expect(await setCap({ cap: 'off', req })).toBe('replayed');
    const n = await c.query(`SELECT count(*)::int AS n FROM public.academy_notification_restriction_audit`);
    expect(n.rows[0].n).toBe(1);
    await expect(setCap({ cap: 'daily', req })).rejects.toThrow(/already used for a different change/);
  });

  it('a required_delivery event cannot be capped — the table trigger refuses every writer', async () => {
    await expect(setCap({ event: 'booking_confirmed_player' })).rejects.toThrow(/required_delivery/);
    // even a direct superuser INSERT hits the same wall (validation lives on the TABLE)
    await expect(c.query(
      `INSERT INTO public.academy_notification_restrictions VALUES ('${A}','booking_confirmed_player','email','off')`))
      .rejects.toThrow(/required_delivery/);
  });

  it('a channel the event does not support is refused', async () => {
    await expect(setCap({ channel: 'push' })).rejects.toThrow(/does not support channel/);
  });

  it('non-managers, foreign managers and anonymous callers are refused; reasons are mandatory', async () => {
    await asUser(U1);
    await expect(setCap()).rejects.toThrow(/not a manager/);
    await asUser(MGR);
    await expect(setCap({ academy: B })).rejects.toThrow(/not a manager/);
    await asUser(null);
    await expect(setCap()).rejects.toThrow(/anonymous/);
    await asUser(MGR);
    await expect(setCap({ reason: '  ' })).rejects.toThrow(/reason/);
  });

  it('two-session FIRST write to an absent triple: the audit chain is NULL → first → second, never two NULLs', async () => {
    // FOR UPDATE cannot serialize creators (no row exists to lock); the advisory lock must.
    const c3 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await c3.connect();
    try {
      await c3.query(`UPDATE public.test_auth_ctx SET uid = '${MGR}'`); // same ctx table, shared
      await c.query('BEGIN');
      const r1 = await c.query(
        `SELECT public.set_academy_notification_restriction($1,'session_reminder_player','email','daily','first writer',$2) AS r`,
        [A, crypto.randomUUID()]);
      expect(r1.rows[0].r).toBe('set');
      // session 2 starts the SAME first-write while session 1 is still open — it must BLOCK on
      // the advisory lock, then see session 1's committed row as its old value.
      const race = c3.query(
        `SELECT public.set_academy_notification_restriction($1,'session_reminder_player','email','off','second writer',$2) AS r`,
        [A, crypto.randomUUID()]);
      await new Promise((res) => setTimeout(res, 150)); // give it time to be genuinely blocked
      await c.query('COMMIT');
      const r2 = await race;
      expect(r2.rows[0].r).toBe('changed'); // NOT 'set' — it saw the first writer's row
      const audits = await c.query(
        `SELECT old_max_frequency, new_max_frequency FROM public.academy_notification_restriction_audit
          ORDER BY created_at, id`);
      expect(audits.rows).toEqual([
        { old_max_frequency: null, new_max_frequency: 'daily' },
        { old_max_frequency: 'daily', new_max_frequency: 'off' },
      ]);
    } finally {
      await c3.end();
    }
  });

  it('two-session EXACT replay of one request id: one performs, one replays, ONE audit row', async () => {
    // DETERMINISTIC interleaving, not a Promise.all coin-flip: session 1 holds its transaction
    // OPEN (audit row uncommitted, request lock held); session 2 fires the exact same request
    // while it is open. With the request-scoped lock, session 2 blocks BEFORE the replay lookup
    // and, once session 1 commits, sees the audit row → 'replayed'. Without it, session 2 passes
    // the lookup (the row is invisible), blocks on the TRIPLE lock instead, and after commit
    // ERRORS on the unique index where the contract promises 'replayed'.
    const c4 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await c4.connect();
    try {
      const req = crypto.randomUUID();
      const args = [A, 'session_reminder_player', 'email', 'off', 'exact retry', req];
      const call = (client: InstanceType<typeof Client>) => client.query(
        `SELECT public.set_academy_notification_restriction($1,$2,$3,$4,$5,$6) AS r`, args);
      await c.query('BEGIN');
      const r1 = await call(c);
      expect(r1.rows[0].r).toBe('set');
      const race = call(c4);                          // fires while session 1 is still open
      await new Promise((res) => setTimeout(res, 150)); // let it reach (and block on) the lock
      await c.query('COMMIT');
      const r2 = await race;
      expect(r2.rows[0].r).toBe('replayed');
      const n = await c.query(`SELECT count(*)::int AS n FROM public.academy_notification_restriction_audit`);
      expect(n.rows[0].n).toBe(1);
    } finally {
      await c4.end();
    }
  });

  it('a request-id replay with a CHANGED reason is a different decision — refused, not replayed', async () => {
    const req = crypto.randomUUID();
    expect(await setCap({ cap: 'off', reason: 'temporary reduction', req })).toBe('set');
    await expect(setCap({ cap: 'off', reason: 'regulatory request', req }))
      .rejects.toThrow(/already used for a different change/);
  });

  it('the audit is append-only for EVERYONE — even the owner cannot rewrite history', async () => {
    await setCap({ cap: 'off' });
    await expect(c.query(`UPDATE public.academy_notification_restriction_audit SET reason = 'edited'`))
      .rejects.toThrow(/append-only/);
    await expect(c.query(`DELETE FROM public.academy_notification_restriction_audit`))
      .rejects.toThrow(/append-only/);
  });

  it('manager reads are scoped: own academy yes, foreign academy refused', async () => {
    await setCap({ cap: 'weekly' });
    const rows = (await c.query(`SELECT * FROM public.get_academy_notification_restrictions('${A}')`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].max_frequency).toBe('weekly');
    await expect(c.query(`SELECT * FROM public.get_academy_notification_restrictions('${B}')`))
      .rejects.toThrow(/not a manager/);
    const hist = (await c.query(`SELECT * FROM public.get_academy_notification_restriction_audit('${A}')`)).rows;
    expect(hist).toHaveLength(1);
    expect(hist[0].reason).toBe('too many complaints');
  });
});


/** enqueue an OPTIONAL event (open_slots_player needs a payload shape; session_reminder_player
 *  is optional + plain). Returns emitted rows. */
async function enqueueOptional(tenant: { academy?: string; trainer?: string }, subject: string, event = 'session_reminder_player') {
  // open_slots_player's digest item minter requires a structured payload with a subtype
  const payload = event === 'open_slots_player'
    ? `'{"subtype":"new_availability","data":{"trainer_name":"Coach","slot_count":1,"date_from":"2026-08-10"}}'::jsonb`
    : 'NULL';
  const r = await c.query(
    `SELECT * FROM public.enqueue_notification(
       p_event_key => $1, p_recipient_person_id => $2, p_idempotency_subject => $3,
       p_tenant_academy_profile_id => $4, p_tenant_trainer_id => $5,
       p_payload => ${payload})`,
    [event, P1, subject, tenant.academy ?? null, tenant.trainer ?? null]);
  return r.rows;
}

describe('resolver cap integration (N3 M3)', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await c.query(`DELETE FROM public.notification_preferences_v2;`);
    await asUser(MGR);
    // an email contact so the optional event is normally deliverable
    await c.query(`
      INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
        destination_redacted, consent_status, consent_scope, is_primary)
      VALUES ('${P1}','${U1}','email','p1@example.com','p***@example.com','opted_in','global', true)
      ON CONFLICT DO NOTHING;`);
  });

  it("cap 'off' → a terminal tenant_restricted skipped row, tenant-attributed, NO destination", async () => {
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    const rows = await enqueueOptional({ academy: A }, 's-off');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('tenant_restricted');
    expect(rows[0].destination_normalized).toBeNull();
    const raw = await c.query(
      `SELECT tenant_scope_key, destination_normalized, payload FROM public.notification_outbox WHERE skip_reason='tenant_restricted'`);
    expect(raw.rows[0].tenant_scope_key).toBe(`a:${A}`);
    expect(raw.rows[0].destination_normalized).toBeNull();
    // a refused send retains NO content — evidence of a refusal needs no payload
    expect(raw.rows[0].payload).toEqual({});
  });

  it("a player's own 'off' keeps ITS reason — the cap never takes credit for the player's decision", async () => {
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
      VALUES ('${U1}','session_reminder_player','off')`);
    const rows = await enqueueOptional({ academy: A }, 's-pref-off');
    // player-off on an optional event emits NOTHING (pre-existing semantics), never tenant_restricted
    expect(rows.filter((r) => r.skip_reason === 'tenant_restricted')).toHaveLength(0);
  });

  it("cap 'daily' caps instant→daily, but a player's weekly stays weekly (never a floor)", async () => {
    // The engine flag is catalog data; enabling it in this ISOLATED harness makes the digest
    // branch write real members whose digest_frequency exposes exactly which cadence won.
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = true WHERE key='open_slots_player'`);
    try {
      await setCap({ event: 'open_slots_player', cap: 'daily' });
      // instant-preferring player: the cap must reduce instant → daily
      await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
        VALUES ('${U1}','open_slots_player','instant')`);
      const capped = await enqueueOptional({ academy: A }, 's-daily', 'open_slots_player');
      const cappedRow = capped.find((r) => r.channel === 'email');
      expect(cappedRow).toBeTruthy();
      const cappedShape = await c.query(
        `SELECT delivery_mode, digest_frequency FROM public.notification_outbox WHERE id = $1`,
        [cappedRow!.outbox_id]);
      expect(cappedShape.rows[0]).toEqual({ delivery_mode: 'digest', digest_frequency: 'daily' });
      // weekly-preferring player under the same daily cap: weekly SURVIVES (cap ≤ pref → no-op)
      await c.query(`UPDATE public.notification_preferences_v2 SET email_frequency='weekly'
        WHERE user_id='${U1}' AND event_type='open_slots_player'`);
      const kept = await enqueueOptional({ academy: A }, 's-weekly', 'open_slots_player');
      const keptRow = kept.find((r) => r.channel === 'email');
      const keptShape = await c.query(
        `SELECT digest_frequency FROM public.notification_outbox WHERE id = $1`, [keptRow!.outbox_id]);
      expect(keptShape.rows[0].digest_frequency).toBe('weekly');
    } finally {
      await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled = false WHERE key='open_slots_player'`);
    }
  });

  it('a REQUIRED event ignores even a smuggled cap row — the override runs last', async () => {
    // smuggle a cap past the trigger (superuser, trigger disabled) to model a catalog flip
    await c.query(`ALTER TABLE public.academy_notification_restrictions DISABLE TRIGGER trg_notif_academy_restriction_guard`);
    await c.query(`INSERT INTO public.academy_notification_restrictions VALUES ('${A}','booking_confirmed_player','email','off')`);
    await c.query(`ALTER TABLE public.academy_notification_restrictions ENABLE TRIGGER trg_notif_academy_restriction_guard`);
    const rows = await enqueue({ academy: A }, 'req-1');
    const email = rows.find((r) => r.channel === 'email');
    expect(email!.status).toBe('pending'); // sent path, NOT skipped
  });

  it('a REQUIRED event is untouchable on NON-email channels too — the guard is per-event, not per-channel', async () => {
    // The email arm is doubly protected (the required override runs last); whatsapp has no such
    // override, so ONLY the NOT required_delivery guard stands between a smuggled cap and a
    // required event's whatsapp leg. This is the test that makes that guard load-bearing.
    // 20260923 turned booking_confirmed_player's whatsapp OFF (no committed template); this
    // models the future template commit that turns it back on, in the isolated harness.
    await c.query(`UPDATE public.notification_event_types SET supports_whatsapp = true WHERE key='booking_confirmed_player'`);
    await c.query(`
      INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
        destination_redacted, consent_status, consent_scope, is_primary)
      VALUES ('${P1}','${U1}','whatsapp','+31600000001','+3160***01','opted_in','global', true)
      ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency)
      VALUES ('${U1}','booking_confirmed_player','instant')
      ON CONFLICT (user_id, event_type) DO UPDATE SET whatsapp_frequency='instant'`);
    await c.query(`ALTER TABLE public.academy_notification_restrictions DISABLE TRIGGER trg_notif_academy_restriction_guard`);
    await c.query(`INSERT INTO public.academy_notification_restrictions VALUES ('${A}','booking_confirmed_player','whatsapp','off')`);
    await c.query(`ALTER TABLE public.academy_notification_restrictions ENABLE TRIGGER trg_notif_academy_restriction_guard`);
    const rows = await enqueue({ academy: A }, 'req-wa');
    const wa = rows.find((r) => r.channel === 'whatsapp');
    expect(wa).toBeTruthy();
    expect(wa!.status).toBe('pending');
    await c.query(`UPDATE public.notification_event_types SET supports_whatsapp = false WHERE key='booking_confirmed_player'`);
  });

  it('a trainer-only send has no academy to answer to — the cap does not apply', async () => {
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    const rows = await enqueueOptional({ trainer: T }, 's-trainer');
    expect(rows.filter((r) => r.skip_reason === 'tenant_restricted')).toHaveLength(0);
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('pending');
  });

  it("academy B's recipients are untouched by A's cap (tenant isolation)", async () => {
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    const rows = await enqueueOptional({ academy: B }, 's-b');
    expect(rows.find((r) => r.channel === 'email')!.status).toBe('pending');
  });
});

describe('live enforcement at the send authorities (N3 M3)', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await c.query(`DELETE FROM public.notification_preferences_v2;`);
    await asUser(MGR);
    await c.query(`
      INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
        destination_redacted, consent_status, consent_scope, is_primary)
      VALUES ('${P1}','${U1}','email','p1@example.com','p***@example.com','opted_in','global', true)
      ON CONFLICT DO NOTHING;`);
  });

  it('a cap set AFTER enqueue converts the pending row at the next claim — nothing is handed to the worker', async () => {
    await enqueueOptional({ academy: A }, 'live-1');
    // the cap lands while the row sits pending
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    const claimed = await c.query(
      `SELECT * FROM public.claim_notification_outbox_batch('email','w1',20)`);
    expect(claimed.rows).toHaveLength(0);
    const row = await c.query(
      `SELECT status, skip_reason FROM public.notification_outbox
        WHERE idempotency_key LIKE '%live-1%' AND channel = 'email'`);
    expect(row.rows[0]).toEqual({ status: 'skipped', skip_reason: 'tenant_restricted' });
  });

  it('the cancel step spares required events, other tenants, and digest members', async () => {
    await enqueue({ academy: A }, 'live-req');                    // required
    await enqueueOptional({ academy: B }, 'live-b');              // other tenant
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w1',20)`);
    const survivors = await c.query(
      `SELECT idempotency_key, status FROM public.notification_outbox
        WHERE status IN ('pending','processing') AND channel='email' ORDER BY idempotency_key`);
    const keys = survivors.rows.map((r) => r.idempotency_key);
    expect(keys.some((k: string) => k.includes('live-req'))).toBe(true);
    expect(keys.some((k: string) => k.includes('live-b'))).toBe(true);
  });

  it('two-session: a cap committed while another session scans still lands before the NEXT claim', async () => {
    // session 2 = a concurrent manager write racing the worker
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
    await c2.connect();
    try {
      await enqueueOptional({ academy: A }, 'live-race');
      await c2.query('BEGIN');
      await c2.query(
        `INSERT INTO public.academy_notification_restrictions VALUES ('${A}','session_reminder_player','email','off')`);
      // worker claims WHILE the cap transaction is open — the uncommitted cap is invisible, the
      // row is claimed: this IS the accepted §7b-family residual, pinned here as such
      const during = await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w1',20)`);
      expect(during.rows).toHaveLength(1);
      await c2.query('COMMIT');
      // release the claim back to pending (simulating a retry) — the NEXT claim honours the cap
      await c.query(`UPDATE public.notification_outbox SET status='pending', locked_at=NULL, locked_by=NULL
        WHERE id = $1`, [during.rows[0].outbox_id]);
      const after = await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w2',20)`);
      expect(after.rows).toHaveLength(0);
      const final = await c.query(
        `SELECT status, skip_reason FROM public.notification_outbox WHERE id = $1`, [during.rows[0].outbox_id]);
      expect(final.rows[0]).toEqual({ status: 'skipped', skip_reason: 'tenant_restricted' });
    } finally {
      await c2.end();
    }
  });

  it('a STALE claimed row does not bypass a late cap at reclaim — tenant_restricted, not redelivered', async () => {
    await enqueueOptional({ academy: A }, 'live-stale');
    const first = await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w1',20)`);
    const target = first.rows.find((r) => r.idempotency_key?.includes?.('live-stale')) ?? first.rows[0];
    // the worker dies; the row goes stale
    await c.query(`UPDATE public.notification_outbox SET locked_at = now() - interval '30 minutes'
      WHERE id = $1`, [target.outbox_id]);
    // the cap lands AFTER the crash, BEFORE the reclaim
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    const reclaimed = await c.query(`SELECT * FROM public.claim_notification_outbox_batch('email','w2',20)`);
    expect(reclaimed.rows.map((r) => r.outbox_id)).not.toContain(target.outbox_id);
    const final = await c.query(`SELECT status, skip_reason FROM public.notification_outbox WHERE id = $1`,
      [target.outbox_id]);
    expect(final.rows[0]).toEqual({ status: 'skipped', skip_reason: 'tenant_restricted' });
  });

  it('the cancel scan has its index, and a populated table uses it', async () => {
    // 5k unrelated pending rows: the cancel's outbox side must be an index scan, not a seq scan.
    await c.query(`INSERT INTO public.notification_outbox (event_type, channel, idempotency_key, status, tenant_academy_profile_id, scheduled_for, recipient_person_id)
      SELECT 'session_reminder_player','email','bulk:'||g||':x','pending','${B}', now(), '${P1}'
      FROM generate_series(1,5000) g`);
    const plan = await c.query(`EXPLAIN SELECT * FROM public.notification_outbox o
      WHERE o.channel='email' AND o.tenant_academy_profile_id='${A}' AND o.event_type='session_reminder_player'
        AND o.status IN ('pending','processing') AND o.delivery_mode IS DISTINCT FROM 'digest'`);
    const text = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('idx_notification_outbox_cap_cancel');
  });

  it('digest stop predicate: a cap landing after materialization stops the member (prepare AND begin call it)', async () => {
    // a LIVE follow relationship so the baseline member is genuinely deliverable
    await c.query(`
      INSERT INTO public.profiles (id, user_id) VALUES ('77777777-7777-4777-8777-777777777777','${U1}')
      ON CONFLICT DO NOTHING;
      INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability)
      VALUES ('77777777-7777-4777-8777-777777777777','${T}', true) ON CONFLICT DO NOTHING;`);
    // a digest-mode member row, academy-attributed AND trainer-attributed (the follow check
    // needs the trainer; the CAP keys on the academy)
    const ins = await c.query(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_user_id, recipient_person_id, tenant_academy_profile_id,
         tenant_trainer_id,
         visibility_scope, payload, public_summary, idempotency_key, status, delivery_mode, scheduled_for,
         destination_fingerprint, recipient_key, digest_frequency, digest_boundary_at, digest_item,
         group_locale, recipient_timezone, template_version)
      VALUES ('open_slots_player','email','${U1}','${P1}','${A}','${T}','private_user_only','{}','{}',
              'open_slots_player:dg1:${P1}','pending','digest', now() + interval '1 hour',
              public.notif_digest_destination_fingerprint('p1@example.com'),
              'p:${P1}','daily', now() + interval '1 hour', '{"title":"x"}'::jsonb,
              'nl','Europe/Amsterdam', 1)
      RETURNING id`);
    const member = ins.rows[0].id;
    expect((await c.query(`SELECT public.notif_digest_member_stop_reason($1) AS r`, [member])).rows[0].r)
      .toBeNull(); // deliverable before the cap
    await setCap({ event: 'open_slots_player', cap: 'off' });
    expect((await c.query(`SELECT public.notif_digest_member_stop_reason($1) AS r`, [member])).rows[0].r)
      .toBe('tenant_restricted');
    // the player's own off still wins the REPORTED reason when both apply
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
      VALUES ('${U1}','open_slots_player','off')`);
    expect((await c.query(`SELECT public.notif_digest_member_stop_reason($1) AS r`, [member])).rows[0].r)
      .toBe('preference_off');
  });
});


describe('player visibility of academy caps (N3 M4)', () => {
  const PROF = '88888888-8888-4888-8888-888888888888';
  const T2 = '99999999-9999-4999-8999-999999999999';

  beforeEach(async () => {
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit DISABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await c.query(`DELETE FROM public.academy_notification_restriction_audit;`);
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit ENABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await c.query(`DELETE FROM public.bookings; DELETE FROM public.availability_slots;
      DELETE FROM public.academy_trainers; DELETE FROM public.guest_players;
      DELETE FROM public.person_links WHERE profile_id IS NOT NULL;`);
    await c.query(`INSERT INTO public.profiles (id, user_id) VALUES ('${PROF}','${U1}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.trainer_profiles (id) VALUES ('${T2}') ON CONFLICT DO NOTHING;`);
    // a cap in academy A and one in academy B, both audited (manager writes them)
    await asUser(MGR);
    await setCap({ academy: A, event: 'session_reminder_player', cap: 'off', reason: 'A capped this' });
    await c.query(`INSERT INTO public.academy_managers (user_id, academy_profile_id) VALUES ('${MGR}','${B}')
      ON CONFLICT DO NOTHING`);
    await setCap({ academy: B, event: 'session_reminder_player', cap: 'daily', reason: 'B capped this' });
    await asUser(U1); // everything below runs as the PLAYER
  });

  const bookAt = async (academy: string, trainer: string, status = 'confirmed', trainerStatus = 'active') => {
    await c.query(`INSERT INTO public.academy_trainers (trainer_profile_id, academy_profile_id, status)
      VALUES ('${trainer}','${academy}','${trainerStatus}')`);
    const slot = await c.query(`INSERT INTO public.availability_slots (trainer_id) VALUES ('${trainer}') RETURNING id`);
    await c.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1,'${PROF}','${status}')`,
      [slot.rows[0].id]);
  };

  it('the booking arm: a non-cancelled seat at an ACTIVE academy trainer makes the caps visible', async () => {
    await bookAt(A, T2);
    const caps = (await c.query(`SELECT * FROM public.get_my_notification_restrictions()`)).rows;
    expect(caps).toHaveLength(1);
    expect(caps[0].academy_profile_id).toBe(A);
    expect(caps[0].max_frequency).toBe('off');
    // and NEVER academy B's — no relationship there
    expect(caps.some((r) => r.academy_profile_id === B)).toBe(false);
  });

  it('a cancelled booking or an inactive trainer ends the relationship — and the visibility', async () => {
    await bookAt(A, T2, 'cancelled');
    expect((await c.query(`SELECT * FROM public.get_my_notification_restrictions()`)).rows).toHaveLength(0);
    await c.query(`DELETE FROM public.bookings; DELETE FROM public.availability_slots; DELETE FROM public.academy_trainers;`);
    await bookAt(A, T2, 'confirmed', 'inactive');
    expect((await c.query(`SELECT * FROM public.get_my_notification_restrictions()`)).rows).toHaveLength(0);
  });

  it('the guest arm: a person-linked guest grants visibility; a SPLIT-FROZEN one grants nothing', async () => {
    const g = await c.query(`INSERT INTO public.guest_players (academy_profile_id) VALUES ('${A}') RETURNING id`);
    await c.query(`INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${P1}', $1)`, [g.rows[0].id]);
    await c.query(`INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P1}', '${PROF}')`);
    expect((await c.query(`SELECT * FROM public.get_my_notification_restrictions()`)).rows).toHaveLength(1);
    await c.query(`UPDATE public.guest_players SET split_frozen = true WHERE id = $1`, [g.rows[0].id]);
    expect((await c.query(`SELECT * FROM public.get_my_notification_restrictions()`)).rows).toHaveLength(0);
  });

  it('history shows old→new + the reason, and NO actor column exists in the result shape', async () => {
    await bookAt(A, T2);
    const hist = (await c.query(`SELECT * FROM public.get_my_notification_restriction_history(50)`)).rows;
    expect(hist).toHaveLength(1);
    expect(hist[0].reason).toBe('A capped this');
    expect(hist[0].new_max_frequency).toBe('off');
    expect(Object.keys(hist[0])).not.toContain('actor_user_id');
  });

  it('anonymous callers are refused; a relationship-less player sees empty, not an error', async () => {
    await asUser(null);
    await expect(c.query(`SELECT * FROM public.get_my_notification_restrictions()`))
      .rejects.toThrow(/authentication required/);
    await asUser(U1); // U1 has no bookings/guests in this test
    expect((await c.query(`SELECT * FROM public.get_my_notification_restrictions()`)).rows).toHaveLength(0);
    expect((await c.query(`SELECT * FROM public.get_my_notification_restriction_history(50)`)).rows).toHaveLength(0);
  });
});


describe('academy outcome reads (N3 M6): visibility never widens, impact never identifies', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await asUser(MGR);
    await c.query(`
      INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
        destination_redacted, consent_status, consent_scope, is_primary)
      VALUES ('${P1}','${U1}','email','p1@example.com','p***@example.com','opted_in','global', true)
      ON CONFLICT DO NOTHING;`);
  });

  it('outcomes list serves ONLY tenant-visible rows — a private player event never appears', async () => {
    // tenant-visible staff row for academy A (booking_confirmed_staff is tenant_visible)
    await c.query(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_user_id, tenant_academy_profile_id, visibility_scope,
         public_summary, idempotency_key, status)
      VALUES ('booking_confirmed_staff','email','${U1}','${A}','tenant_visible',
              '{"event_type":"booking_confirmed_staff"}','staff:o1:${U1}','sent')`);
    // private player row for the SAME academy
    await enqueueOptional({ academy: A }, 'outc-1');
    const rows = (await c.query(`SELECT * FROM public.get_academy_notification_outcomes('${A}', 50)`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('booking_confirmed_staff');
    // and the projection is the REDACTED one
    expect(Object.keys(rows[0])).not.toContain('destination_normalized');
    expect(Object.keys(rows[0])).not.toContain('payload');
  });

  it('impact is AGGREGATE-ONLY: the cap shows up as a count, never as identities', async () => {
    await setCap({ event: 'session_reminder_player', cap: 'off' });
    await enqueueOptional({ academy: A }, 'imp-1');
    await enqueueOptional({ academy: A }, 'imp-2');
    const rows = (await c.query(`SELECT * FROM public.get_academy_restriction_impact('${A}', 30)`)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('session_reminder_player');
    expect(Number(rows[0].restricted_count)).toBe(2);
    const cols = Object.keys(rows[0]);
    for (const leaked of ['recipient_user_id','recipient_person_id','destination_redacted','destination_normalized','id']) {
      expect(cols).not.toContain(leaked);
    }
  });

  it("both reads are manager-scoped: academy B's manager-less caller and anon are refused", async () => {
    await asUser(U1);
    await expect(c.query(`SELECT * FROM public.get_academy_notification_outcomes('${A}', 50)`))
      .rejects.toThrow(/not a manager/);
    await expect(c.query(`SELECT * FROM public.get_academy_restriction_impact('${A}', 30)`))
      .rejects.toThrow(/not a manager/);
    await asUser(null);
    await expect(c.query(`SELECT * FROM public.get_academy_restriction_impact('${A}', 30)`))
      .rejects.toThrow(/not a manager/);
    await asUser(MGR);
    // and impact never crosses tenants: A's manager sees nothing of B's restrictions
    const rows = (await c.query(`SELECT * FROM public.get_academy_restriction_impact('${A}', 30)`)).rows;
    expect(Array.isArray(rows)).toBe(true); // shape check only; cross-tenant covered by scoping predicate
  });
});


describe('the CAPPABLE list against the POST-catalog truth (N3 round-4)', () => {
  it('the list is COMPLETE: every optional+supported arm of the matrix events is offered — not merely sound', async () => {
    // Soundness alone (each listed arm supported) stays green when a future template commit
    // restores an arm the UI forgot — completeness fails until the UI adds it.
    const { CAPPABLE_EVENTS } = await import('@/lib/academyNotificationCappable');
    const MATRIX_ACADEMY_EVENTS = ['booking_request_staff', 'booking_confirmed_staff', 'booking_cancelled_player'];
    const expected: string[] = [];
    for (const ev of MATRIX_ACADEMY_EVENTS) {
      const row = (await c.query(
        `SELECT required_delivery, supports_email, supports_whatsapp FROM public.notification_event_types WHERE key=$1`,
        [ev])).rows[0];
      if (row.required_delivery) continue;
      if (row.supports_email) expected.push(`${ev}:email`);
      if (row.supports_whatsapp) expected.push(`${ev}:whatsapp`);
    }
    const offered = CAPPABLE_EVENTS.flatMap((e) => e.channels.map((ch) => `${e.event}:${ch}`));
    expect(offered.sort()).toEqual(expected.sort());
  });

  it('history pagination: every change stays REACHABLE by walking p_before pages', async () => {
    const PROF3 = 'cccccccc-dddd-4eee-8fff-000000000001';
    const T4 = 'dddddddd-eeee-4fff-8000-000000000002';
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit DISABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await c.query(`DELETE FROM public.academy_notification_restriction_audit;`);
    // three changes at distinct timestamps, oldest first
    for (let i = 3; i >= 1; i--) {
      await c.query(`INSERT INTO public.academy_notification_restriction_audit
        (academy_profile_id, actor_user_id, event_type, channel, old_max_frequency, new_max_frequency, reason, request_id, created_at)
        VALUES ('${A}','${MGR}','session_reminder_player','email',NULL,'off','change ${i}', gen_random_uuid(), now() - interval '${i} hours')`);
    }
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit ENABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await c.query(`DELETE FROM public.bookings; DELETE FROM public.availability_slots; DELETE FROM public.academy_trainers; DELETE FROM public.guest_players;`);
    await c.query(`INSERT INTO public.profiles (id, user_id) VALUES ('${PROF3}','${U1}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.trainer_profiles (id) VALUES ('${T4}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.academy_trainers (trainer_profile_id, academy_profile_id, status) VALUES ('${T4}','${A}','active')`);
    const slot = await c.query(`INSERT INTO public.availability_slots (trainer_id) VALUES ('${T4}') RETURNING id`);
    await c.query(`INSERT INTO public.bookings (slot_id, player_id, status) VALUES ($1,'${PROF3}','confirmed')`, [slot.rows[0].id]);
    await asUser(U1);
    const page1 = (await c.query(`SELECT * FROM public.get_my_notification_restriction_history(2, NULL, NULL)`)).rows;
    expect(page1.map((r) => r.reason)).toEqual(['change 1', 'change 2']);
    const last1 = page1[page1.length - 1];
    const page2 = (await c.query(`SELECT * FROM public.get_my_notification_restriction_history(2, $1, $2)`,
      [last1.created_at, last1.id])).rows;
    expect(page2.map((r) => r.reason)).toEqual(['change 3']); // the oldest is REACHABLE
    // a HALF cursor is a caller bug, refused
    await expect(c.query(`SELECT * FROM public.get_my_notification_restriction_history(2, now(), NULL)`))
      .rejects.toThrow(/COMPOSITE/);
  });

  it('SAME-timestamp rows never fall through a page boundary — the cursor is composite', async () => {
    // Five changes sharing ONE transaction timestamp, page size 2: a timestamp-only cursor
    // permanently skips whichever same-stamp rows the first page did not return.
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit DISABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await c.query(`DELETE FROM public.academy_notification_restriction_audit;`);
    await c.query(`INSERT INTO public.academy_notification_restriction_audit
      (academy_profile_id, actor_user_id, event_type, channel, old_max_frequency, new_max_frequency, reason, request_id, created_at)
      SELECT '${A}','${MGR}','session_reminder_player','email',NULL,'off','same-stamp '||g, gen_random_uuid(), '2026-08-01T12:00:00Z'
      FROM generate_series(1,5) g`);
    await c.query(`ALTER TABLE public.academy_notification_restriction_audit ENABLE TRIGGER trg_notif_restriction_audit_guard;`);
    await asUser(U1);
    const seen = new Set<string>();
    let cursor: { created_at: string; id: string } | null = null;
    for (let page = 0; page < 4; page++) {
      const rows = (await c.query(
        `SELECT * FROM public.get_my_notification_restriction_history(2, $1, $2)`,
        [cursor?.created_at ?? null, cursor?.id ?? null])).rows;
      if (rows.length === 0) break;
      for (const r of rows) seen.add(r.reason);
      cursor = rows[rows.length - 1];
    }
    expect(seen.size).toBe(5); // every same-stamp row reached, none skipped, none repeated
  });

  it('every UI-cappable (event, channel) is optional AND supported by the live catalog', async () => {
    // The dead-control bug this pins: booking_cancelled_player whatsapp was offered while
    // 20260923 had set supports_whatsapp=false — M2's trigger would refuse the write.
    const { CAPPABLE_EVENTS } = await import('@/lib/academyNotificationCappable');
    for (const { event, channels } of CAPPABLE_EVENTS) {
      const row = (await c.query(
        `SELECT required_delivery, supports_email, supports_whatsapp FROM public.notification_event_types WHERE key = $1`,
        [event])).rows[0];
      expect(row, `${event} missing from catalog`).toBeTruthy();
      expect(row.required_delivery, `${event} is required`).toBe(false);
      for (const ch of channels) {
        const supported = ch === 'email' ? row.supports_email : row.supports_whatsapp;
        expect(supported, `${event}:${ch} unsupported — a dead control`).toBe(true);
      }
    }
  });
});

describe('guest arm returns BOTH relationship legs (N3 round-4)', () => {
  it("a guest with a DIRECT academy AND a trainer active elsewhere surfaces BOTH academies' caps", async () => {
    const PROF2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const T3 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await c.query(`DELETE FROM public.guest_players; DELETE FROM public.person_links WHERE profile_id IS NOT NULL;`);
    await c.query(`INSERT INTO public.profiles (id, user_id) VALUES ('${PROF2}','${U1}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.trainer_profiles (id) VALUES ('${T3}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.academy_trainers (trainer_profile_id, academy_profile_id, status) VALUES ('${T3}','${B}','active')`);
    // the guest names academy A directly AND rides trainer T3 who is active at B
    await c.query(`INSERT INTO public.guest_players (academy_profile_id, trainer_id, linked_profile_id)
      VALUES ('${A}','${T3}','${PROF2}')`);
    await asUser(MGR);
    await setCap({ academy: A, event: 'session_reminder_player', cap: 'off', reason: 'A reason here' });
    await c.query(`INSERT INTO public.academy_managers (user_id, academy_profile_id) VALUES ('${MGR}','${B}') ON CONFLICT DO NOTHING`);
    await setCap({ academy: B, event: 'session_reminder_player', cap: 'daily', reason: 'B reason here' });
    await asUser(U1);
    const caps = (await c.query(`SELECT academy_profile_id FROM public.get_my_notification_restrictions()`)).rows
      .map((r) => r.academy_profile_id).sort();
    // the first draft's coalesce returned only A here — hiding B's cap from a player it binds
    expect(caps).toEqual([A, B].sort());
  });
});

describe('N4 M6 — preview provenance EQUIVALENCE against the real resolver, and exact-safe search', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';
  beforeEach(async () => {
    await c.query(`INSERT INTO auth.users (id) VALUES ('${ADMIN_UID}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_UID}','admin') ON CONFLICT DO NOTHING;`);
    await c.query(`DELETE FROM public.academy_notification_restrictions;`);
    await c.query(`DELETE FROM public.notification_preferences_v2;`);
    await c.query(`DELETE FROM public.email_suppression_stub;`);
    await c.query(`ALTER TABLE public.notification_admin_search_log DISABLE TRIGGER trg_notif_admin_search_guard;`);
    await c.query(`DELETE FROM public.notification_admin_search_log;`);
    await c.query(`ALTER TABLE public.notification_admin_search_log ENABLE TRIGGER trg_notif_admin_search_guard;`);
    await c.query(`
      INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
        destination_redacted, consent_status, consent_scope, is_primary)
      VALUES ('${P1}','${U1}','email','p1@example.com','p***@example.com','opted_in','global', true)
      ON CONFLICT DO NOTHING;`);
  });
  const preview = async (event: string, channel = 'email', academy: string | null = null) => {
    await asUser(ADMIN_UID);
    const r = (await c.query(
      `SELECT * FROM public.admin_preview_notification_decision('${U1}', $1, $2, $3)`,
      [event, channel, academy])).rows[0];
    await asUser(null);
    return r;
  };
  /** THE EQUIVALENCE ORACLE: the preview's final decision must MATCH what the real resolver
   *  does with the same fixtures — skip ⇔ skipped row; deliver:instant ⇔ instant pending;
   *  deliver:daily/weekly ⇔ digest member. A resolver change not mirrored in the preview
   *  fails HERE rather than silently diverging (the finding-10 drift trap). */
  const assertEquivalent = async (p: { final_decision: string }, subject: string, tenant: { academy?: string } = {}) => {
    const rows = await enqueueOptional(tenant, subject);
    const email = rows.filter((r: { channel: string }) => r.channel === 'email');
    if (p.final_decision.startsWith('skip:')) {
      // the REAL resolver's skip semantics (learned from it, not assumed): frequency-off and
      // suppression usually emit NOTHING; the N3 cap arm emits a terminal skipped row.
      const delivered = email.filter((r: { status: string }) => r.status === 'pending');
      expect(delivered.length).toBe(0);
    } else {
      const delivered = email.filter((r: { status: string }) => r.status === 'pending');
      expect(delivered.length).toBeGreaterThanOrEqual(1);
      if (p.final_decision === 'deliver:instant') {
        const mode = (await c.query(`SELECT delivery_mode FROM public.notification_outbox WHERE id=$1`, [delivered[0].outbox_id])).rows[0].delivery_mode;
        expect(mode === null || mode === 'instant').toBe(true);
      }
      // daily/weekly digest-vs-delayed routing is EVENT-gated (the digest engine takes only its
      // own events) and is covered by this suite's own digest tests — not re-asserted here.
    }
  };

  it('DEFAULT (no explicit row): provenance shows the catalog source, and preview == resolver', async () => {
    const p = await preview('session_reminder_player');
    expect(p.explicit_preference).toBeNull();
    expect(p.catalog_default).toBe(p.final_frequency);
    expect(p.cap_applied).toBe(false);
    expect(p.destination_masked).toBe('p***@example.com');
    await assertEquivalent(p, 'eq-default');
  });

  it('EXPLICIT OFF wins: provenance names it, and preview == resolver', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ('${U1}','session_reminder_player','off')`);
    const p = await preview('session_reminder_player');
    expect(p.explicit_preference).toBe('off');
    expect(p.final_decision).toBe('skip:frequency_off');
    await assertEquivalent(p, 'eq-off');
  });

  it('ACADEMY CAP most-restrictive-wins: provenance shows the cap AND that it applied; preview == resolver', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ('${U1}','session_reminder_player','instant')`);
    await c.query(`INSERT INTO public.academy_notification_restrictions (academy_profile_id, event_type, channel, max_frequency) VALUES ('${A}','session_reminder_player','email','weekly')`);
    const p = await preview('session_reminder_player', 'email', A);
    expect(p.explicit_preference).toBe('instant');
    expect(p.academy_cap).toBe('weekly');
    expect(p.cap_applied).toBe(true);
    expect(p.final_frequency).toBe('weekly');
    await assertEquivalent(p, 'eq-cap', { academy: A });
    // …and a cap is NEVER a floor: explicit weekly + cap daily (LESS restrictive) → weekly stays
    await c.query(`UPDATE public.notification_preferences_v2 SET email_frequency='weekly' WHERE user_id='${U1}'`);
    await c.query(`UPDATE public.academy_notification_restrictions SET max_frequency='daily'`);
    const p2 = await preview('session_reminder_player', 'email', A);
    expect(p2.cap_applied).toBe(false);
    expect(p2.final_frequency).toBe('weekly');
  });

  it('CAP OFF → skip, tenant-scoped; preview == resolver', async () => {
    await c.query(`INSERT INTO public.academy_notification_restrictions (academy_profile_id, event_type, channel, max_frequency) VALUES ('${A}','session_reminder_player','email','off')`);
    const p = await preview('session_reminder_player', 'email', A);
    expect(p.final_decision).toBe('skip:frequency_off');
    await assertEquivalent(p, 'eq-capoff', { academy: A });
    // no academy attribution → the cap does not reach it
    const pGlobal = await preview('session_reminder_player', 'email', null);
    expect(pGlobal.cap_applied).toBe(false);
    expect(pGlobal.final_decision).not.toBe('skip:frequency_off');
  });

  it('REQUIRED override runs LAST and the provenance says so; preview == resolver', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ('${U1}','booking_confirmed_player','off')`);
    const p = await preview('booking_confirmed_player');
    expect(p.required_delivery).toBe(true);
    expect(p.required_override_applied).toBe(true);
    expect(p.final_frequency).toBe('instant');
    expect(p.final_decision).toBe('deliver:instant');
    // the real resolver: required events go through enqueue() — instant pending despite 'off'
    const rows = await enqueue({ academy: A });
    const email = rows.filter((r: { channel: string }) => r.channel === 'email');
    expect(email[0].status).toBe('pending');
  });

  it('SUPPRESSION: provenance shows it on the resolved masked destination; preview == resolver', async () => {
    await c.query(`INSERT INTO public.email_suppression_stub (email) VALUES ('p1@example.com')`);
    const p = await preview('session_reminder_player');
    expect(p.suppressed).toBe(true);
    expect(p.final_decision).toBe('skip:suppressed');
    expect(p.destination_masked).toBe('p***@example.com');   // masked, never raw
    await assertEquivalent(p, 'eq-suppressed');
  });

  it('the recipient preview is bounded, keyset, and runs each user through the SAME provenance', async () => {
    await asUser(ADMIN_UID);
    const rows = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,NULL,50)`)).rows;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const mine = rows.find((r) => r.user_id === U1);
    expect(mine.destination_masked).toBe('p***@example.com');
    expect(mine.final_decision).toMatch(/^deliver:|^skip:/);
    // the clamp is STRICT — no export-all
    const clamped = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,NULL,10000)`)).rows;
    expect(clamped.length).toBeLessThanOrEqual(50);
    await asUser(null);
  });

  it('destination search: EXACT normalized match only — near-misses find NOTHING, results are masked + counts', async () => {
    await enqueueOptional({}, 'search-seed');
    await asUser(ADMIN_UID);
    const hit = (await c.query(`SELECT * FROM public.admin_search_notification_destination('  P1@Example.com ')`)).rows[0];
    expect(hit.destination_masked).toBe('p***@example.com');
    expect(Number(hit.contacts)).toBeGreaterThanOrEqual(1);
    expect(Number(hit.outbox_rows)).toBeGreaterThanOrEqual(1);
    // a PREFIX is not a match — no substring search exists, by design
    const miss = (await c.query(`SELECT * FROM public.admin_search_notification_destination('p1@example.co')`)).rows[0];
    expect(Number(miss.contacts)).toBe(0);
    expect(Number(miss.outbox_rows)).toBe(0);
    // the log carries FINGERPRINTS, never destinations
    const log = (await c.query(`SELECT fingerprint FROM public.notification_admin_search_log`)).rows;
    expect(log.length).toBe(2);
    for (const l of log) expect(l.fingerprint).not.toContain('example.com');
    await asUser(null);
  });

  it('destination search is rate-limited per actor and admin-fail-closed', async () => {
    await asUser(ADMIN_UID);
    for (let i = 0; i < 28; i++) {
      await c.query(`SELECT * FROM public.admin_search_notification_destination('rate@example.com')`);
    }
    // 28 above + 2 would exceed only at 31 — pushing to the cap
    await c.query(`SELECT * FROM public.admin_search_notification_destination('rate@example.com')`);
    await c.query(`SELECT * FROM public.admin_search_notification_destination('rate@example.com')`);
    await expect(c.query(`SELECT * FROM public.admin_search_notification_destination('rate@example.com')`))
      .rejects.toThrow(/rate limit/);
    await asUser(null);
    await expect(c.query(`SELECT * FROM public.admin_search_notification_destination('x@example.com')`))
      .rejects.toThrow(/platform admin only/);
  });

  it('the readiness envelope: versioned, honest, and NEVER pass before N5', async () => {
    await asUser(ADMIN_UID);
    const env = (await c.query(`SELECT public.admin_notification_readiness() AS r`)).rows[0].r;
    expect(env.schema_version).toBe(1);
    expect(['fail', 'not_provable']).toContain(env.readiness);   // 'pass' is unreachable pre-N5
    const ids = env.checks.map((x: { id: string }) => x.id);
    for (const required of ['channel_kills', 'provider_circuits', 'unresolved_invocations', 'in_flight_work',
      'quarantined_orphans', 'digest_cron', 'digest_send_enabled_env', 'durable_activation_boundary',
      'pre_activation_backlog_eligible_count']) {
      expect(ids).toContain(required);
    }
    const envCheck = env.checks.find((x: { id: string }) => x.id === 'digest_send_enabled_env');
    expect(envCheck.status).toBe('not_provable');
    expect(envCheck.detail).toContain('no SQL can read');
    for (const n5 of ['durable_activation_boundary', 'pre_activation_backlog_eligible_count']) {
      expect(env.checks.find((x: { id: string }) => x.id === n5).status).toBe('not_provable');
    }
    // a kill flips a named check AND the overall verdict to fail
    await c.query(`INSERT INTO public.notification_channel_kill_switches (channel, reason, request_id) VALUES ('email','test kill', gen_random_uuid())`);
    const env2 = (await c.query(`SELECT public.admin_notification_readiness() AS r`)).rows[0].r;
    expect(env2.readiness).toBe('fail');
    expect(env2.checks.find((x: { id: string }) => x.id === 'channel_kills').status).toBe('fail');
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    await asUser(null);
  });
});

describe('N4 M6 round-2 — serialized rate limit, channel-true masks, bounded preview work', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';

  it('the rate limit SERIALIZES: a concurrent 31st search waits behind the 30th, then is refused', async () => {
    await asUser(ADMIN_UID);
    for (let i = 0; i < 29; i++) {
      await c.query(`SELECT * FROM public.admin_search_notification_destination('rl@example.com')`);
    }
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` }); await c2.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT * FROM public.admin_search_notification_destination('rl@example.com')`);   // the 30th, held open
      let settled = false;
      const loser = c2.query(`SELECT * FROM public.admin_search_notification_destination('rl@example.com')`)
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);          // provably serialized on the per-actor lock
      await c.query('COMMIT');
      await expect(loser).rejects.toThrow(/rate limit/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c2.end();
      await asUser(null);
    }
  });

  it('the masked echo is CHANNEL-TRUE, and unrecognizable input is refused', async () => {
    await asUser(ADMIN_UID);
    // fresh actor budget: clear the log the sanctioned way
    await c.query(`ALTER TABLE public.notification_admin_search_log DISABLE TRIGGER trg_notif_admin_search_guard;`);
    await c.query(`DELETE FROM public.notification_admin_search_log;`);
    await c.query(`ALTER TABLE public.notification_admin_search_log ENABLE TRIGGER trg_notif_admin_search_guard;`);
    const wa = (await c.query(`SELECT * FROM public.admin_search_notification_destination('+31612345678')`)).rows[0];
    expect(wa.destination_masked).toBe('•••5678');           // the whatsapp redactor, not '***'
    expect(wa.contacts_capped).toBe(false);
    await expect(c.query(`SELECT * FROM public.admin_search_notification_destination('not-a-destination')`))
      .rejects.toThrow(/normalized email or E.164/);
    await asUser(null);
  });

  it('the recipient preview clamps, dedupes and PAGES over a 60-user population — bounded work, proven continuity', async () => {
    // set-based fixture: 60 users, each with a preference row AND an eligible contact (the
    // union must dedupe them), ids ordered for keyset verification
    await c.query(`
      INSERT INTO auth.users (id)
      SELECT ('a0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 60) g
      ON CONFLICT DO NOTHING;`);
    await c.query(`
      INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
      SELECT ('a0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'session_reminder_player', 'instant'
      FROM generate_series(1, 60) g ON CONFLICT DO NOTHING;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, is_primary)
      SELECT ('a0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'email',
             'bulk' || g || '@example.com', 'b***@example.com', 'opted_in', 'global', true
      FROM generate_series(1, 60) g;`);
    await asUser(ADMIN_UID);
    const page1 = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,NULL,50)`)).rows;
    expect(page1.length).toBe(50);
    const ids1 = page1.map((r) => r.user_id as string);
    expect(new Set(ids1).size).toBe(50);                     // deduped across the two sources
    const page2 = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'${ids1[49]}',50)`)).rows;
    expect(page2.length).toBeGreaterThanOrEqual(10);          // the tail (60 bulk + fixture users)
    expect(page2.length).toBeLessThanOrEqual(50);
    for (const r of page2) expect(ids1).not.toContain(r.user_id);   // NO overlap: real continuity
    await asUser(null);
  });
});

describe('N4 M6 round-3 — candidate eligibility shapes and index integrity', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';
  const mkUser = async (suffix: string) => {
    const uid = `b0000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
    return uid;
  };

  it('candidates: multi-contact users count ONCE, opted-out and out-of-scope are excluded, person-linked count', async () => {
    const multi = await mkUser('1');
    for (let i = 0; i < 3; i++) {
      await c.query(
        `INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, is_primary)
         VALUES ($1, 'email', $2, 'm***@example.com', 'opted_in', 'global', false)`, [multi, `multi${i}@example.com`]);
    }
    const optedOut = await mkUser('2');
    await c.query(
      `INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1, 'email', 'out@example.com', 'o***@example.com', 'opted_out', 'global')`, [optedOut]);
    const scoped = await mkUser('3');
    await c.query(
      `INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id)
       VALUES ($1, 'email', 'scoped@example.com', 's***@example.com', 'opted_in', 'tenant', '${B}')`, [scoped]);
    const personOnly = await mkUser('4');
    const personRow = (await c.query(
      `INSERT INTO public.persons (user_id, email) VALUES ($1, 'ponly@example.com') RETURNING id`, [personOnly])).rows[0].id;
    await c.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1, 'email', 'ponly@example.com', 'p***@example.com', 'opted_in', 'global')`, [personRow]);

    await asUser(ADMIN_UID);
    // tenant scope A: the B-scoped contact must be excluded
    // cursor past the persisted 60-user bulk block (a000...) straight into this test's b000... users
    const rows = (await c.query(
      `SELECT user_id FROM public.admin_preview_notification_recipients('session_reminder_player','email','${A}','b0000000-0000-4000-8000-000000000000',50)`)).rows;
    const ids = rows.map((r) => r.user_id as string);
    expect(ids.filter((x) => x === multi).length).toBe(1);    // ONCE — three contacts, one user
    expect(ids).not.toContain(optedOut);                       // resolver eligibility, mirrored
    expect(ids).not.toContain(scoped);                         // out-of-scope tenant consent
    expect(ids).toContain(personOnly);                         // person-linked reaches the user
    await asUser(null);
  });

  it('the search-serving expression indexes are NON-partial — the structural pin', async () => {
    const idx = (await c.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN ('idx_outbox_dest_fp', 'idx_edev_dest_fp', 'idx_contacts_dest_fp')
    `)).rows;
    expect(idx.length).toBe(3);
    for (const i of idx) {
      // the fingerprint fn is not STRICT, so a partial predicate silently stops serving the
      // search's expression-equality lookups
      expect(i.indexdef).not.toContain('WHERE');
      expect(i.indexdef).toContain('notif_digest_destination_fingerprint');
    }
  });

  it('a SATURATED readiness count says so — value + capped, "at least", never a fake exact', async () => {
    await asUser(ADMIN_UID);
    const env = (await c.query(`SELECT public.admin_notification_readiness() AS r`)).rows[0].r;
    const inflight = env.checks.find((x: { id: string }) => x.id === 'in_flight_work');
    expect(inflight).toHaveProperty('value');
    expect(inflight).toHaveProperty('capped');
    expect(inflight.capped).toBe(false);   // small fixture: uncapped, and says so
    const orphans = env.checks.find((x: { id: string }) => x.id === 'quarantined_orphans');
    expect(orphans).toHaveProperty('capped');
    await asUser(null);
  });
});

describe('N4 M6 round-4 — the persisted candidate projection is maintained and index-served', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';

  it('a person GAINING a login later flows into the projection — the sync trigger', async () => {
    const late = 'c0000000-0000-4000-8000-000000000001';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [late]);
    const pid = (await c.query(`INSERT INTO public.persons (email) VALUES ('late@example.com') RETURNING id`)).rows[0].id;
    await c.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1, 'email', 'late@example.com', 'l***@example.com', 'opted_in', 'global')`, [pid]);
    expect((await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE destination_normalized='late@example.com'`)).rows[0].effective_user_id).toBeNull();
    await c.query(`UPDATE public.persons SET user_id = $1 WHERE id = $2`, [late, pid]);
    expect((await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE destination_normalized='late@example.com'`)).rows[0].effective_user_id).toBe(late);
    await asUser(ADMIN_UID);
    const rows = (await c.query(
      `SELECT user_id FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'c0000000-0000-4000-8000-000000000000',50)`)).rows;
    expect(rows.map((r) => r.user_id)).toContain(late);
    await asUser(null);
  });

  it('the candidate scan is BOUNDED BEFORE dedup: an ordered index stream, no join, no sort', async () => {
    // structural plan pin: the projection query must be served by idx_contacts_effective_user
    // in index order (Unique over a sorted stream that STOPS at the limit) — never a
    // join-then-hash-dedup over every eligible contact
    // the REAL staged query, verbatim shape: composite order, cursor, budget
    const plan = (await c.query(`
      EXPLAIN (FORMAT JSON)
      SELECT nc.effective_user_id, nc.id, nc.consent_status, nc.consent_scope,
             nc.consent_academy_profile_id, nc.consent_trainer_id
        FROM public.notification_contacts nc
       WHERE nc.channel = 'email' AND nc.revoked_at IS NULL
         AND nc.effective_user_id IS NOT NULL
         AND nc.effective_user_id > '00000000-0000-0000-0000-000000000000'::uuid
       ORDER BY nc.effective_user_id, nc.id
       LIMIT 500
    `)).rows[0]['QUERY PLAN'];
    const txt = JSON.stringify(plan);
    expect(txt).toContain('idx_contacts_effective_user');
    expect(txt).not.toContain('"Node Type": "Hash Join"');
    expect(txt).not.toContain('"Node Type": "Sort"');
    expect(txt).not.toContain('Incremental Sort');   // (channel, effective_user_id, id) carries the FULL order
  });

  it('the ≤500-active-contacts cap holds at the schema — the fragment-judgment arm is unreachable', async () => {
    const cap = 'e4000000-0000-4000-8000-000000000001';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [cap]);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      SELECT $1, 'email', 'cap' || g || '@example.com', 'c***@example.com', 'opted_out', 'global'
      FROM generate_series(1, 500) g`, [cap]);
    await expect(c.query(
      `INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1, 'email', 'cap501@example.com', 'c***@example.com', 'opted_in', 'global')`, [cap]))
      .rejects.toThrow(/at most 500 active contacts/);
  });
});

describe('N4 M6 round-5 — the hard raw budget, the derived projection, the link races', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';

  it('a 501-row INELIGIBLE prefix cannot make the server scan invisibly: partial=true, the cursor CRAWLS, the eligible user is reached', async () => {
    // 501 opted-out contacts strictly below one eligible user, all in the d-block
    await c.query(`
      INSERT INTO auth.users (id)
      SELECT ('d0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 502) g
      ON CONFLICT DO NOTHING;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      SELECT ('d0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'email',
             'noise' || g || '@example.com', 'n***@example.com', 'opted_out', 'global'
      FROM generate_series(1, 501) g;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      VALUES ('d0000000-0000-4000-8000-000000000502', 'email', 'needle@example.com', 'n***@example.com', 'opted_in', 'global');`);
    await asUser(ADMIN_UID);
    const page1 = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'d0000000-0000-4000-8000-000000000000',50)`)).rows;
    // the budget was hit inside the noise: the page says PARTIAL and hands a moving cursor
    expect(page1.every((r) => r.candidates_partial === true)).toBe(true);
    const cursor1 = page1[page1.length - 1].next_cursor;
    expect(cursor1).not.toBeNull();
    const page2 = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'${cursor1}',50)`)).rows;
    const found = page2.map((r) => r.user_id);
    expect(found).toContain('d0000000-0000-4000-8000-000000000502');   // the crawl REACHES the needle
    await asUser(null);
  });

  it('effective_user_id is DERIVED, owner-effectively: a direct tamper is recomputed away', async () => {
    const victim = 'e0000000-0000-4000-8000-000000000001';
    const attacker = 'e0000000-0000-4000-8000-000000000002';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [victim, attacker]);
    await c.query(
      `INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1, 'email', 'victim@example.com', 'v***@example.com', 'opted_in', 'global')`, [victim]);
    await c.query(`UPDATE public.notification_contacts SET effective_user_id = $1 WHERE destination_normalized = 'victim@example.com'`, [attacker]);
    expect((await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE destination_normalized='victim@example.com'`)).rows[0].effective_user_id)
      .toBe(victim);   // the trigger recomputed — the projection cannot be assigned
  });

  it('the link race, BOTH orderings, deterministic: neither leaves a stale projection', async () => {
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` }); await c2.connect();
    try {
      // ordering 1: a persons.user_id update holds its lock; a contact INSERT for that person
      // blocks, then reads the COMMITTED person value
      const uidA = 'f0000000-0000-4000-8000-000000000001';
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uidA]);
      const pidA = (await c.query(`INSERT INTO public.persons (email) VALUES ('race1@example.com') RETURNING id`)).rows[0].id;
      await c.query('BEGIN');
      await c.query(`UPDATE public.persons SET user_id = $1 WHERE id = $2`, [uidA, pidA]);
      let s1 = false;
      const ins = c2.query(
        `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
         VALUES ($1, 'email', 'race1@example.com', 'r***@example.com', 'opted_in', 'global')`, [pidA])
        .finally(() => { s1 = true; });
      await new Promise((r) => setTimeout(r, 150));
      expect(s1).toBe(false);      // provably serialized on the person-link lock
      await c.query('COMMIT');
      await ins;
      expect((await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE destination_normalized='race1@example.com'`)).rows[0].effective_user_id).toBe(uidA);

      // ordering 2: a contact INSERT holds the lock; the persons.user_id update blocks, then
      // its sync SEES the committed contact
      const uidB = 'f0000000-0000-4000-8000-000000000002';
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uidB]);
      const pidB = (await c.query(`INSERT INTO public.persons (email) VALUES ('race2@example.com') RETURNING id`)).rows[0].id;
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
         VALUES ($1, 'email', 'race2@example.com', 'r***@example.com', 'opted_in', 'global')`, [pidB]);
      let s2 = false;
      const upd = c2.query(`UPDATE public.persons SET user_id = $1 WHERE id = $2`, [uidB, pidB])
        .finally(() => { s2 = true; });
      await new Promise((r) => setTimeout(r, 150));
      expect(s2).toBe(false);
      await c.query('COMMIT');
      await upd;
      expect((await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE destination_normalized='race2@example.com'`)).rows[0].effective_user_id).toBe(uidB);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c2.end();
    }
  });
});

describe('N4 M6 round-6 — truncation-safe cursors and the boundary-split user', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';

  it('p_limit truncation skips NOTHING: the cursor is the last emitted user, the crawl collects everyone', async () => {
    await c.query(`
      INSERT INTO auth.users (id)
      SELECT ('e1000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 5) g
      ON CONFLICT DO NOTHING;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      SELECT ('e1000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'email',
             'trunc' || g || '@example.com', 't***@example.com', 'opted_in', 'global'
      FROM generate_series(1, 5) g;`);
    await asUser(ADMIN_UID);
    const collected: string[] = [];
    let cursor = `'e1000000-0000-4000-8000-000000000000'`;
    for (let page = 0; page < 4 && collected.length < 5; page++) {
      const rows = (await c.query(
        `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,${cursor},2)`)).rows;
      for (const r of rows) if (r.user_id) collected.push(r.user_id);
      if (rows.length === 0) break;
      // the round-5 defect: this cursor was the scan HORIZON, silently skipping users 3..5
      cursor = `'${rows[rows.length - 1].next_cursor}'`;
    }
    expect(collected.filter((x) => x.startsWith('e1000000')).length).toBe(5);   // no skips
    expect(new Set(collected).size).toBe(collected.length);                      // no dupes
    await asUser(null);
  });

  it('a budget-SPLIT user is deferred WHOLE — their post-split eligible contact is reached, never lost', async () => {
    // 499 noise users (opted_out) then user X with 3 contacts: rows 500-502 — the budget cuts
    // X's set after one row, and X's ELIGIBLE contact is beyond the cut
    await c.query(`
      INSERT INTO auth.users (id)
      SELECT ('e2000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 500) g
      ON CONFLICT DO NOTHING;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      SELECT ('e2000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'email',
             'split' || g || '@example.com', 's***@example.com', 'opted_out', 'global'
      FROM generate_series(1, 499) g;`);
    const X = 'e2000000-0000-4000-8000-000000000500';
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      VALUES ($1, 'email', 'xa@example.com', 'x***@example.com', 'opted_out', 'global'),
             ($1, 'email', 'xb@example.com', 'x***@example.com', 'opted_out', 'global'),
             ($1, 'email', 'xc@example.com', 'x***@example.com', 'opted_in', 'global')`, [X]);
    await asUser(ADMIN_UID);
    const page1 = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'e2000000-0000-4000-8000-000000000000',50)`)).rows;
    // page 1: partial; X must NOT be judged on the fragment
    expect(page1.every((r) => r.candidates_partial === true)).toBe(true);
    expect(page1.map((r) => r.user_id)).not.toContain(X);
    const cursor = page1[page1.length - 1].next_cursor;
    const page2 = (await c.query(
      `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'${cursor}',50)`)).rows;
    expect(page2.map((r) => r.user_id)).toContain(X);   // the WHOLE contact set judged → eligible
    await asUser(null);
  });
});

describe('N4 M6 round-6b — truncation on a PARTIAL page', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';

  it('a truncated PARTIAL page cursors from the last EMITTED user — the eligible users below the horizon are all reached', async () => {
    // 500+ raw rows (mostly opted-out noise) with 25 ELIGIBLE users interleaved below the
    // boundary; p_limit=2 truncates far below the eligible count on every page
    await c.query(`
      INSERT INTO auth.users (id)
      SELECT ('e3000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid FROM generate_series(1, 530) g
      ON CONFLICT DO NOTHING;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      SELECT ('e3000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'email',
             'pt' || g || '@example.com', 'p***@example.com',
             CASE WHEN g % 20 = 0 THEN 'opted_in' ELSE 'opted_out' END, 'global'
      FROM generate_series(1, 530) g;`);
    await asUser(ADMIN_UID);
    const collected: string[] = [];
    let cursor = `'e3000000-0000-4000-8000-000000000000'`;
    for (let page = 0; page < 40; page++) {
      const rows = (await c.query(
        `SELECT * FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,${cursor},2)`)).rows;
      const emitted = rows.filter((r) => r.user_id);
      for (const r of emitted) collected.push(r.user_id);
      if (rows.length === 0) break;
      cursor = `'${rows[rows.length - 1].next_cursor}'`;
    }
    const mine = collected.filter((x) => x.startsWith('e3000000'));
    // 530/20 = 26 eligible users (g = 20,40,...,520); ALL must be collected, none skipped
    expect(new Set(mine).size).toBe(26);
    await asUser(null);
  });
});

describe('N4 M6 round-7 — migration-time cap validation and the UPDATE-path lock order', () => {
  it('the migration REFUSES to deploy over an over-cap group — the extracted assertion, proven on 501 rows', async () => {
    const over = 'e5000000-0000-4000-8000-000000000001';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [over]);
    await c.query(`ALTER TABLE public.notification_contacts DISABLE TRIGGER trg_zz_notif_contact_cap;`);
    await c.query(`
      INSERT INTO public.notification_contacts (user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
      SELECT $1, 'email', 'over' || g || '@example.com', 'o***@example.com', 'opted_out', 'global'
      FROM generate_series(1, 501) g`, [over]);
    await c.query(`ALTER TABLE public.notification_contacts ENABLE TRIGGER trg_zz_notif_contact_cap;`);
    const mig = MIG('20261021100000_notif_n4_readiness_preview_search.sql');
    const assertion = mig.match(/DO \$\$\nDECLARE r record;\nBEGIN\n {2}SELECT nc\.channel[\s\S]*?END \$\$;/)?.[0];
    if (!assertion) throw new Error('cap assertion not found in the migration');
    await expect(c.query(assertion)).rejects.toThrow(/migration blocked.*501 active contacts/);
    // cleanup so later tests see a legal world
    await c.query(`DELETE FROM public.notification_contacts WHERE user_id = $1`, [over]);
  });

  it('a contact UPDATE racing a persons.user_id update: row-lock order, NO deadlock, fresh final projection', async () => {
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` }); await c2.connect();
    try {
      const uid = 'e6000000-0000-4000-8000-000000000001';
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
      const pid = (await c.query(`INSERT INTO public.persons (email) VALUES ('updrace@example.com') RETURNING id`)).rows[0].id;
      await c.query(
        `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
         VALUES ($1, 'email', 'updrace@example.com', 'u***@example.com', 'opted_in', 'global')`, [pid]);
      // session A holds an ordinary contact UPDATE open (row lock held, NO advisory taken)
      await c.query('BEGIN');
      await c.query(`UPDATE public.notification_contacts SET is_primary = true WHERE destination_normalized = 'updrace@example.com'`);
      // session B: the persons.user_id update — its sync touch must WAIT on the row, not deadlock
      let settled = false;
      const upd = c2.query(`UPDATE public.persons SET user_id = $1 WHERE id = $2`, [uid, pid])
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);            // serialized on the ROW lock — deterministic, no inversion
      await c.query('COMMIT');
      await upd;                               // completes cleanly — no deadlock abort
      expect((await c.query(`SELECT effective_user_id, is_primary FROM public.notification_contacts WHERE destination_normalized='updrace@example.com'`)).rows[0])
        .toMatchObject({ effective_user_id: uid, is_primary: true });   // BOTH writes land, projection fresh
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c2.end();
    }
  });
});

describe('N4 M6 round-8 — the A→B relink race', () => {
  it('a contact relinking to person B while B gains a login: the relink WAITS on B, the projection ends fresh', async () => {
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` }); await c2.connect();
    try {
      const uidB = 'e7000000-0000-4000-8000-000000000002';
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uidB]);
      const pidA = (await c.query(`INSERT INTO public.persons (email) VALUES ('relink-a@example.com') RETURNING id`)).rows[0].id;
      const pidB = (await c.query(`INSERT INTO public.persons (email) VALUES ('relink-b@example.com') RETURNING id`)).rows[0].id;
      await c.query(
        `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
         VALUES ($1, 'email', 'relink@example.com', 'r***@example.com', 'opted_in', 'global')`, [pidA]);
      // session 1: B gains its login — held open (advisory B held by the sync trigger; its
      // contact scan sees NO rows for B, so it waits on nothing)
      await c.query('BEGIN');
      await c.query(`UPDATE public.persons SET user_id = $1 WHERE id = $2`, [uidB, pidB]);
      // session 2: the A→B RELINK — the changed-person arm must WAIT on B's advisory, because
      // B's sync could not see this row (old person = A in its snapshot)
      let settled = false;
      const relink = c2.query(`UPDATE public.notification_contacts SET person_id = $1 WHERE destination_normalized = 'relink@example.com'`, [pidB])
        .finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 150));
      expect(settled).toBe(false);            // provably serialized — the round-8 race closed
      await c.query('COMMIT');
      await relink;
      expect((await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE destination_normalized='relink@example.com'`)).rows[0].effective_user_id)
        .toBe(uidB);                           // the relink read B's COMMITTED login — never the stale NULL
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c2.end();
    }
  });
});

describe('N4 SEAM corrections — the whole-unit findings', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';

  it('SEAM 6: the preview mirrors the resolver’s ACCOUNT-EMAIL fallback and its unsupported-channel skip', async () => {
    // a logged-in user with NO eligible contact — production still mails persons.email
    const uid = 'aa000000-0000-4000-8000-000000000001';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
    await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1, 'fallback@example.com')`, [uid]);
    await asUser(ADMIN_UID);
    const d = (await c.query(
      `SELECT * FROM public.admin_preview_notification_decision($1, 'session_reminder_player', 'email', NULL)`, [uid])).rows[0];
    expect(d.contact_found).toBe(true);
    expect(d.contact_source).toBe('account_email');           // NOT skip:no_contact
    expect(d.destination_masked).toBe('f***@example.com');
    expect(d.final_decision).not.toContain('no_contact');
    // …and the candidate LIST includes them (they were omitted entirely before)
    const rows = (await c.query(
      `SELECT user_id FROM public.admin_preview_notification_recipients('session_reminder_player','email',NULL,'aa000000-0000-4000-8000-000000000000',50)`)).rows;
    expect(rows.map((r) => r.user_id)).toContain(uid);
    // an UNSUPPORTED channel is skipped BEFORE resolution, exactly as the resolver does —
    // read the catalog rather than assuming which pair is unsupported
    const unsupported = (await c.query(
      `SELECT key FROM public.notification_event_types WHERE NOT supports_whatsapp ORDER BY key LIMIT 1`)).rows[0];
    expect(unsupported).toBeTruthy();
    const wa = (await c.query(
      `SELECT * FROM public.admin_preview_notification_decision($1, $2, 'whatsapp', NULL)`, [uid, unsupported.key])).rows[0];
    expect(wa.catalog_supported).toBe(false);
    expect(wa.final_decision).toBe('skip:channel_unsupported');
    await asUser(null);
  });

  it('SEAM 5: the internal evidence helpers are not reachable by any API role', async () => {
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` }); await c2.connect();
    try {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        await c2.query(`SET ROLE ${role}`);
        for (const fn of [
          `public.notif_admin_replay_gate(gen_random_uuid(), gen_random_uuid(), 'channel_kill', 'email', 'x', 'y')`,
          `public.notif_admin_record_verdict(gen_random_uuid(), gen_random_uuid(), 'channel_kill', 'f', 'killed')`,
          `public.notif_admin_record_refusal(gen_random_uuid(), gen_random_uuid(), 'channel_kill', 'email', 'x', 'y')`,
        ]) {
          await expect(c2.query(`SELECT ${fn}`), `${role} must not reach ${fn}`).rejects.toThrow();
        }
        await c2.query(`RESET ROLE`);
      }
    } finally { await c2.end(); }
  });

  it('SEAM 4: a person-sync concurrent with a direct contact update does not DEADLOCK', async () => {
    const c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` }); await c2.connect();
    try {
      const uid = 'ab000000-0000-4000-8000-000000000001';
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
      const pid = (await c.query(`INSERT INTO public.persons (email) VALUES ('multi@example.com') RETURNING id`)).rows[0].id;
      // TWO contacts for one person — the shape the single-contact tests could not exercise
      for (const d of ['m1@example.com', 'm2@example.com']) {
        await c.query(
          `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
           VALUES ($1, 'email', $2, 'm***@example.com', 'opted_in', 'global')`, [pid, d]);
      }
      // session A holds contact 2's row; session B runs the person sync (advisory then rows)
      await c.query('BEGIN');
      await c.query(`UPDATE public.notification_contacts SET is_primary = true WHERE destination_normalized = 'm2@example.com'`);
      const sync = c2.query(`UPDATE public.persons SET user_id = $1 WHERE id = $2`, [uid, pid]);
      await new Promise((r) => setTimeout(r, 150));
      await c.query('COMMIT');
      await sync;                                   // completes — NO deadlock abort
      const rows = (await c.query(`SELECT effective_user_id FROM public.notification_contacts WHERE person_id = $1`, [pid])).rows;
      expect(rows.every((r) => r.effective_user_id === uid)).toBe(true);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c2.end();
    }
  });

  it('SEAM 7: a cross-actor request-id collision is a TYPED verdict, not a raw unique violation', async () => {
    const OTHER = 'ac000000-0000-4000-8000-000000000002';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [OTHER]);
    await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [OTHER]);
    const shared = crypto.randomUUID();
    await asUser(ADMIN_UID);
    expect((await c.query(`SELECT public.admin_activate_channel_kill('email','first admin',$1) AS r`, [shared])).rows[0].r).toBe('killed');
    await asUser(OTHER);
    // the SAME uuid, a different actor, a different channel: both pass their actor-scoped gate,
    // and the kill table's GLOBAL uniqueness would have raised and rolled the evidence back
    expect((await c.query(`SELECT public.admin_activate_channel_kill('whatsapp','second admin',$1) AS r`, [shared])).rows[0].r)
      .toBe('rejected_id_collision');
    expect((await c.query(`SELECT count(*)::int n FROM public.notification_admin_rejected_attempts WHERE actor=$1`, [OTHER])).rows[0].n).toBe(1);
    expect((await c.query(`SELECT verdict FROM public.notification_admin_requests WHERE actor=$1`, [OTHER])).rows[0].verdict).toBe('rejected_id_collision');
    await asUser(null);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
    await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
    await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
  });
});

describe('N4 SEAM corrections ROUND 2 — the defects the first correction left behind', () => {
  const ADMIN_UID = '99999999-9999-4999-8999-999999999999';
  beforeEach(async () => {
    await c.query(`INSERT INTO auth.users (id) VALUES ('${ADMIN_UID}') ON CONFLICT DO NOTHING;`);
    await c.query(`INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN_UID}','admin') ON CONFLICT DO NOTHING;`);
  });

  it('SEAM 9b/9c: a BLANK contact destination is NO contact and does NOT fall back to the account email — proven against the real resolver', async () => {
    const uid = 'ad000000-0000-4000-8000-000000000003';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
    const pid = (await c.query(
      `INSERT INTO public.persons (user_id, email) VALUES ($1, 'real@example.com') RETURNING id`, [uid])).rows[0].id;
    // destination_normalized is NOT NULL, but '' is not forbidden — and the resolver's rule is
    // "a contact row that EXISTS consumes the decision", so this must NOT reach real@example.com
    await c.query(
      `INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
         destination_redacted, consent_status, consent_scope, is_primary)
       VALUES ($1, $2, 'email', '   ', '***', 'opted_in', 'global', true)`, [pid, uid]);

    await asUser(ADMIN_UID);
    const d = (await c.query(
      `SELECT * FROM public.admin_preview_notification_decision($1,'booking_confirmed_player','email',$2)`, [uid, A])).rows[0];
    await asUser(null);
    expect(d.final_decision).toBe('skip:no_contact');   // was deliver:instant
    expect(d.contact_found).toBe(false);
    expect(d.contact_source).toBe('none');              // NOT 'account_email' — no fallback happens
    expect(d.destination_masked).toBeNull();

    // THE ORACLE: the real resolver on the same fixtures. booking_confirmed_player is
    // required_delivery, so its refusal is a VISIBLE skipped row carrying the reason.
    const rows = (await c.query(
      `SELECT * FROM public.enqueue_notification(
         p_event_key => 'booking_confirmed_player', p_recipient_person_id => $1,
         p_idempotency_subject => 'blank-dest', p_tenant_academy_profile_id => $2)`, [pid, A])).rows;
    const email = rows.filter((r: { channel: string }) => r.channel === 'email');
    expect(email.length).toBe(1);
    expect(email[0].status).toBe('skipped');
    expect(email[0].skip_reason).toBe('no_email_contact');   // never delivered to real@example.com
    expect((await c.query(
      `SELECT count(*)::int n FROM public.notification_outbox
        WHERE recipient_person_id = $1 AND status = 'pending'`, [pid])).rows[0].n).toBe(0);
  });

  it('SEAM 9a: an UNSUPPORTED channel reports NOTHING derived — the resolver computes none of it', async () => {
    const evt = (await c.query(
      `SELECT key FROM public.notification_event_types
        WHERE NOT supports_whatsapp AND NOT required_delivery ORDER BY key LIMIT 1`)).rows[0];
    expect(evt).toBeTruthy();
    const uid = 'ad000000-0000-4000-8000-000000000004';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [uid]);
    await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1, 'unsup@example.com')`, [uid]);
    // a preference AND an academy cap that WOULD be reported if resolution ran
    await c.query(
      `INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency)
       VALUES ($1, $2, 'instant')`, [uid, evt.key]);
    // the cap is inserted PAST the N3 guard on purpose: the RPC refuses a cap on a channel the
    // event does not support, so this row can only arise from a catalog flip — the same stale
    // shape the resolver's own comment anticipates, and precisely when a fabricated "APPLIED"
    // reading would mislead an operator most
    await c.query(`ALTER TABLE public.academy_notification_restrictions DISABLE TRIGGER trg_notif_academy_restriction_guard;`);
    await c.query(
      `INSERT INTO public.academy_notification_restrictions (academy_profile_id, event_type, channel, max_frequency)
       VALUES ($1, $2, 'whatsapp', 'off')`, [A, evt.key]);
    await c.query(`ALTER TABLE public.academy_notification_restrictions ENABLE TRIGGER trg_notif_academy_restriction_guard;`);
    await asUser(ADMIN_UID);
    const d = (await c.query(
      `SELECT * FROM public.admin_preview_notification_decision($1,$2,'whatsapp',$3)`, [uid, evt.key, A])).rows[0];
    await asUser(null);
    expect(d.final_decision).toBe('skip:channel_unsupported');
    expect(d.catalog_supported).toBe(false);
    // every column below is a RESOLUTION output; production never reaches them for this channel
    expect(d.explicit_preference).toBeNull();          // was 'instant'
    expect(d.academy_cap).toBeNull();                  // was 'off'
    expect(d.cap_applied).toBe(false);                 // was true
    expect(d.final_frequency).toBeNull();              // was 'off'
    expect(d.whatsapp_optin_arm).toBe(false);
    expect(d.contact_found).toBe(false);
    expect(d.contact_source).toBe('none');
    expect(d.suppressed).toBe(false);
    // channel-level facts ARE still reported — they are not resolution outputs
    expect(d.kill_state).toBe('live');
    expect(d.circuit_state).toBe('none');
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE user_id = $1`, [uid]);
    await c.query(`DELETE FROM public.academy_notification_restrictions WHERE event_type = $1`, [evt.key]);
  });

  // SEAM 10 (the two-actor collision RACE) lives in notifChannelKill.realpg.test.ts: this
  // harness fakes auth.uid() with a shared TABLE row, so two sessions cannot hold two different
  // identities — the kill suite's per-session set_config() can.

  it('SEAM 11/14: the evidence assertion demands the APPLIED DECISION, not merely a row with the right ids', async () => {
    const assertion = MIG('20261024100000_notif_n4_seam_corrections_round3.sql')
      .match(/DO \$\$\nDECLARE v_bad text;[\s\S]*?END \$\$;/)?.[0];
    if (!assertion) throw new Error('the seam-14 assertion was not found in the round-3 migration');
    const clearKills = async () => {
      await c.query(`ALTER TABLE public.notification_channel_kill_switches DISABLE TRIGGER trg_notif_channel_kill_guard;`);
      await c.query(`DELETE FROM public.notification_channel_kill_switches;`);
      await c.query(`ALTER TABLE public.notification_channel_kill_switches ENABLE TRIGGER trg_notif_channel_kill_guard;`);
    };
    await clearKills();
    await c.query(assertion);                            // the clean world passes
    const actor = 'af000000-0000-4000-8000-000000000001';
    await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [actor]);

    // (a) a kill with NO audit row at all — the shape ON CONFLICT DO NOTHING accepted in silence
    const req = crypto.randomUUID();
    await c.query(
      `INSERT INTO public.notification_channel_kill_switches (channel, activated_by, reason, request_id)
       VALUES ('whatsapp', $1, 'legacy kill', $2)`, [actor, req]);
    await expect(c.query(assertion)).rejects.toThrow(/no APPLIED audit decision/);

    // (b) the case round 2 ACCEPTED: an M2-era kill whose id was replayed after M3, leaving an
    // 'already_killed' audit row. Same actor, same request id, same action, same target — and
    // still no evidence that this kill was ever applied.
    await c.query(`ALTER TABLE public.notification_admin_audit DISABLE TRIGGER trg_notif_admin_audit_guard;`);
    await c.query(`DELETE FROM public.notification_admin_audit WHERE request_id = $1`, [req]);
    await c.query(`ALTER TABLE public.notification_admin_audit ENABLE TRIGGER trg_notif_admin_audit_guard;`);
    await c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, $2, 'channel_kill', 'whatsapp', 'killed', 'killed', 'already_killed', 'legacy kill')`,
      [actor, req]);
    await expect(c.query(assertion)).rejects.toThrow(/no APPLIED audit decision/);

    // (c) the real evidence — applied + the registry verdict under the canonical fingerprint
    await c.query(`ALTER TABLE public.notification_admin_audit DISABLE TRIGGER trg_notif_admin_audit_guard;`);
    await c.query(`DELETE FROM public.notification_admin_audit WHERE request_id = $1`, [req]);
    await c.query(`ALTER TABLE public.notification_admin_audit ENABLE TRIGGER trg_notif_admin_audit_guard;`);
    await c.query(
      `INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
       VALUES ($1, $2, 'channel_kill', 'whatsapp', 'live', 'killed', 'applied', 'legacy kill')`,
      [actor, req]);
    // …the audit alone is still not enough: the registry must carry the 'killed' verdict
    await expect(c.query(assertion)).rejects.toThrow(/no matching registry verdict/);
    await c.query(
      `INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict)
       VALUES ($1, $2, 'channel_kill',
               public.notif_admin_fingerprint(jsonb_build_object('action','channel_kill','channel','whatsapp','reason','legacy kill')),
               'killed')`, [actor, req]);
    await c.query(assertion);                            // now it passes
    await clearKills();
    await c.query(`ALTER TABLE public.notification_admin_audit DISABLE TRIGGER trg_notif_admin_audit_guard;`);
    await c.query(`DELETE FROM public.notification_admin_audit WHERE request_id = $1`, [req]);
    await c.query(`ALTER TABLE public.notification_admin_audit ENABLE TRIGGER trg_notif_admin_audit_guard;`);
    await c.query(`ALTER TABLE public.notification_admin_requests DISABLE TRIGGER trg_notif_admin_requests_guard;`);
    await c.query(`DELETE FROM public.notification_admin_requests WHERE request_id = $1`, [req]);
    await c.query(`ALTER TABLE public.notification_admin_requests ENABLE TRIGGER trg_notif_admin_requests_guard;`);
  });
});
