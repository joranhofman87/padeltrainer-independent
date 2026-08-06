// @vitest-environment node
// 10c-b C — RESOLVER COMPLETION, verified on a REAL Postgres server (embedded-postgres).
//
// Loads the deployed resolver (20260911100000) over prod-shaped stubs, then the real digest
// foundation/ACL/state-machine/B migrations, then C. Every assertion runs against the ACTUAL
// deployed SQL — the resolver, the hash-stamp trigger, the stop predicate — never a hand copy.
//
// Proves:
//   * the v1 -> v2 preference backfill: off/instant/daily/weekly carried EXACTLY, an explicit v2
//     row WINS, reruns are pure no-ops, a missing legacy row leaves the catalog weekly default
//   * engine OFF: an explicit `skipped`/`digest_engine_disabled` row that is invisible to BOTH the
//     instant worker (status<>'pending') and the materializer (delivery_mode IS NULL), scheduled
//     NOW rather than into the future — i.e. no backlog can burst on enablement
//   * 'off' emits nothing; 'instant' emits a normal instant row with no digest fields
//   * engine ON: one digest member carrying the complete canonical snapshot, with digest_group_hash
//     and digest_item_bytes stamped by the trigger (never by the resolver)
//   * §BND boundaries are DST-correct across the March and October transitions, incl. next-Monday
//   * THE BLAST-RADIUS RULE: a supports_digest event WITHOUT digest_cutover keeps its legacy
//     delayed-instant daily/weekly row, byte-for-byte
//   * §PS event hook: unfollow / notify_new_availability=false stop the member
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54371;
let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let c: pg.Client;
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

const USER = '11111111-1111-1111-1111-111111111111';
const PERSON = '22222222-2222-2222-2222-222222222222';
const PROFILE = '33333333-3333-3333-3333-333333333333';
const TRAINER = '44444444-4444-4444-4444-444444444444';
const ACADEMY = '55555555-5555-5555-5555-555555555555';

/** Captured in beforeAll, straight after C is applied, before any test mutates the catalog. */
let engineFlagAsShipped: boolean | undefined;
let cutoverAsShipped: string[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'osresolver-rp-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();

  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    -- Catalog, prod-shaped (20260910100000) incl. the 10c-a kill switch.
    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      category text NOT NULL DEFAULT 'booking',
      audience text NOT NULL DEFAULT 'player',
      priority text NOT NULL DEFAULT 'engagement',
      required_delivery boolean NOT NULL DEFAULT false,
      supports_email boolean NOT NULL DEFAULT true,
      supports_whatsapp boolean NOT NULL DEFAULT false,
      supports_push boolean NOT NULL DEFAULT false,
      supports_digest boolean NOT NULL DEFAULT false,
      default_email_frequency text NOT NULL DEFAULT 'instant' CHECK (default_email_frequency IN ('instant','daily','weekly','off')),
      default_whatsapp_frequency text NOT NULL DEFAULT 'off' CHECK (default_whatsapp_frequency IN ('instant','daily','weekly','off')),
      default_push_frequency text NOT NULL DEFAULT 'off' CHECK (default_push_frequency IN ('instant','daily','weekly','off')),
      collapse_window_minutes int NOT NULL DEFAULT 0,
      quiet_hours_respect boolean NOT NULL DEFAULT false,
      template_email text, template_whatsapp text,
      visibility_scope text NOT NULL DEFAULT 'private_user_only',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      digest_engine_enabled boolean NOT NULL DEFAULT false,
      CONSTRAINT chk_event_types_digest_engine_implies_supports CHECK (NOT digest_engine_enabled OR supports_digest));

    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, user_id uuid, guest_player_id uuid,
      channel text NOT NULL DEFAULT 'email', destination_normalized text NOT NULL, destination_redacted text,
      consent_status text NOT NULL DEFAULT 'unknown', consent_scope text NOT NULL DEFAULT 'global',
      consent_academy_profile_id uuid, consent_trainer_id uuid, revoked_at timestamptz,
      is_primary boolean NOT NULL DEFAULT false, verified_at timestamptz);
    CREATE FUNCTION public.is_notification_consent_in_scope(
      _consent_scope text, _consent_academy uuid, _consent_trainer uuid, _ctx_academy uuid, _ctx_trainer uuid)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
      SELECT CASE
        WHEN _consent_scope = 'global' THEN true
        WHEN _consent_scope = 'tenant' THEN
              (_consent_academy IS NULL OR (_ctx_academy IS NOT NULL AND _ctx_academy = _consent_academy))
          AND (_consent_trainer IS NULL OR (_ctx_trainer IS NOT NULL AND _ctx_trainer = _consent_trainer))
          AND (_consent_academy IS NOT NULL OR _consent_trainer IS NOT NULL)
        ELSE false END $fn$;

    CREATE TABLE public.notification_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), channel text NOT NULL DEFAULT 'email',
      event_type text, template_key text, status text NOT NULL DEFAULT 'pending',
      payload jsonb, public_summary jsonb, skip_reason text,
      destination_normalized text, destination_redacted text,
      contact_id uuid REFERENCES public.notification_contacts(id) ON DELETE SET NULL,
      recipient_person_id uuid, recipient_user_id uuid, recipient_guest_player_id uuid,
      tenant_academy_profile_id uuid, tenant_trainer_id uuid, visibility_scope text,
      related_booking_ids uuid[], related_invoice_id uuid, related_payment_id text,
      idempotency_key text, collapse_key text, scheduled_for timestamptz,
      -- worker-lifecycle columns (20260910100000) the instant claim RPC needs
      attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
      locked_at timestamptz, locked_by text, next_attempt_at timestamptz,
      failed_at timestamptz, last_error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')),
      UNIQUE (channel, idempotency_key));
    -- The PRODUCTION baseline index (20260910100000). Without it the scale test below would
    -- compare the new partial index against a sequential scan instead of the real baseline,
    -- and would therefore "prove" an improvement that production never lacked.
    CREATE INDEX idx_notification_outbox_due
      ON public.notification_outbox (status, scheduled_for, next_attempt_at)
      WHERE status IN ('pending','processing');

    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS
      $fn$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p_email)) $fn$;

    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL,
      email_frequency text NOT NULL DEFAULT 'instant' CHECK (email_frequency IN ('instant','daily','weekly','off')),
      whatsapp_frequency text NOT NULL DEFAULT 'off', push_frequency text NOT NULL DEFAULT 'off',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_type));
    -- the LEGACY v1 preference table, with the real column default
    CREATE TABLE public.notification_preferences (
      user_id uuid PRIMARY KEY, open_slots_digest text NOT NULL DEFAULT 'weekly');

    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE,
      email text, preferred_language text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      preferred_language text);
    CREATE TABLE public.person_links (guest_player_id uuid, person_id uuid);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, timezone text NOT NULL DEFAULT 'Europe/Amsterdam');
    -- the LEGACY dedup table, present so the "no dual route" assertion actually runs
    CREATE TABLE public.notification_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedup_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.trainer_followers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL, trainer_id uuid NOT NULL,
      notify_new_availability boolean NOT NULL DEFAULT true, UNIQUE (player_id, trainer_id));
  `);

  // The REAL migration chain, in order.
  for (const f of [
    '20260911100000_notification_resolver.sql',
    // the INSTANT worker's claim RPC — in the chain so the engine-on tests can prove the
    // instant worker and the digest engine do not race for the same row
    '20260912100000_notification_email_worker.sql',
    // The TRUE pre-C baseline of enqueue_notification: this migration REPLACED the Sept-11
    // resolver, adding the WhatsApp booking-opt-in cadence branch. Without it in the chain,
    // C could silently drop that branch and every test here would still pass.
    '20260922100000_notification_whatsapp_booking_optin_cadence.sql',
    '20261002100000_notification_digest_schema_foundation.sql',
    '20261003100000_notification_digest_acl_lockdown.sql',
    '20261004100000_notification_digest_state_machine.sql',
    '20261005110000_notification_digest_request_hash_bytea_fix.sql',
    '20261008100000_open_slots_player_event.sql',
    '20261009100000_notif_10cb_review_corrections.sql',
    '20261010100000_open_slots_item_types_and_plurals.sql',
  ]) {
    await c.query(MIG(f));
  }

  // Baseline fixtures that must exist BEFORE C's backfill runs (it is a data migration).
  await c.query(`
    INSERT INTO auth.users (id) VALUES ('${USER}');
    INSERT INTO public.persons (id, user_id, email, preferred_language) VALUES ('${PERSON}','${USER}','p@example.com','nl');
    INSERT INTO public.profiles (id, user_id, preferred_language) VALUES ('${PROFILE}','${USER}','nl');
    INSERT INTO public.academy_profiles (id, timezone) VALUES ('${ACADEMY}','Europe/Amsterdam');
    INSERT INTO public.trainer_profiles (id, timezone) VALUES ('${TRAINER}','Europe/Amsterdam');
    INSERT INTO public.trainer_followers (player_id, trainer_id, notify_new_availability)
      VALUES ('${PROFILE}','${TRAINER}', true);
    INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized,
      destination_redacted, consent_status, consent_scope, is_primary)
      VALUES ('${PERSON}','${USER}','email','p@example.com','p***@example.com','opted_in','global', true);
  `);

  // Apply C ONCE here and capture the engine flag BEFORE any test can touch it. Every
  // engine-on/engine-off suite below explicitly sets the flag, so without this capture the
  // whole file would stay green even if C shipped the engine ENABLED — the single most
  // consequential thing this release must not do.
  await applyC();
  engineFlagAsShipped = (await c.query(
    `SELECT digest_engine_enabled FROM public.notification_event_types WHERE key='open_slots_player'`
  )).rows[0].digest_engine_enabled;
  cutoverAsShipped = (await c.query(
    `SELECT key FROM public.notification_event_types WHERE digest_cutover ORDER BY key`
  )).rows.map((r) => r.key);
}, 300_000);

afterAll(async () => { if (c) await c.end(); if (epg) await epg.stop(); });

/** Apply BOTH C migrations. Explicit per test-group so nothing depends on test ordering. */
async function applyC() {
  await c.query(MIG('20261011100000_notif_10cb_resolver_open_slots_digest.sql'));
  await c.query(MIG('20261011130000_notif_10cb_open_slots_instant_payload.sql'));
  await c.query(MIG('20261011110000_notif_10cb_enqueue_digest_branch.sql'));
  await c.query(MIG('20261011120000_notif_10cb_instant_claim_excludes_digest.sql'));
  await c.query(MIG('20261011140000_notif_10cb_cutover_compat.sql'));
  // J REPLACES notif_mirror_open_slots_pref_to_v2 (adding the re-entrancy guard) and adds the
  // reverse mirror. Without it in the chain, every forward-mirror pin below would exercise a
  // function body production no longer runs — green against code that is not deployed.
  await c.query(MIG('20261013100000_notif_10cb_pref_bridge_v2_to_v1.sql'));
}

/**
 * Seed a v2 row WITHOUT firing the reverse (v2 -> v1) mirror.
 *
 * These scenarios need a user who holds a v2 row and NO legacy row. That is precisely the state a
 * v2 save produced BEFORE J shipped the reverse mirror, and it persists for everyone who used the
 * v2 settings page during that window — so it is a real world, not a contrived one. Letting the
 * reverse mirror run here would materialise the legacy row first, and the FORWARD rule under test
 * (which turns on whether a legacy row exists) would never be reached.
 */
async function withoutReverseMirror<T>(fn: () => Promise<T>): Promise<T> {
  await c.query(`ALTER TABLE public.notification_preferences_v2 DISABLE TRIGGER trg_mirror_open_slots_pref_to_v1`);
  try {
    return await fn();
  } finally {
    await c.query(`ALTER TABLE public.notification_preferences_v2 ENABLE TRIGGER trg_mirror_open_slots_pref_to_v1`);
  }
}

async function seedV2PreJ(freq: string, u = USER) {
  await withoutReverseMirror(() =>
    c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
             VALUES ($1,'open_slots_player',$2)`, [u, freq]));
}

async function enqueue(subject: string, payload: object = {}) {
  const { rows } = await c.query(
    `SELECT * FROM public.enqueue_notification(
       p_event_key := 'open_slots_player', p_recipient_user_id := $1,
       p_tenant_trainer_id := $2, p_idempotency_subject := $3, p_payload := $4::jsonb)`,
    [USER, TRAINER, subject, JSON.stringify(payload)],
  );
  return rows;
}

/**
 * Pull the `due` CTE's SELECT out of the DEPLOYED claim_notification_outbox_batch body and
 * parameter-substitute it, so the plan we assert on is the one production actually runs. A
 * hand-written lookalike would keep passing after the RPC's predicate, ordering or index
 * changed — exactly the regression this test exists to catch.
 */
async function extractDueQuery(): Promise<string> {
  // Pin the EXACT overload by signature: filtering on proname alone would silently pick an
  // arbitrary definition if an overload were ever added.
  const { rows } = await c.query(
    `SELECT pg_get_functiondef(
       'public.claim_notification_outbox_batch(text,text,int,int)'::regprocedure) AS def`);
  const def: string = rows[0].def;

  // Anchor on the CTE itself rather than the first textual 'SELECT o.id', which a comment or a
  // future earlier query could shadow.
  const cte = /WITH due AS \(\s*(SELECT o\.id[\s\S]*?)LIMIT greatest\(p_limit, 0\)/.exec(def);
  if (!cte) throw new Error('could not locate the due CTE in the deployed function');
  const sql = cte[1]
    .replace(/p_channel/g, `'email'`)
    .replace(/greatest\(p_stale_after_minutes, 1\)/g, '15')
    + ' LIMIT 20';

  // Fail LOUDLY if the extracted slice stopped representing the RPC's actual semantics.
  for (const marker of [`delivery_mode IS DISTINCT FROM 'digest'`, `o.status = 'pending'`,
    `o.status = 'processing'`, 'ORDER BY o.scheduled_for', 'FOR UPDATE SKIP LOCKED']) {
    if (!sql.includes(marker)) throw new Error(`extracted due query lost its "${marker}" semantics`);
  }
  if (/p_[a-z_]+/.test(sql)) throw new Error(`extracted due query still has unsubstituted params: ${sql}`);
  return sql;
}

/** Every index name appearing anywhere in a parsed EXPLAIN plan tree. */
function indexNames(node: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof node['Index Name'] === 'string') out.push(node['Index Name'] as string);
  for (const child of (node['Plans'] as Array<Record<string, unknown>>) ?? []) out.push(...indexNames(child));
  return out;
}

/** Worst "Rows Removed by Filter" anywhere in the tree. Walks the PARSED plan: the value is a
 *  JSON number, so regexing JSON.stringify output silently matches nothing and asserts nothing. */
function worstRowsRemoved(node: Record<string, unknown>): number {
  let worst = Number(node['Rows Removed by Filter'] ?? 0);
  for (const child of (node['Plans'] as Array<Record<string, unknown>>) ?? []) {
    worst = Math.max(worst, worstRowsRemoved(child));
  }
  return worst;
}

const ITEM = {
  subtype: 'new_availability',
  data: { trainer_name: 'Coach Ana', date_from: '2026-08-10', date_to: '2026-08-16', slot_count: 3 },
};

// ===========================================================================
describe('C — ships INERT (asserted as applied, not as later re-set)', () => {
  it('applying C leaves digest_engine_enabled FALSE for open_slots_player', () => {
    // Read from the capture taken immediately after the migrations ran. Asserting the live
    // column here instead would prove nothing: later suites set it deliberately.
    expect(engineFlagAsShipped).toBe(false);
  });

  it('applying C makes open_slots_player the ONLY cutover event', () => {
    expect(cutoverAsShipped).toEqual(['open_slots_player']);
  });
});

// ===========================================================================
// C replaces enqueue_notification wholesale, so it can silently DELETE a branch added by a
// later migration than the one it was based on. The WhatsApp booking-opt-in cadence
// (20260922100000) is exactly such a branch: it lets an opted-in, in-scope contact supply the
// cadence when no explicit v2 preference exists — the only way a GUEST can ever receive
// WhatsApp. Losing it would stop live WhatsApp delivery with nothing to do with digests.
describe('C — preserves the WhatsApp booking-opt-in cadence (non-cutover regression guard)', () => {
  const WA_EVENT = 'booking_confirmed_player';

  beforeAll(async () => {
    await applyC();
    await c.query(`
      INSERT INTO public.notification_event_types
        (key, supports_email, supports_whatsapp, whatsapp_optin_via_booking, default_email_frequency,
         default_whatsapp_frequency, template_email)
      VALUES ('${WA_EVENT}', true, true, true, 'instant', 'off', 'booking_confirmed_player')
      ON CONFLICT (key) DO UPDATE SET supports_whatsapp = true, whatsapp_optin_via_booking = true;
      INSERT INTO public.notification_contacts
        (user_id, person_id, channel, destination_normalized, destination_redacted,
         consent_status, consent_scope, consent_trainer_id, is_primary)
      VALUES ('${USER}', '${PERSON}', 'whatsapp', '+31600000000', '•••0000',
              'opted_in', 'tenant', '${TRAINER}', true)
      ON CONFLICT DO NOTHING;`);
  });

  it('an opted-in contact still supplies the cadence when NO explicit v2 preference exists', async () => {
    await c.query(`DELETE FROM public.notification_outbox;
                   DELETE FROM public.notification_preferences_v2 WHERE event_type='${WA_EVENT}';`);
    const { rows } = await c.query(
      `SELECT channel FROM public.enqueue_notification(
         p_event_key := '${WA_EVENT}', p_recipient_user_id := $1,
         p_tenant_trainer_id := $2, p_idempotency_subject := 'wa-optin') ORDER BY channel`,
      [USER, TRAINER]);
    // WhatsApp must be present: default_whatsapp_frequency is 'off', so ONLY the opt-in branch
    // can produce this row. If C dropped that branch, only the email row appears.
    expect(rows.map((r) => r.channel)).toContain('whatsapp');
  });

  it("an EXPLICIT 'off' preference still wins over the booking opt-in", async () => {
    await c.query(`DELETE FROM public.notification_outbox`);
    await c.query(`INSERT INTO public.notification_preferences_v2
                     (user_id, event_type, email_frequency, whatsapp_frequency)
                   VALUES ($1,'${WA_EVENT}','instant','off')
                   ON CONFLICT (user_id, event_type)
                   DO UPDATE SET whatsapp_frequency='off'`, [USER]);
    const { rows } = await c.query(
      `SELECT channel FROM public.enqueue_notification(
         p_event_key := '${WA_EVENT}', p_recipient_user_id := $1,
         p_tenant_trainer_id := $2, p_idempotency_subject := 'wa-off')`, [USER, TRAINER]);
    expect(rows.map((r) => r.channel)).not.toContain('whatsapp');
    await c.query(`DELETE FROM public.notification_preferences_v2 WHERE event_type='${WA_EVENT}'`);
  });
});

// ===========================================================================
describe('C — the mandatory v1 → v2 preference backfill', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
  });

  it('carries off/instant/daily/weekly across EXACTLY, and ignores an unknown value', async () => {
    const users = ['off', 'instant', 'daily', 'weekly', 'fortnightly'];
    // THE MIRROR TRIGGER IS DISABLED FOR THE SEED, deliberately. It is already installed by the
    // time this suite runs, so a plain INSERT populates v2 through the BRIDGE — and this test
    // would then stay green with the one-time backfill deleted outright, proving nothing about
    // the migration it is named after. Disabling it makes these rows pre-existing legacy state,
    // which is exactly the world the backfill exists for.
    await c.query(`ALTER TABLE public.notification_preferences DISABLE TRIGGER trg_mirror_open_slots_pref_to_v2`);
    for (let i = 0; i < users.length; i++) {
      const u = `aaaaaaaa-0000-0000-0000-00000000000${i}`;
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [u]);
      await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,$2)`, [u, users[i]]);
    }
    await c.query(`ALTER TABLE public.notification_preferences ENABLE TRIGGER trg_mirror_open_slots_pref_to_v2`);
    expect((await c.query(
      `SELECT count(*)::int AS n FROM public.notification_preferences_v2 WHERE event_type='open_slots_player'`
    )).rows[0].n, 'the seed must reach v2 only through the backfill').toBe(0);

    await applyC();

    const { rows } = await c.query(
      `SELECT user_id, email_frequency FROM public.notification_preferences_v2
        WHERE event_type = 'open_slots_player' ORDER BY user_id`);
    // 'fortnightly' is NOT coerced into a sending cadence — it is simply not migrated.
    expect(rows.map((r) => r.email_frequency)).toEqual(['off', 'instant', 'daily', 'weekly']);
  });

  it('the BACKFILL never overwrites an explicit v2 preference', async () => {
    // Two different events, deliberately distinguished:
    //   * the one-time BACKFILL must not clobber a cadence the user already chose in v2;
    //   * a LIVE legacy write (cached bundle) is a fresh user action and DOES apply — that is
    //     the bridge trigger, asserted separately below.
    // The legacy row is seeded with the bridge DISABLED so v2 is reached only by the statement
    // under test; the v2 choice is then made explicitly. With the bridge left on, the row would
    // arrive in v2 through the trigger and the assertion would hold even with no backfill at all.
    await c.query(`ALTER TABLE public.notification_preferences DISABLE TRIGGER trg_mirror_open_slots_pref_to_v2`);
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'off')`, [USER]);
    await c.query(`ALTER TABLE public.notification_preferences ENABLE TRIGGER trg_mirror_open_slots_pref_to_v2`);
    // ...and the v2 choice is made with the REVERSE mirror disabled too. Otherwise it writes
    // straight back into v1, replacing the legacy 'off' this test exists to conflict with — the
    // backfill would then face no conflict at all and mutating its ON CONFLICT DO NOTHING into an
    // overwrite would leave this assertion green.
    await withoutReverseMirror(() =>
      c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
               VALUES ($1,'open_slots_player','daily')
               ON CONFLICT (user_id, event_type) DO UPDATE SET email_frequency='daily'`, [USER]));
    expect(
      (await c.query(`SELECT open_slots_digest FROM public.notification_preferences WHERE user_id=$1`, [USER]))
        .rows[0].open_slots_digest,
      'precondition: the legacy row must still disagree when the backfill runs',
    ).toBe('off');
    await applyC();
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2 WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email_frequency).toBe('daily');   // NOT overwritten by the legacy 'off'
  });

  it('is rerun-safe: a second application creates no duplicate and no drift', async () => {
    await c.query(`ALTER TABLE public.notification_preferences DISABLE TRIGGER trg_mirror_open_slots_pref_to_v2`);
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'weekly')`, [USER]);
    await c.query(`ALTER TABLE public.notification_preferences ENABLE TRIGGER trg_mirror_open_slots_pref_to_v2`);
    await applyC();
    expect((await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2 WHERE user_id=$1 AND event_type='open_slots_player'`,
      [USER])).rows[0].email_frequency, 'the backfill, not the bridge, put this row here').toBe('weekly');
    // Reverse mirror off: otherwise this write also moves v1 to 'off', and the rerun then has
    // nothing to drift FROM — an overwriting backfill would still leave 'off' behind.
    await withoutReverseMirror(() =>
      c.query(`UPDATE public.notification_preferences_v2 SET email_frequency='off'
                WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]));
    expect(
      (await c.query(`SELECT open_slots_digest FROM public.notification_preferences WHERE user_id=$1`, [USER]))
        .rows[0].open_slots_digest,
      'precondition: the legacy row must still say weekly, so a drifting rerun would show',
    ).toBe('weekly');
    await applyC();   // rerun
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2 WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows).toHaveLength(1);                 // no duplicate
    expect(rows[0].email_frequency).toBe('off');  // no drift: the rerun did not resurrect 'weekly'
  });

  it('BRIDGE: a cached bundle writing the v1 column mirrors forward into v2', async () => {
    // Without this, the removed-from-the-UI v1 column could still be written by a cached page
    // while delivery read only v2 — the settings would say the opposite of what happens.
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'off')`, [USER]);
    let { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].email_frequency).toBe('off');

    await c.query(`UPDATE public.notification_preferences SET open_slots_digest='weekly' WHERE user_id=$1`, [USER]);
    ({ rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]));
    expect(rows[0].email_frequency).toBe('weekly');
  });

  it('BRIDGE: an unknown legacy cadence is ignored, never coerced into sending', async () => {
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'fortnightly')`, [USER]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].n).toBe(0);
  });

  it('BRIDGE: a cached opt-out INSERT applies even when a v2 row already exists', async () => {
    // The asymmetry that makes this correct: a user can hold a v2 row and NO v1 row (the v2
    // page writes v2 directly, and the backfill only creates v2 where v1 existed). A cached
    // page's opt-out then arrives as an INSERT, and a blanket DO NOTHING would discard it — the
    // settings UI reporting success while delivery keeps mailing.
    await seedV2PreJ('daily');
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'off')`, [USER]);
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].email_frequency, 'an explicit opt-out must never be discarded').toBe('off');
  });

  it("BRIDGE: an INSERT of the column DEFAULT still cannot overwrite an opt-out", async () => {
    // The other direction, and the reason the INSERT branch is value-dependent rather than
    // simply DO UPDATE. The settings page upserts a PARTIAL row when the user changes any OTHER
    // legacy control; open_slots_digest then takes its column default. Mirroring that would
    // resume mail for someone who had opted out.
    // Pin the PRODUCTION declaration, not the fixture's. The fixture creates this table itself,
    // so querying information_schema alone only proves the fixture agrees with itself: if
    // production's default became 'daily', that check would stay green while a partial legacy
    // INSERT started taking the trigger's UPDATE branch and overwriting an explicit v2 'off'.
    const prodDdl = readFileSync(
      join(process.cwd(), 'supabase', 'migrations',
        '20260210090026_6e534231-28a9-46ef-9065-7a16c9ccdea5.sql'), 'utf8');
    const declared = /open_slots_digest\s+text\s+NOT NULL\s+DEFAULT\s+'([a-z]+)'/.exec(prodDdl);
    expect(declared, 'the production column declaration must be findable').not.toBeNull();
    expect(declared![1], 'the whole discrimination rests on this default being the ambiguous one')
      .toBe('weekly');
    // ...and the fixture must not drift from it, or every other assertion here is about a
    // different table from the one that ships.
    const { rows: def } = await c.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema='public' AND table_name='notification_preferences'
          AND column_name='open_slots_digest'`);
    expect(def[0].column_default).toContain(`'${declared![1]}'`);

    await seedV2PreJ('off');
    // no open_slots_digest given → the column default applies
    await c.query(`INSERT INTO public.notification_preferences (user_id) VALUES ($1)`, [USER]);
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].email_frequency, 'the incidental default must not resume mail').toBe('off');
  });

  it("BRIDGE: the price of that rule — a genuine cached 'weekly' is lost over instant/daily", async () => {
    // Stated as a test rather than left in a comment, because it is a REAL cost and the earlier
    // justification ("can only fail towards less mail") was simply wrong: over an existing
    // 'instant' or 'daily' the ignored 'weekly' leaves MORE mail than the user asked for.
    // It is accepted anyway — the alternative lets the incidental default overwrite an explicit
    // 'off', and a wrong cadence is still consented mail whereas mail after an opt-out is not.
    for (const existing of ['instant', 'daily']) {
      await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
      await seedV2PreJ(existing);
      await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest)
                     VALUES ($1,'weekly')`, [USER]);
      const { rows } = await c.query(
        `SELECT email_frequency FROM public.notification_preferences_v2
          WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
      expect(rows[0].email_frequency, `existing ${existing} is kept, not lowered to weekly`)
        .toBe(existing);
    }
  });

  it('NO WINDOW: the bridge ships in the SAME migration as the backfill, ahead of it', async () => {
    // The defect this closes: with the trigger installed by a LATER migration, every legacy
    // write landing between the backfill and the trigger was recorded by neither, and that
    // user's preference was silently lost. Two independent proofs, because either alone is weak.
    //
    // 1. BEHAVIOURAL — applying only the backfill migration is enough to make the bridge live.
    //    If the trigger moved back out into a later file, this write would not mirror.
    await c.query(`DROP TRIGGER IF EXISTS trg_mirror_open_slots_pref_to_v2 ON public.notification_preferences`);
    await c.query(MIG('20261011100000_notif_10cb_resolver_open_slots_digest.sql'));
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'off')`, [USER]);
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0]?.email_frequency, 'the bridge must be live as soon as the backfill has run').toBe('off');

    // 2. ORDER WITHIN THE FILE — CREATE TRIGGER takes a lock that blocks concurrent writers
    //    until the migration commits, so creating it BEFORE the backfill is what leaves no
    //    instant at which a v1 write is unobserved. Reversing the two statements would restore
    //    the window while leaving proof 1 green, so the order is pinned explicitly.
    const sql = MIG('20261011100000_notif_10cb_resolver_open_slots_digest.sql');
    const triggerAt = sql.indexOf('CREATE TRIGGER trg_mirror_open_slots_pref_to_v2');
    const backfillAt = sql.indexOf("SELECT np.user_id, 'open_slots_player', np.open_slots_digest");
    expect(triggerAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(triggerAt, 'the mirror trigger must be created before the one-time backfill runs')
      .toBeLessThan(backfillAt);
  });

  it('no legacy row → no v2 row, so the reviewed catalog weekly default governs', async () => {
    await applyC();
    const { rows } = await c.query(
      `SELECT 1 FROM public.notification_preferences_v2 WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows).toHaveLength(0);
    const { rows: cat } = await c.query(
      `SELECT default_email_frequency FROM public.notification_event_types WHERE key='open_slots_player'`);
    expect(cat[0].default_email_frequency).toBe('weekly');
  });
});

// ===========================================================================
describe('C — engine-off produces an inert, auditable outcome (no backlog)', () => {
  beforeEach(async () => {
    // v1 is cleared with v2: they are mirrors now, and applyC() re-runs the one-time
    // backfill, so a surviving legacy row would be copied back into v2 as a preference
    // this test never set.
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;`);
    await applyC();
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=false WHERE key='open_slots_player'`);
  });

  it('weekly + engine OFF → skipped/digest_engine_disabled, invisible to BOTH workers', async () => {
    const rows = await enqueue('na:2026-08-10', ITEM);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('digest_engine_disabled');

    const { rows: o } = await c.query(`SELECT * FROM public.notification_outbox`);
    expect(o).toHaveLength(1);
    // invisible to the INSTANT worker (it claims status='pending')
    expect(o[0].status).not.toBe('pending');
    // invisible to the MATERIALIZER (it scans delivery_mode='digest')
    expect(o[0].delivery_mode).toBeNull();
    expect(o[0].digest_group_hash).toBeNull();
    expect(o[0].digest_item).toBeNull();
    expect(o[0].digest_boundary_at).toBeNull();
  });

  it('is scheduled NOW, not into the future — there is nothing that can burst later', async () => {
    await enqueue('na:burst', ITEM);
    const { rows } = await c.query(
      `SELECT scheduled_for <= now() AS not_future FROM public.notification_outbox`);
    expect(rows[0].not_future).toBe(true);
  });

  it('enabling the engine afterwards does NOT resurrect the skipped row', async () => {
    await enqueue('na:pre-enable', ITEM);
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=true WHERE key='open_slots_player'`);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM public.notification_outbox WHERE delivery_mode='digest'`);
    expect(rows[0].n).toBe(0);   // future events only
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=false WHERE key='open_slots_player'`);
  });

  it("preference 'off' emits nothing at all", async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','off')`, [USER]);
    const rows = await enqueue('na:off', ITEM);
    expect(rows).toHaveLength(0);
    const { rows: o } = await c.query(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(o[0].n).toBe(0);
  });

  it("preference 'instant' emits a normal instant row with NO digest fields", async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','instant')`, [USER]);
    const rows = await enqueue('na:instant', ITEM);
    expect(rows[0].status).toBe('pending');
    const { rows: o } = await c.query(`SELECT * FROM public.notification_outbox`);
    expect(o[0].delivery_mode).toBeNull();
    expect(o[0].digest_boundary_at).toBeNull();
    expect(o[0].digest_item).toBeNull();
    expect(o[0].skip_reason).toBeNull();
  });
});

// ===========================================================================
describe('C — engine ON mints one complete digest member', () => {
  beforeEach(async () => {
    // v1 is cleared with v2: they are mirrors now, and applyC() re-runs the one-time
    // backfill, so a surviving legacy row would be copied back into v2 as a preference
    // this test never set.
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;`);
    await applyC();
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=true WHERE key='open_slots_player'`);
  });
  afterAll(async () => {
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=false WHERE key='open_slots_player'`);
  });

  it('freezes the complete canonical snapshot and lets the TRIGGER derive hash + bytes', async () => {
    await enqueue('na:2026-08-10', ITEM);
    const { rows } = await c.query(`SELECT * FROM public.notification_outbox`);
    const m = rows[0];
    expect(m.status).toBe('pending');
    expect(m.delivery_mode).toBe('digest');
    expect(m.digest_frequency).toBe('weekly');
    expect(m.recipient_key).toBe(`p:${PERSON}`);              // ADR §M1 prefixed key
    expect(m.group_locale).toBe('nl');                        // persons.preferred_language
    expect(m.recipient_timezone).toBe('Europe/Amsterdam');    // §TZ trainer fallback
    expect(m.template_version).toBe(1);
    expect(m.digest_boundary_at).not.toBeNull();
    // server-derived, never caller-supplied
    expect(m.destination_fingerprint).toHaveLength(64);
    expect(m.digest_group_hash).toHaveLength(64);
    expect(m.digest_item_bytes).toBeGreaterThan(0);
    // the item came from the TRUSTED renderer, with its rendered copy inside the frozen snapshot
    expect(m.digest_item.event).toBe('open_slots_player');
    expect(m.digest_item.subtype).toBe('new_availability');
    expect(m.digest_item.locale).toBe('nl');
    expect(m.digest_item.title).toContain('Coach Ana');
    // digest_item_bytes is derived by the trigger as octet_length(digest_item::text) — assert against
    // the SERVER's own rendering, not JSON.stringify (jsonb::text spaces after ':' and ',' differ).
    const { rows: b } = await c.query(
      `SELECT octet_length(digest_item::text) AS derived, digest_item_bytes FROM public.notification_outbox`);
    expect(b[0].digest_item_bytes).toBe(b[0].derived);
  });

  it('a caller-supplied digest_item_bytes is silently CORRECTED by the trigger', async () => {
    await enqueue('na:bytes', ITEM);
    const { rows: before } = await c.query(`SELECT id, digest_item_bytes FROM public.notification_outbox`);
    await c.query(`UPDATE public.notification_outbox SET digest_item_bytes = 1 WHERE id = $1`, [before[0].id]);
    const { rows: after } = await c.query(
      `SELECT digest_item_bytes, octet_length(digest_item::text) AS derived FROM public.notification_outbox`);
    expect(after[0].digest_item_bytes).toBe(after[0].derived);
    expect(after[0].digest_item_bytes).not.toBe(1);
  });

  it('the boundary is the next Monday 09:00 local for weekly', async () => {
    await enqueue('na:boundary', ITEM);
    const { rows } = await c.query(`
      SELECT to_char(digest_boundary_at AT TIME ZONE recipient_timezone, 'Dy HH24:MI') AS local
        FROM public.notification_outbox`);
    expect(rows[0].local).toBe('Mon 09:00');
  });

  it('re-enqueueing the same subject is idempotent — one member, not two', async () => {
    await enqueue('na:idem', ITEM);
    const second = await enqueue('na:idem', ITEM);
    expect(second).toHaveLength(0);           // ON CONFLICT DO NOTHING → no new row
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(rows[0].n).toBe(1);
  });

  it('refuses edge-supplied rendered copy: only structured fields are accepted', async () => {
    // A caller trying to inject its own title/body cannot: the renderer reads `data` only.
    await enqueue('na:inject', { subtype: 'new_availability', title: '<b>pwn</b>',
      data: { trainer_name: 'Coach Ana', date_from: '2026-08-10' } });
    const { rows } = await c.query(`SELECT digest_item FROM public.notification_outbox`);
    expect(rows[0].digest_item.title).not.toContain('pwn');
    expect(rows[0].digest_item.title).toContain('Coach Ana');
  });

  it('a missing subtype is REFUSED rather than silently rendered', async () => {
    await expect(enqueue('na:nosubtype', { data: { trainer_name: 'Coach Ana' } }))
      .rejects.toThrow(/subtype/i);
  });
});

// ===========================================================================
// The instant worker and the digest engine must never contend for one row. A digest member is
// written status='pending' with scheduled_for = its digest boundary, and materialization does
// NOT make it non-pending — so without an explicit delivery_mode predicate the instant claim
// would sweep up every digest member the moment its boundary passed, either terminal-failing it
// (no subject/html) or sending it individually. Found in review of this slice.
describe('C — the INSTANT claim never touches a digest member', () => {
  beforeEach(async () => {
    // v1 is cleared with v2: they are mirrors now, and applyC() re-runs the one-time
    // backfill, so a surviving legacy row would be copied back into v2 as a preference
    // this test never set.
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;`);
    await applyC();
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=true WHERE key='open_slots_player'`);
  });
  afterAll(async () => {
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=false WHERE key='open_slots_player'`);
  });

  const claim = async () => (await c.query(
    `SELECT * FROM public.claim_notification_outbox_batch('email', 'instant-worker', 20, 15)`)).rows;

  it('a DUE digest member is not claimed, and stays pending for the materializer', async () => {
    await enqueue('na:race', ITEM);
    // fast-forward past the boundary — the exact moment the instant worker would grab it
    await c.query(`UPDATE public.notification_outbox SET scheduled_for = now() - interval '1 hour'
                    WHERE delivery_mode='digest'`);
    expect(await claim()).toHaveLength(0);
    const { rows } = await c.query(`SELECT status, locked_by, attempts FROM public.notification_outbox`);
    expect(rows[0].status).toBe('pending');     // untouched: no status flip
    expect(rows[0].locked_by).toBeNull();       // and no lock token stamped
    expect(rows[0].attempts).toBe(0);           // and no attempt burned
  });

  it('a legacy INSTANT row is still claimed — the narrowing is digest-only', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','instant')`, [USER]);
    await enqueue('na:instant-claimable', ITEM);
    const claimed = await claim();
    expect(claimed).toHaveLength(1);
    expect(claimed[0].event_type).toBe('open_slots_player');
  });

  it('the REAP path leaves a stuck digest member alone', async () => {
    await enqueue('na:reap', ITEM);
    await c.query(`UPDATE public.notification_outbox
                      SET status='processing', locked_at = now() - interval '2 hours',
                          attempts = max_attempts
                    WHERE delivery_mode='digest'`);
    await claim();
    const { rows } = await c.query(`SELECT status, last_error FROM public.notification_outbox`);
    expect(rows[0].status).toBe('processing');  // NOT terminal-failed by the instant worker
    expect(rows[0].last_error).toBeNull();
  });

  it('the stale-RECLAIM path leaves a digest member alone', async () => {
    await enqueue('na:reclaim', ITEM);
    await c.query(`UPDATE public.notification_outbox
                      SET status='processing', locked_at = now() - interval '2 hours', attempts = 1
                    WHERE delivery_mode='digest'`);
    expect(await claim()).toHaveLength(0);
  });

  // The predicate alone is only a RESIDUAL filter: idx_notification_outbox_due knows nothing
  // about delivery_mode, so a large DUE digest backlog would be walked and discarded to fill
  // the instant claim's LIMIT. Pin that the instant-only partial index keeps it out of the scan.
  it('a large DUE digest backlog is not scanned by the instant claim', async () => {
    await c.query(`
      INSERT INTO public.notification_outbox
        (channel, event_type, status, scheduled_for, delivery_mode, idempotency_key,
         destination_normalized, recipient_user_id, payload,
         recipient_key, destination_fingerprint, digest_frequency, digest_boundary_at, digest_item)
      SELECT 'email', 'open_slots_player', 'pending', now() - interval '1 hour', 'digest',
             'bulk:' || g, 'p@example.com', '${USER}', '{}'::jsonb,
             'p:${PERSON}', repeat('a', 64), 'weekly', now() - interval '1 hour',
             jsonb_build_object('v',1,'event','open_slots_player','subtype','new_availability',
                                'locale','en','title','t','body','b')
        FROM generate_series(1, 20000) g;
      INSERT INTO public.notification_outbox
        (channel, event_type, status, scheduled_for, idempotency_key,
         destination_normalized, recipient_user_id, payload)
      SELECT 'email', 'open_slots_player', 'pending', now() - interval '1 minute',
             'inst:' || g, 'p@example.com', '${USER}', '{}'::jsonb
        FROM generate_series(1, 5) g;
      -- ELIGIBLE stale reclaim: non-digest 'processing' rows past the stale window with retries
      -- left. These are what actually exercise the second arm of the OR — the digest rows below
      -- cannot, because they fail the outer predicate and are absent from the partial index.
      INSERT INTO public.notification_outbox
        (channel, event_type, status, scheduled_for, idempotency_key,
         destination_normalized, recipient_user_id, payload, locked_at, attempts, max_attempts)
      SELECT 'email', 'open_slots_player', 'processing', now() - interval '4 hours',
             'stale-inst:' || g, 'p@example.com', '${USER}', '{}'::jsonb,
             now() - interval '2 hours', 1, 5
        FROM generate_series(1, 10) g;
      -- NEGATIVE backlog coverage: stale-LOOKING digest rows that must be excluded entirely,
      -- not merely filtered out row by row.
      INSERT INTO public.notification_outbox
        (channel, event_type, status, scheduled_for, delivery_mode, idempotency_key,
         destination_normalized, recipient_user_id, payload, locked_at, attempts, max_attempts,
         recipient_key, destination_fingerprint, digest_frequency, digest_boundary_at, digest_item)
      SELECT 'email', 'open_slots_player', 'processing', now() - interval '3 hours', 'digest',
             'stale:' || g, 'p@example.com', '${USER}', '{}'::jsonb,
             now() - interval '2 hours', 1, 5,
             'p:${PERSON}', repeat('a', 64), 'weekly', now() - interval '3 hours',
             jsonb_build_object('v',1,'event','open_slots_player','subtype','new_availability',
                                'locale','en','title','t','body','b')
        FROM generate_series(1, 5000) g;
      ANALYZE public.notification_outbox;`);

    // EXPLAIN the DEPLOYED query, extracted from pg_get_functiondef — not a hand-written
    // lookalike, which could silently drift from the RPC it claims to pin.
    const due = await extractDueQuery();
    const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${due}`);
    const plan = rows[0]['QUERY PLAN'][0].Plan;

    expect(indexNames(plan)).toContain('idx_notification_outbox_due_instant');
    // the 20000 due digest rows are never walked and discarded
    expect(worstRowsRemoved(plan)).toBeLessThan(1000);

    // POSITIVE stale coverage: the query really returns eligible reclaim rows, so the second
    // arm of the OR is proven to work — not merely proven not to crash. 5 fresh + 10 stale.
    const { rows: got } = await c.query(due);
    expect(got).toHaveLength(15);
    const { rows: kinds } = await c.query(
      `SELECT status, count(*)::int AS n FROM public.notification_outbox
        WHERE id = ANY($1::uuid[]) GROUP BY status ORDER BY status`,
      [got.map((r: { id: string }) => r.id)]);
    expect(kinds).toEqual([{ status: 'pending', n: 5 }, { status: 'processing', n: 10 }]);
  }, 180_000);

  // ── H: the DEFERRED measurement from C ──────────────────────────────────────────────────
  // C shipped idx_notification_outbox_due_instant and deferred one question: the stale-reclaim
  // arm of the OR is only PARTIALLY served by it. `locked_at` and `attempts` are not in any
  // index, so they stay residual filters, and the agreement was not to drop or narrow the old
  // `idx_notification_outbox_due` until that arm was measured. This is the measurement.
  //
  // The pathological shape is realistic and self-inflicted: the instant worker sets
  // status='processing', locked_at=now() on every row it claims. A slow or backed-up worker
  // therefore leaves many NON-digest 'processing' rows that ARE in the partial index (they pass
  // channel + status + delivery_mode) and fail only the residual `locked_at < stale` test. With
  // ORDER BY scheduled_for and an old scheduled_for, they sort FIRST and are walked and
  // discarded before the claim can fill its LIMIT.
  it('MEASURES the stale-reclaim arm: recently-locked rows are residual, and how costly', async () => {
    await c.query(`TRUNCATE public.notification_outbox CASCADE;`);
    await c.query(`
      -- 20k in-flight rows: non-digest, 'processing', OLD scheduled_for (so they sort first),
      -- but locked SECONDS ago — ineligible for reclaim on the residual filter alone.
      INSERT INTO public.notification_outbox
        (channel, event_type, status, scheduled_for, idempotency_key,
         destination_normalized, recipient_user_id, payload, locked_at, attempts, max_attempts)
      SELECT 'email', 'open_slots_player', 'processing', now() - interval '6 hours',
             'inflight:' || g, 'p@example.com', '${USER}', '{}'::jsonb,
             now() - interval '10 seconds', 1, 5
        FROM generate_series(1, 20000) g;
      -- the work that SHOULD be claimed, scheduled AFTER all of the above
      INSERT INTO public.notification_outbox
        (channel, event_type, status, scheduled_for, idempotency_key,
         destination_normalized, recipient_user_id, payload)
      SELECT 'email', 'open_slots_player', 'pending', now() - interval '1 minute',
             'want:' || g, 'p@example.com', '${USER}', '{}'::jsonb
        FROM generate_series(1, 5) g;
      ANALYZE public.notification_outbox;`);

    const due = await extractDueQuery();
    const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${due}`);
    const plan = rows[0]['QUERY PLAN'][0].Plan;
    const removed = worstRowsRemoved(plan);

    // CORRECTNESS FIRST — whatever it costs, it must return the right rows. A slow plan that is
    // still correct is a capacity decision; a fast plan that is wrong is an outage.
    const { rows: got } = await c.query(due);
    expect(got).toHaveLength(5);

    // THE MEASUREMENT, asserted rather than merely printed so it cannot rot. The residual cost
    // is REAL: the in-flight rows are scanned and discarded. This is the number the deferral
    // asked for, and it is why idx_notification_outbox_due must NOT be dropped or narrowed as
    // part of 10c-b — neither index helps this arm (neither carries locked_at/attempts), so
    // removing one would change nothing here while removing cover from every other consumer.
    // Serving this arm properly needs its own partial index, which is a separate, measured
    // change against production statistics, not a drive-by in a digest cutover.
    //
    // MEASURED RESULT (this shape, 20005 rows): 20000 rows removed by filter and NO index used
    // at all — the planner falls back to a SEQUENTIAL SCAN. That is worse than "partially
    // served": under an in-flight backlog this arm is unindexed, full stop.
    expect(removed).toBeGreaterThanOrEqual(20000);
    expect(indexNames(plan), 'the stale-reclaim arm is UNINDEXED in this shape — if this now uses an index, the measurement below is stale and the decision must be revisited').toEqual([]);
    console.log(`[H] stale-reclaim residual: ${removed} rows removed by filter over a 20000-row in-flight backlog; indexes used: ${JSON.stringify(indexNames(plan))}`);
  }, 180_000);
});

// ===========================================================================
describe('C — §BND boundaries are DST-correct', () => {
  beforeAll(async () => { await applyC(); });

  const boundary = async (now: string, freq: string, tz = 'Europe/Amsterdam') => {
    const { rows } = await c.query(
      `SELECT to_char(public.notif_digest_boundary_at($1::timestamptz,$2,$3) AT TIME ZONE $3,
              'YYYY-MM-DD Dy HH24:MI') AS local,
              public.notif_digest_boundary_at($1::timestamptz,$2,$3) AS abs`, [now, freq, tz]);
    return rows[0];
  };

  it('daily: before 09:00 local lands TODAY, after 09:00 lands TOMORROW', async () => {
    expect((await boundary('2026-08-10 06:00:00+02', 'daily')).local).toBe('2026-08-10 Mon 09:00');
    expect((await boundary('2026-08-10 10:00:00+02', 'daily')).local).toBe('2026-08-11 Tue 09:00');
  });

  it('daily across the MARCH spring-forward keeps 09:00 LOCAL (not +24h absolute)', async () => {
    // 2026-03-29 is the EU spring-forward. 10:00 local on the 28th → 09:00 local on the 29th.
    const r = await boundary('2026-03-28 10:00:00+01', 'daily');
    expect(r.local).toBe('2026-03-29 Sun 09:00');
    // and that instant is 07:00Z (CEST, +02), NOT 08:00Z — proving wall-clock arithmetic.
    expect(new Date(r.abs).toISOString()).toBe('2026-03-29T07:00:00.000Z');
  });

  it('daily across the OCTOBER fall-back keeps 09:00 LOCAL', async () => {
    // 2026-10-25 is the EU fall-back. 10:00 local on the 24th → 09:00 local on the 25th = 08:00Z (CET).
    const r = await boundary('2026-10-24 10:00:00+02', 'daily');
    expect(r.local).toBe('2026-10-25 Sun 09:00');
    expect(new Date(r.abs).toISOString()).toBe('2026-10-25T08:00:00.000Z');
  });

  it('weekly always lands on a MONDAY 09:00 local, including across a DST change', async () => {
    for (const now of ['2026-03-25 12:00:00+01', '2026-08-10 08:00:00+02', '2026-10-22 12:00:00+02']) {
      const r = await boundary(now, 'weekly');
      expect(r.local).toMatch(/ Mon 09:00$/);
    }
    // Monday 08:00 local is BEFORE the boundary → same day, not next week.
    expect((await boundary('2026-08-10 08:00:00+02', 'weekly')).local).toBe('2026-08-10 Mon 09:00');
    // Monday 10:00 local is AFTER → next Monday.
    expect((await boundary('2026-08-10 10:00:00+02', 'weekly')).local).toBe('2026-08-17 Mon 09:00');
  });

  it('a non-Amsterdam timezone is honoured (it is canonical-key identity)', async () => {
    expect((await boundary('2026-08-10 06:00:00+00', 'daily', 'Asia/Tokyo')).local).toBe('2026-08-11 Tue 09:00');
  });

  it('rejects a frequency that is not daily/weekly', async () => {
    await expect(boundary('2026-08-10 06:00:00+02', 'instant')).rejects.toThrow(/daily or weekly/);
  });

  // PROPERTY TEST. The two invariants the state machine actually depends on, swept across
  // zones chosen to be hostile: Pacific/Apia skipped an entire calendar day (2011-12-30),
  // Lord_Howe runs 30-minute DST, Chatham sits at :45, Troll jumps two hours at once, and
  // Kiritimati crossed the date line. If a zone rule ever put a DST gap over 09:00, the
  // function's fail-closed post-condition raises rather than minting a bad group identity —
  // so this sweep would fail loudly instead of silently drifting the boundary.
  it('boundary is always >= now AND always exactly 09:00 local, across hostile timezones', async () => {
    const zones = ['Europe/Amsterdam', 'Pacific/Apia', 'Australia/Lord_Howe', 'Asia/Kathmandu',
      'America/Santiago', 'Pacific/Chatham', 'Asia/Tehran', 'America/Havana',
      'Antarctica/Troll', 'Pacific/Kiritimati'];
    const { rows } = await c.query(`
      SELECT count(*)::int                                        AS checked,
             count(*) FILTER (WHERE b <  n)::int                  AS not_monotone,
             count(*) FILTER (WHERE to_char(b AT TIME ZONE z,'HH24:MI') <> '09:00')::int AS not_nine,
             count(*) FILTER (WHERE f = 'weekly'
                                AND extract(isodow FROM (b AT TIME ZONE z)) <> 1)::int   AS not_monday,
             -- MINIMALITY: no earlier valid boundary of the same cadence may exist. Stepping
             -- back one cadence must land strictly before now (else we skipped a valid slot).
             -- ...but only counts as a counter-example if that earlier wall time actually
             -- EXISTS. Apia's skipped 2011-12-30 09:00 round-trips to the 31st, so it is not
             -- an earlier valid boundary at all.
             count(*) FILTER (WHERE prev_exists AND prev_abs >= n)::int                  AS not_minimal
        FROM (
          SELECT b, n, z, f,
                 (prev_local AT TIME ZONE z)                       AS prev_abs,
                 ((prev_local AT TIME ZONE z) AT TIME ZONE z) = prev_local AS prev_exists
            FROM (
              SELECT b, n, z, f,
                     (b AT TIME ZONE z)
                       - (CASE WHEN f='daily' THEN interval '1 day' ELSE interval '7 days' END) AS prev_local
                FROM (
                  SELECT public.notif_digest_boundary_at(n, f, z) AS b, n, z, f
                    FROM unnest($1::text[]) z,
                         unnest(ARRAY['daily','weekly']) f,
                         generate_series(0, 419) d,
                         LATERAL (SELECT '2011-01-01T00:00:00Z'::timestamptz + (d * 3 || ' days')::interval AS n) s
                ) raw
            ) p
        ) t`, [zones]);
    expect(rows[0].checked).toBe(8400);
    expect(rows[0].not_monotone).toBe(0);
    expect(rows[0].not_nine).toBe(0);
    expect(rows[0].not_monday).toBe(0);   // weekly stays Monday even across a skipped day
    expect(rows[0].not_minimal).toBe(0);  // and is the EARLIEST qualifying boundary
  }, 120_000);

  it('a SKIPPED CALENDAR DAY resolves forward to the next real 09:00, still monotone', async () => {
    // Pacific/Apia skipped all of 2011-12-30 crossing the date line, so `2011-12-30 09:00`
    // is not a real instant. This is the case a naive round-trip check would either miss
    // (the local TIME still reads 09:00 — the trap) or wrongly reject.
    // 2011-12-29T20:00Z is 10:00 local in Apia (offset was still -10), i.e. past that day's
    // 09:00 — so the daily candidate is 2011-12-30 09:00, the wall time that never happened.
    const r = await boundary('2011-12-29 20:00:00+00', 'daily', 'Pacific/Apia');
    expect(r.local).toBe('2011-12-31 Sat 09:00');   // the 30th does not exist; forward to the 31st
    expect(new Date(r.abs).getTime()).toBeGreaterThanOrEqual(new Date('2011-12-29T20:00:00Z').getTime());
  });
});

// ===========================================================================
describe('C — THE BLAST-RADIUS RULE: supports_digest alone changes nothing', () => {
  const OTHER = 'session_reminder_player';
  beforeAll(async () => {
    await applyC();
    await c.query(`
      INSERT INTO public.notification_event_types (key, supports_digest, supports_email, default_email_frequency, template_email)
      VALUES ('${OTHER}', true, true, 'instant', 'session_reminder_player')
      ON CONFLICT (key) DO UPDATE SET supports_digest=true, supports_email=true`);
  });
  beforeEach(async () => {
    await c.query(`DELETE FROM public.notification_outbox;
                   DELETE FROM public.notification_preferences_v2 WHERE event_type='${OTHER}';`);
  });

  it('the eight supports_digest events are NOT cutover events', async () => {
    const { rows } = await c.query(
      `SELECT key FROM public.notification_event_types WHERE supports_digest AND digest_cutover ORDER BY key`);
    expect(rows.map((r) => r.key)).toEqual(['open_slots_player']);
  });

  it('a weekly preference on a supports_digest NON-cutover event still yields the LEGACY delayed instant row', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'${OTHER}','weekly')`, [USER]);
    await c.query(
      `SELECT * FROM public.enqueue_notification(p_event_key := '${OTHER}', p_recipient_user_id := $1,
         p_tenant_trainer_id := $2, p_idempotency_subject := 'legacy-path')`, [USER, TRAINER]);
    const { rows } = await c.query(`SELECT * FROM public.notification_outbox`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');          // NOT skipped — behavior preserved
    expect(rows[0].skip_reason).toBeNull();
    expect(rows[0].delivery_mode).toBeNull();        // NOT a digest member
    // the legacy branch: next week + 8h, exactly as before C
    const { rows: sched } = await c.query(
      `SELECT scheduled_for = date_trunc('week', created_at) + interval '7 days' + interval '8 hours' AS legacy
         FROM public.notification_outbox`);
    expect(sched[0].legacy).toBe(true);
  });

  it('the cutover flag cannot be set on an event that does not support digest', async () => {
    await expect(c.query(
      `INSERT INTO public.notification_event_types (key, supports_digest, digest_cutover)
       VALUES ('bogus_event', false, true)`)).rejects.toThrow(/chk_event_types_cutover_implies_supports_digest/);
  });
});

// ===========================================================================
describe('C — §PS event stop policy for open slots', () => {
  let memberId: string;
  beforeEach(async () => {
    await c.query(`DELETE FROM public.notification_outbox;
                   DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;
                   UPDATE public.trainer_followers SET notify_new_availability=true
                     WHERE player_id='${PROFILE}' AND trainer_id='${TRAINER}';`);
    await applyC();
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=true WHERE key='open_slots_player'`);
    await enqueue('na:stop', ITEM);
    const { rows } = await c.query(`SELECT id FROM public.notification_outbox LIMIT 1`);
    memberId = rows[0].id;
  });
  afterAll(async () => {
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=false WHERE key='open_slots_player'`);
  });

  const stop = async () => (await c.query(
    `SELECT public.notif_digest_member_stop_reason($1) AS r`, [memberId])).rows[0].r;

  it('a live, still-following member does not stop', async () => {
    expect(await stop()).toBeNull();
  });

  it('muting notify_new_availability STOPS the member', async () => {
    await c.query(`UPDATE public.trainer_followers SET notify_new_availability=false
                    WHERE player_id='${PROFILE}' AND trainer_id='${TRAINER}'`);
    expect(await stop()).toBe('follow_revoked');
  });

  it('unfollowing entirely STOPS the member', async () => {
    await c.query(`DELETE FROM public.trainer_followers WHERE player_id='${PROFILE}' AND trainer_id='${TRAINER}'`);
    expect(await stop()).toBe('follow_revoked');
    await c.query(`INSERT INTO public.trainer_followers (player_id,trainer_id,notify_new_availability)
                   VALUES ('${PROFILE}','${TRAINER}',true)`);
  });

  it('a changed contact email STOPS the member (frozen fingerprint no longer matches)', async () => {
    await c.query(`UPDATE public.notification_contacts SET destination_normalized='new@example.com'
                    WHERE user_id='${USER}'`);
    expect(await stop()).toBe('destination_changed');
    await c.query(`UPDATE public.notification_contacts SET destination_normalized='p@example.com'
                    WHERE user_id='${USER}'`);
  });

  it('hard suppression STOPS the member', async () => {
    await c.query(`INSERT INTO public.email_suppression_stub (email) VALUES ('p@example.com')`);
    expect(await stop()).toBe('suppressed');
    await c.query(`DELETE FROM public.email_suppression_stub`);
  });

  it("turning the preference to 'off' STOPS the member", async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','off')`, [USER]);
    expect(await stop()).toBe('preference_off');
  });
});

// ===========================================================================
// 10c-b D — the notify-followers cutover's concurrency contract, proven against real Postgres.
//
// The route dropped its own `notification_sends` claim/release and now relies entirely on the
// resolver's idempotency key (<event>:<subject>:<recipient>). That is only safe if a retried or
// genuinely CONCURRENT invocation collapses to one logical row per follower — otherwise the
// cutover traded a working dedup for a re-spam.
describe('D — notify-followers dedup rests on the resolver idempotency key', () => {
  beforeEach(async () => {
    // v1 is cleared with v2: they are mirrors now, and applyC() re-runs the one-time
    // backfill, so a surviving legacy row would be copied back into v2 as a preference
    // this test never set.
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;`);
    await applyC();
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','instant')
                   ON CONFLICT (user_id,event_type) DO UPDATE SET email_frequency='instant'`, [USER]);
  });

  const SUBJECT = 'na:2026-08-10:2026-08-16';

  it('a RETRY of the same event yields no second row, and returns nothing', async () => {
    const first = await enqueue(SUBJECT, ITEM);
    expect(first).toHaveLength(1);
    const retry = await enqueue(SUBJECT, ITEM);
    expect(retry).toHaveLength(0);          // classifyEnqueue -> already_existing, not failed
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(rows[0].n).toBe(1);
  });

  it('CONCURRENT invocations produce exactly ONE logical row', async () => {
    // Eight parallel connections racing the same (event, subject, recipient), the way two
    // overlapping edge invocations would.
    const conns = await Promise.all(Array.from({ length: 8 }, async () => {
      const cl = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
      await cl.connect();
      return cl;
    }));
    try {
      const results = await Promise.all(conns.map((cl) => cl.query(
        `SELECT * FROM public.enqueue_notification(
           p_event_key := 'open_slots_player', p_recipient_user_id := $1,
           p_tenant_trainer_id := $2, p_idempotency_subject := $3, p_payload := $4::jsonb)`,
        [USER, TRAINER, SUBJECT, JSON.stringify(ITEM)],
      ).then((r) => ({ rows: r.rows, err: null as string | null }))
       .catch((e) => ({ rows: [] as unknown[], err: String(e.message ?? e) }))));

      // Swallowing errors here would let "1 success + 7 crashes" pass as clean de-duplication.
      // Every invocation must SUCCEED; exactly one of them may create the row.
      const failures = results.filter((r) => r.err);
      expect(failures.map((f) => f.err)).toEqual([]);
      const created = results.reduce((n, r) => n + r.rows.length, 0);
      expect(created).toBe(1);              // exactly one invocation created the row
    } finally {
      await Promise.all(conns.map((cl) => cl.end()));
    }
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(rows[0].n).toBe(1);
  });

  it('a DIFFERENT subject is a distinct event and does notify again', async () => {
    await enqueue('na:2026-08-10:2026-08-16', ITEM);
    await enqueue('na:2026-08-17:2026-08-23', ITEM);
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(rows[0].n).toBe(2);
  });

  it('no legacy/v2 dual route: the v2 row is the ONLY record of the event', async () => {
    await enqueue(SUBJECT, ITEM);
    // notification_sends is untouched by the new route (it is retired on its own boundary in
    // 10c-d, not here) — so a row appearing in it would mean the legacy path still ran.
    // The fixture CREATES the legacy table (below, in beforeAll) precisely so this assertion
    // runs — a `to_regclass IS NOT NULL` conditional silently skipped it before, which made the
    // headline claim of this test vacuous.
    const { rows: legacy } = await c.query(`SELECT count(*)::int AS n FROM public.notification_sends`);
    expect(legacy[0].n).toBe(0);
    const { rows: v2 } = await c.query(
      `SELECT count(*)::int AS n FROM public.notification_outbox WHERE event_type='open_slots_player'`);
    expect(v2[0].n).toBe(1);
  });
});

// ===========================================================================
// D correction — an INSTANT open-slots row must be RENDERABLE.
//
// The instant email worker reads payload.subject / payload.html and terminal-fails a row that
// cannot render. Slice C rendered content only on the digest branch, so an `instant` cadence
// produced a pending row with neither field: reported as enqueued, then silently terminal-failed,
// with its idempotency key blocking the retry. C's backfill carries a legacy `instant` choice
// across verbatim, so this cadence is live for real users.
describe('D — an instant open-slots row carries server-rendered subject/html', () => {
  beforeEach(async () => {
    // v1 is cleared with v2: they are mirrors now, and applyC() re-runs the one-time
    // backfill, so a surviving legacy row would be copied back into v2 as a preference
    // this test never set.
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;`);
    await applyC();
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','instant')
                   ON CONFLICT (user_id,event_type) DO UPDATE SET email_frequency='instant'`, [USER]);
  });

  it('the payload the instant worker requires is present and server-owned', async () => {
    await enqueue('na:t1:2026-08-10:2026-08-16', ITEM);
    const { rows } = await c.query(`SELECT payload, delivery_mode, status FROM public.notification_outbox`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].delivery_mode).toBeNull();              // instant, not a digest member
    expect(typeof rows[0].payload.subject).toBe('string');
    expect(rows[0].payload.subject.length).toBeGreaterThan(0);
    expect(typeof rows[0].payload.html).toBe('string');
    // the copy came from the SAME trusted renderer the digest uses
    expect(rows[0].payload.subject).toContain('Coach Ana');
    expect(rows[0].payload.html).toContain('Coach Ana');
    // and the structured fields the caller sent survive alongside it
    expect(rows[0].payload.subtype).toBe('new_availability');
  });

  it('the rendered html ESCAPES the trainer name and carries the opt-out route', async () => {
    // Assert on the PAYLOAD the resolver produced, not on the escape helper in isolation —
    // removing the escape calls from notif_open_slots_instant_payload would leave a
    // helper-only test green while production emitted raw markup.
    const { rows } = await c.query(
      `SELECT public.notif_open_slots_instant_payload(
         jsonb_build_object('title','A <b>bold</b> & "risky" name', 'body','body & more')) AS p`);
    const html = rows[0].p.html as string;
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<b>bold</b>');
    // the legacy template's primary action AND opt-out route must survive the cutover
    expect(html).toContain('Book Now');
    expect(html).toContain('/app/player/settings/notifications');
    expect(rows[0].p.subject).toBe('A <b>bold</b> & "risky" name');
  });

  it('a DIGEST row still carries no subject/html — rendering happens at send time there', async () => {
    await c.query(`UPDATE public.notification_preferences_v2 SET email_frequency='weekly'
                    WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=true WHERE key='open_slots_player'`);
    await enqueue('na:t1:digest', ITEM);
    const { rows } = await c.query(`SELECT payload, delivery_mode, digest_item FROM public.notification_outbox`);
    expect(rows[0].delivery_mode).toBe('digest');
    expect(rows[0].payload.subject).toBeUndefined();
    expect(rows[0].digest_item).not.toBeNull();
    await c.query(`UPDATE public.notification_event_types SET digest_engine_enabled=false WHERE key='open_slots_player'`);
  });
});

// ===========================================================================
describe('D — ACL: the instant worker can call the stop policy, other helpers stay locked', () => {
  beforeAll(async () => { await applyC(); });

  it('service_role can execute ONLY the complete policy, not the event hook', async () => {
    // The worker calls notif_digest_member_stop_reason, which is SECURITY DEFINER and invokes
    // the event hook as its owner. Granting the hook too would widen the allowlist for no caller.
    const q = async (sig: string) => (await c.query(
      `SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [sig])).rows[0].ok;
    expect(await q('public.notif_digest_member_stop_reason(uuid)')).toBe(true);
    expect(await q('public.notif_digest_event_stop_reason(uuid)')).toBe(false);
  });

  it('the other new helpers remain revoked from service_role', async () => {
    // Round-8 posture: only the top-level SECURITY DEFINER RPCs may invoke these, so a forged
    // direct service_role call cannot bypass run/ownership/ledger invariants. The stop-policy
    // helper above is the deliberate exception — it is a pure read that mutates nothing.
    for (const sig of [
      'public.notif_digest_boundary_at(timestamptz,text,text)',
      'public.notif_digest_recipient_timezone(uuid,uuid)',
      'public.notif_digest_group_locale(uuid,uuid)',
      'public.notif_digest_item_for_event(text,text,jsonb)',
      'public.notif_open_slots_instant_payload(jsonb)',
      'public.notif_open_slots_escape_html(text)',
      'public.notif_digest_event_stop_reason(uuid)',
    ]) {
      const { rows } = await c.query(
        `SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS ok`, [sig]);
      expect(rows[0].ok, `${sig} must stay revoked from service_role`).toBe(false);
    }
  });
});

// ===========================================================================
// D correction — the INSTANT path must be protected by the FULL live policy.
//
// The review found two halves of one defect: the worker consulted only the event hook, AND
// instant rows carried a NULL destination_fingerprint, which makes
// notif_digest_member_stop_reason's `IF destination_fingerprint IS NOT NULL` check silently
// no-op. Together they meant an instant row would deliver to the FROZEN OLD address after a
// user changed their email, and would ignore contact revocation and preference-off entirely.
describe('D — instant rows are covered by the complete live send policy', () => {
  let memberId: string;
  beforeEach(async () => {
    // v1 is cleared with v2: they are mirrors now, and applyC() re-runs the one-time
    // backfill, so a surviving legacy row would be copied back into v2 as a preference
    // this test never set.
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;
                   DELETE FROM public.notification_preferences;`);
    await c.query(`UPDATE public.notification_contacts SET destination_normalized='p@example.com',
                     revoked_at=NULL, consent_status='opted_in' WHERE user_id=$1 AND channel='email'`, [USER]);
    await c.query(`DELETE FROM public.email_suppression_stub`);
    await applyC();
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id,event_type,email_frequency)
                   VALUES ($1,'open_slots_player','instant')
                   ON CONFLICT (user_id,event_type) DO UPDATE SET email_frequency='instant'`, [USER]);
    await enqueue('na:t:instant-policy', ITEM);
    memberId = (await c.query(`SELECT id FROM public.notification_outbox LIMIT 1`)).rows[0].id;
  });

  const stop = async () => (await c.query(
    `SELECT public.notif_digest_member_stop_reason($1) AS r`, [memberId])).rows[0].r;

  it('an INSTANT row freezes destination_fingerprint (without it the check is a no-op)', async () => {
    const { rows } = await c.query(
      `SELECT delivery_mode, destination_fingerprint FROM public.notification_outbox`);
    expect(rows[0].delivery_mode).toBeNull();              // genuinely instant, not a digest member
    expect(rows[0].destination_fingerprint).toHaveLength(64);
  });

  it('a CHANGED address stops the instant row instead of mailing the frozen one', async () => {
    expect(await stop()).toBeNull();
    await c.query(`UPDATE public.notification_contacts SET destination_normalized='new@example.com'
                    WHERE user_id=$1 AND channel='email'`, [USER]);
    expect(await stop()).toBe('destination_changed');
  });

  it('revoking the contact alone does NOT stop an account holder — the login email still applies', async () => {
    // Deliberately asserting the REAL semantics rather than the intuitive ones. For an account
    // holder the resolver falls back to persons.email (their own login address), and the stop
    // predicate re-runs that same lookup. Here persons.email is still p@example.com, so the
    // address is unchanged and genuinely deliverable — revocation of a TENANT contact does not
    // revoke the account address. Asserting a stop here would encode a fiction.
    await c.query(`UPDATE public.notification_contacts SET revoked_at=now()
                    WHERE user_id=$1 AND channel='email'`, [USER]);
    expect(await stop()).toBeNull();
  });

  it('revoked contact AND a different account email DOES stop (frozen address is stale)', async () => {
    await c.query(`UPDATE public.notification_contacts SET revoked_at=now()
                    WHERE user_id=$1 AND channel='email'`, [USER]);
    await c.query(`UPDATE public.persons SET email='moved@example.com' WHERE id=$1`, [PERSON]);
    expect(await stop()).toBe('destination_changed');
    await c.query(`UPDATE public.persons SET email='p@example.com' WHERE id=$1`, [PERSON]);
  });

  it('no live address at all stops the row', async () => {
    await c.query(`UPDATE public.notification_contacts SET revoked_at=now()
                    WHERE user_id=$1 AND channel='email'`, [USER]);
    await c.query(`UPDATE public.persons SET email=NULL WHERE id=$1`, [PERSON]);
    expect(await stop()).toBe('no_destination');
    await c.query(`UPDATE public.persons SET email='p@example.com' WHERE id=$1`, [PERSON]);
  });

  it('preference switched off stops the instant row', async () => {
    await c.query(`UPDATE public.notification_preferences_v2 SET email_frequency='off'
                    WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(await stop()).toBe('preference_off');
  });

  it('suppression stops the instant row', async () => {
    await c.query(`INSERT INTO public.email_suppression_stub (email) VALUES ('p@example.com')`);
    expect(await stop()).toBe('suppressed');
    await c.query(`DELETE FROM public.email_suppression_stub`);
  });

  it('unfollowing stops the instant row (the event hook still applies)', async () => {
    await c.query(`UPDATE public.trainer_followers SET notify_new_availability=false
                    WHERE player_id='${PROFILE}' AND trainer_id='${TRAINER}'`);
    expect(await stop()).toBe('follow_revoked');
    await c.query(`UPDATE public.trainer_followers SET notify_new_availability=true
                    WHERE player_id='${PROFILE}' AND trainer_id='${TRAINER}'`);
  });

  it('service_role can execute the FULL policy fn (the worker calls it directly)', async () => {
    const { rows } = await c.query(
      `SELECT has_function_privilege('service_role',
         'public.notif_digest_member_stop_reason(uuid)', 'EXECUTE') AS ok`);
    expect(rows[0].ok).toBe(true);
  });
});

// ===========================================================================
describe('D — the v1->v2 mirror can never re-enable mail after an opt-out', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
    await applyC();
  });

  it('an INSERT that merely picks up the DEFAULT never overwrites an explicit v2 off', async () => {
    // The settings page upserts a PARTIAL legacy row when the user changes some OTHER control;
    // open_slots_digest then takes its column default of 'weekly'. That is not a choice about
    // open slots, and mirroring it would start mailing someone who had opted out.
    await seedV2PreJ('off');
    await c.query(`INSERT INTO public.notification_preferences (user_id) VALUES ($1)`, [USER]);
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].email_frequency).toBe('off');   // NOT 'weekly'
  });

  it('an INSERT still SEEDS v2 when no preference exists yet', async () => {
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'daily')`, [USER]);
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].email_frequency).toBe('daily');
  });

  it('a deliberate UPDATE of the column DOES apply — a cached opt-out still works', async () => {
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'weekly')`, [USER]);
    await c.query(`UPDATE public.notification_preferences SET open_slots_digest='off' WHERE user_id=$1`, [USER]);
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows[0].email_frequency).toBe('off');
  });
});
