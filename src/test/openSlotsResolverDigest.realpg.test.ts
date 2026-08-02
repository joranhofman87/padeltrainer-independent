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
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT notification_outbox_status_check CHECK (status IN
        ('pending','processing','sent','delivered','failed','skipped','cancelled')),
      UNIQUE (channel, idempotency_key));

    CREATE TABLE public.email_suppression_stub (email text PRIMARY KEY);
    CREATE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS
      $fn$ SELECT EXISTS (SELECT 1 FROM public.email_suppression_stub WHERE email = lower(p_email)) $fn$;

    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL,
      email_frequency text NOT NULL DEFAULT 'instant' CHECK (email_frequency IN ('instant','daily','weekly','off')),
      whatsapp_frequency text NOT NULL DEFAULT 'off', push_frequency text NOT NULL DEFAULT 'off',
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
    CREATE TABLE public.trainer_followers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid NOT NULL, trainer_id uuid NOT NULL,
      notify_new_availability boolean NOT NULL DEFAULT true, UNIQUE (player_id, trainer_id));
  `);

  // The REAL migration chain, in order.
  for (const f of [
    '20260911100000_notification_resolver.sql',
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
  await c.query(MIG('20261011110000_notif_10cb_enqueue_digest_branch.sql'));
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
describe('C — the mandatory v1 → v2 preference backfill', () => {
  beforeEach(async () => {
    await c.query(`DELETE FROM public.notification_preferences_v2; DELETE FROM public.notification_preferences;`);
  });

  it('carries off/instant/daily/weekly across EXACTLY, and ignores an unknown value', async () => {
    const users = ['off', 'instant', 'daily', 'weekly', 'fortnightly'];
    for (let i = 0; i < users.length; i++) {
      const u = `aaaaaaaa-0000-0000-0000-00000000000${i}`;
      await c.query(`INSERT INTO auth.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [u]);
      await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,$2)`, [u, users[i]]);
    }
    await applyC();

    const { rows } = await c.query(
      `SELECT user_id, email_frequency FROM public.notification_preferences_v2
        WHERE event_type = 'open_slots_player' ORDER BY user_id`);
    // 'fortnightly' is NOT coerced into a sending cadence — it is simply not migrated.
    expect(rows.map((r) => r.email_frequency)).toEqual(['off', 'instant', 'daily', 'weekly']);
  });

  it('an EXPLICIT v2 preference wins over the legacy value', async () => {
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'off')`, [USER]);
    await c.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency)
                   VALUES ($1,'open_slots_player','daily')`, [USER]);
    await applyC();
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2 WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email_frequency).toBe('daily');   // NOT overwritten by the legacy 'off'
  });

  it('is rerun-safe: a second application creates no duplicate and no drift', async () => {
    await c.query(`INSERT INTO public.notification_preferences (user_id, open_slots_digest) VALUES ($1,'weekly')`, [USER]);
    await applyC();
    await c.query(`UPDATE public.notification_preferences_v2 SET email_frequency='off'
                    WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    await applyC();   // rerun
    const { rows } = await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2 WHERE user_id=$1 AND event_type='open_slots_player'`, [USER]);
    expect(rows).toHaveLength(1);                 // no duplicate
    expect(rows[0].email_frequency).toBe('off');  // no drift: the rerun did not resurrect 'weekly'
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
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;`);
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
    await c.query(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;`);
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
             count(*) FILTER (WHERE to_char(b AT TIME ZONE z,'HH24:MI') <> '09:00')::int AS not_nine
        FROM (
          SELECT public.notif_digest_boundary_at(n, f, z) AS b, n, z
            FROM unnest($1::text[]) z,
                 unnest(ARRAY['daily','weekly']) f,
                 generate_series(0, 419) d,
                 LATERAL (SELECT '2011-01-01T00:00:00Z'::timestamptz + (d * 3 || ' days')::interval AS n) s
        ) t`, [zones]);
    expect(rows[0].checked).toBe(8400);
    expect(rows[0].not_monotone).toBe(0);
    expect(rows[0].not_nine).toBe(0);
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
