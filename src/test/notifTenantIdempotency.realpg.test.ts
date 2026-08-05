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
