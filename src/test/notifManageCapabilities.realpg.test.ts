// @vitest-environment node
// N2 S1 — the marketing-suppression + manage-capability migrations, executed FOR REAL.
//
// These three migrations are the data layer under every N2 surface: the address-keyed marketing
// opt-out the campaign/onboarding senders will consult at send time, the capability rows behind
// the signed footer links, and the declared footer policy the attach layers read. The properties
// pinned here are the ones a later edit is most likely to break silently:
//   * one capability PER SEND: a retry of the same send returns the same row (so the rebuilt
//     email is byte-identical under a fixed provider idempotency key), a NEW send always gets a
//     fresh unconsumed row, a same-source mint with different claims RAISES, and two connections
//     racing one send converge on exactly one row via the unique index;
//   * key rotation is database-owned state: the version comes from the key-state row, an
//     already-printed capability is NEVER re-signed or revoked by a rotation, and a retired key
//     fails CLOSED (rejected_retired_key / status retired_key);
//   * a REQUIRED event can never gain an opt-out capability — refused at mint AND at apply;
//   * the account opt-out is CONSUMPTIVE: a replayed/forwarded link cannot undo a later
//     authenticated re-enable;
//   * capabilities stop acting when the DELIVERED destination moves on — whichever authority
//     resolved it (contact address or the account's persons.email) — and revocation is permanent;
//   * the suppression reader RAISES on malformed scope — a sender wiring error defers, it never
//     clears;
//   * claims are immutable and no client role can touch the tables directly;
//   * the footer-policy migration seeds the LIVE catalog before constraining it (the ordering
//     that passes on an empty database and fails on production is pinned by seeding first here).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Client } = pg;
const PORT = 54397;
const MIG = (f: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

let epg: InstanceType<typeof EmbeddedPostgres>;
let c: InstanceType<typeof Client>;
let c2: InstanceType<typeof Client>;   // the concurrent-mint second connection

const U1 = '11111111-1111-4111-8111-111111111111';
const ACADEMY = '22222222-2222-4222-8222-222222222222';
const TRAINER = '33333333-3333-4333-8333-333333333333';
const SEND_A = '44444444-4444-4444-8444-444444444444';
const SEND_B = '55555555-5555-4555-8555-555555555555';

const mintOn = async (client: InstanceType<typeof Client>, over: Record<string, unknown> = {}) => {
  const a = {
    kind: 'marketing_unsubscribe', scope_kind: 'academy', scope_id: ACADEMY,
    address: 'Person@Example.com', user_id: null, contact_id: null, event_type: null,
    source_kind: 'campaign_recipient', source_id: SEND_A, ttl: '400 days',
    ...over,
  };
  const r = await client.query(
    `SELECT * FROM public.mint_notification_manage_capability($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::interval)`,
    [a.kind, a.scope_kind, a.scope_id, a.address, a.user_id, a.contact_id,
     a.event_type, a.source_kind, a.source_id, a.ttl]);
  return r.rows[0] as { capability_id: string; key_version: number };
};
const mint = (over: Record<string, unknown> = {}) => mintOn(c, over);

const apply = async (id: string, action: string, source = 'one_click') =>
  (await c.query(`SELECT public.apply_notification_manage_action($1,$2,$3) AS r`, [id, action, source]))
    .rows[0].r as string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'n2caps-rp-'));
  epg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  c = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c.connect();
  c2 = new Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await c2.connect();

  // Prod-shaped base the migrations reference (same device as the sibling realpg suites: hand
  // stubs for the PRE-EXISTING tables, real migration files for the code under test).
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      category text NOT NULL DEFAULT 'booking',
      required_delivery boolean NOT NULL DEFAULT false,
      supports_email boolean NOT NULL DEFAULT true,
      default_whatsapp_frequency text NOT NULL DEFAULT 'off');

    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL,
      email_frequency text NOT NULL DEFAULT 'instant',
      whatsapp_frequency text NOT NULL DEFAULT 'off',
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_type));

    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid, user_id uuid, guest_player_id uuid,
      channel text NOT NULL DEFAULT 'email',
      destination_normalized text NOT NULL);

    CREATE TABLE public.persons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, email text);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY, name text);
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, business_name text, user_id uuid);
    CREATE TABLE public.onboarding_email_templates (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
  `);
  // The REAL redaction helper, extracted from the resolver migration rather than retyped — the
  // context RPC's "never the raw address" property is asserted against production's own code.
  const resolver = MIG('20260911100000_notification_resolver.sql');
  const redact = resolver.match(
    /CREATE OR REPLACE FUNCTION public\.notification_redact_destination[\s\S]*?\$\$;/)?.[0];
  if (!redact) throw new Error('notification_redact_destination not found in the resolver migration');
  await c.query(redact);

  // Suppression + capabilities under test — the REAL files.
  await c.query(MIG('20261014100000_notif_n2_marketing_suppression.sql'));
  await c.query(MIG('20261014110000_notif_n2_manage_capabilities.sql'));

  // THE PRODUCTION ORDER: the catalog is POPULATED (with real required/marketing rows and no
  // policy column) BEFORE the policy migration applies — so this suite fails if the migration
  // ever adds its constraint before its seeds again.
  await c.query(`
    INSERT INTO auth.users (id) VALUES ('${U1}');
    INSERT INTO public.persons (user_id, email) VALUES ('${U1}', 'person@example.com');
    INSERT INTO public.academy_profiles VALUES ('${ACADEMY}', 'Padel Academy Zuid');
    INSERT INTO public.trainer_profiles (id, business_name) VALUES ('${TRAINER}', 'Coach Co');
    INSERT INTO public.notification_event_types (key, category, required_delivery, default_whatsapp_frequency) VALUES
      ('open_slots_player', 'booking', false, 'off'),
      ('session_reminder_player', 'reminder', false, 'instant'),
      ('booking_confirmed_player', 'booking', true, 'off'),
      ('marketing_updates', 'marketing', false, 'off');
  `);
  await c.query(MIG('20261014120000_notif_n2_footer_policy.sql'));
}, 180_000);

afterAll(async () => {
  await c2?.end();
  await c?.end();
  await epg?.stop();
});

beforeEach(async () => {
  await c.query(`
    DELETE FROM public.email_marketing_suppression;
    DELETE FROM public.notification_manage_capabilities;
    DELETE FROM public.notification_preferences_v2;
    DELETE FROM public.notification_contacts;
    UPDATE public.persons SET email = 'person@example.com' WHERE user_id = '${U1}';
  `);
  // The key state is MONOTONIC by trigger (a floor may be raised, never lowered — and the row may
  // never be deleted), so resetting it between scenarios means recreating it with the guard
  // disabled. That the harness has to do this IS the guard working.
  await c.query(`
    ALTER TABLE public.notification_manage_key_state DISABLE TRIGGER trg_notif_manage_key_state_guard;
    DELETE FROM public.notification_manage_key_state;
    INSERT INTO public.notification_manage_key_state (id) VALUES (true);
    ALTER TABLE public.notification_manage_key_state ENABLE TRIGGER trg_notif_manage_key_state_guard;
  `);
});

describe('email_marketing_suppression', () => {
  it('is normalized IN the database: a non-normalized direct insert is an error', async () => {
    await expect(c.query(
      `INSERT INTO public.email_marketing_suppression (address_normalized, scope_kind, scope_id, source)
       VALUES ('Person@Example.com', 'platform', NULL, 'manual')`)).rejects.toThrow(/check/i);
  });

  it('record_marketing_suppression normalizes, is idempotent, and reports first-vs-repeat', async () => {
    const first = (await c.query(
      `SELECT public.record_marketing_suppression('  Person@Example.COM ', 'academy', $1, 'one_click') AS r`,
      [ACADEMY])).rows[0].r;
    const again = (await c.query(
      `SELECT public.record_marketing_suppression('person@example.com', 'academy', $1, 'manage_page') AS r`,
      [ACADEMY])).rows[0].r;
    expect(first).toBe(true);
    expect(again).toBe(false);
    const rows = await c.query(`SELECT address_normalized, source FROM public.email_marketing_suppression`);
    expect(rows.rows).toEqual([{ address_normalized: 'person@example.com', source: 'one_click' }]);
  });

  it('platform-scope uniqueness really is unique (plain UNIQUE dedupes nothing over NULL)', async () => {
    await c.query(`SELECT public.record_marketing_suppression('a@b.nl', 'platform', NULL, 'manual')`);
    await c.query(`SELECT public.record_marketing_suppression('a@b.nl', 'platform', NULL, 'manual')`);
    const n = await c.query(
      `SELECT count(*)::int AS n FROM public.email_marketing_suppression WHERE scope_id IS NULL`);
    expect(n.rows[0].n).toBe(1);
  });

  it('scope semantics: platform covers every scope; a tenant row covers only its tenant', async () => {
    await c.query(`SELECT public.record_marketing_suppression('t@x.nl', 'academy', $1, 'manual')`, [ACADEMY]);
    const q = async (scopeKind: string, scopeId: string | null) =>
      (await c.query(`SELECT public.is_marketing_suppressed('T@x.nl', $1, $2) AS s`,
        [scopeKind, scopeId])).rows[0].s;
    expect(await q('academy', ACADEMY)).toBe(true);
    expect(await q('academy', TRAINER)).toBe(false);   // a different academy id
    expect(await q('trainer', TRAINER)).toBe(false);
    expect(await q('platform', null)).toBe(false);

    await c.query(`SELECT public.record_marketing_suppression('t@x.nl', 'platform', NULL, 'manual')`);
    expect(await q('trainer', TRAINER)).toBe(true);    // platform arm covers every scope
    expect(await q('platform', null)).toBe(true);
  });

  it('the READER fails closed: malformed scope RAISES instead of answering false', async () => {
    // an academy sender that loses its scope id must DEFER, never gain marketing clearance
    await expect(c.query(
      `SELECT public.is_marketing_suppressed('a@b.nl', 'academy', NULL)`)).rejects.toThrow(/disagree/);
    await expect(c.query(
      `SELECT public.is_marketing_suppressed('a@b.nl', 'tenant', $1)`, [ACADEMY])).rejects.toThrow(/unknown scope_kind/);
    await expect(c.query(
      `SELECT public.is_marketing_suppressed('not-an-address', 'platform', NULL)`)).rejects.toThrow(/not an email/);
  });

  it('scope coherence is validated by the writer too, not trusted', async () => {
    await expect(c.query(
      `SELECT public.record_marketing_suppression('a@b.nl', 'academy', NULL, 'manual')`))
      .rejects.toThrow(/disagree/);
    await expect(c.query(
      `SELECT public.record_marketing_suppression('a@b.nl', 'platform', $1, 'manual')`, [ACADEMY]))
      .rejects.toThrow(/disagree/);
  });
});

describe('mint_notification_manage_capability', () => {
  it('the same SEND returns the SAME capability id (deterministic tokens for a retry)', async () => {
    const a = await mint();
    const b = await mint();
    expect(b.capability_id).toBe(a.capability_id);
  });

  it('TWO CONNECTIONS racing the same grant converge on ONE capability id', async () => {
    // Without the advisory lock this is a SELECT-then-INSERT race: both see no live grant, both
    // insert, and two different token byte strings exist for one frozen provider request.
    const addr = 'race@example.com';
    // BOTH racers must receive the capability — "a retry returns the same row" is the contract,
    // so a loser getting 23505 instead of its link would be a real defect, not a tolerable one.
    const [a, b] = await Promise.all([
      mintOn(c, { address: addr }),
      mintOn(c2, { address: addr }),
    ]);
    expect(a.capability_id).toBe(b.capability_id);
    const n = (await c.query(
      `SELECT count(*)::int AS n FROM public.notification_manage_capabilities WHERE address_normalized = $1`,
      [addr])).rows[0].n;
    expect(n).toBe(1);
  });

  it('a REVOKED capability stays the send\'s capability — a retry is not re-signed around it', async () => {
    // Per-send identity means a spent/revoked send does not get a second, live link minted for
    // it: the row IS the send. (A NEW send is what gets a new capability — pinned below.)
    const a = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [a.capability_id]);
    const retry = await mint();
    expect(retry.capability_id).toBe(a.capability_id);
    expect(await apply(a.capability_id, 'marketing_unsubscribe')).toBe('rejected_revoked');
    // ...while a different send mints its own, live capability
    const other = await mint({ source_id: SEND_B });
    expect(other.capability_id).not.toBe(a.capability_id);
    expect(await apply(other.capability_id, 'marketing_unsubscribe')).toBe('applied');
  });

  it('the key VERSION comes from database-owned state, never from the caller', async () => {
    const a = await mint();
    expect(a.key_version).toBe(1);
    await c.query(`UPDATE public.notification_manage_key_state SET current_version = 2`);
    const b = await mint({ source_id: SEND_B });
    expect(b.key_version).toBe(2);
    // ...and the ROTATION DOES NOT TOUCH the already-printed link: rewriting a signed row is how
    // a retry's body changes underneath a fixed provider idempotency key.
    const first = (await c.query(
      `SELECT key_version, revoked_at FROM public.notification_manage_capabilities WHERE id = $1`,
      [a.capability_id])).rows[0];
    expect(first).toEqual({ key_version: 1, revoked_at: null });
  });

  it('a RETIRED key fails closed: the old link is refused, and its retry cannot be re-signed', async () => {
    const old = await mint();
    await c.query(`UPDATE public.notification_manage_key_state
                     SET current_version = 2, min_mintable_version = 2`);
    // the printed link is a dead end...
    expect(await apply(old.capability_id, 'marketing_unsubscribe')).toBe('rejected_retired_key');
    const ctx = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [old.capability_id])).rows[0];
    expect(ctx.status).toBe('retired_key');
    expect(ctx.destination_redacted).toBeNull();
    // ...and a RETRY of that same send returns the SAME row (still v1) rather than silently
    // re-signing it under the new key — the retry fails honestly at the edge instead.
    const retry = await mint();
    expect(retry.capability_id).toBe(old.capability_id);
    expect(retry.key_version).toBe(1);
  });

  it('capabilities are PER SEND: the same source reuses, a new send mints fresh', async () => {
    const base = {
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', ttl: '90 days',
    };
    const a1 = await mint({ ...base, source_id: SEND_A });
    const a2 = await mint({ ...base, source_id: SEND_A });   // retry of the SAME send
    expect(a2.capability_id).toBe(a1.capability_id);
    const b = await mint({ ...base, source_id: SEND_B });    // a NEW email
    expect(b.capability_id).not.toBe(a1.capability_id);
    // ...and a NULL send id is refused rather than collapsing every send into one grant
    await expect(mint({ ...base, source_id: null })).rejects.toThrow(/source_id is required/);
  });

  it('a same-source mint with DIFFERENT claims RAISES rather than re-pointing a printed link', async () => {
    await mint();
    await expect(mint({ address: 'someone-else@example.com' }))
      .rejects.toThrow(/different claims/);
    await expect(mint({ scope_kind: 'trainer', scope_id: TRAINER }))
      .rejects.toThrow(/different claims/);
  });

  it('the CATALOG footer policy gates the opt-out kind: a marketing event never gets one', async () => {
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'marketing_updates',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    })).rejects.toThrow(/requires manage_prefs/);
  });

  it('validates EVERY input before reuse — an invalid request never succeeds via an existing row', async () => {
    await mint();   // a live grant exists
    await expect(mint({ ttl: '0 days' })).rejects.toThrow(/ttl out of bounds/);
    await expect(mint({ ttl: '30 days' })).rejects.toThrow(/13 months/);       // marketing floor
    await expect(mint({ scope_kind: 'academy', scope_id: null })).rejects.toThrow(/disagree/);
    await expect(mint({ source_kind: 'nowhere' })).rejects.toThrow(/unknown source_kind/);
    await expect(mint({ kind: 'marketing_unsubscribe', event_type: 'open_slots_player' }))
      .rejects.toThrow(/carries no event_type/);
  });

  it('REFUSES an opt-out capability for a required-delivery event — and for an unknown one', async () => {
    const optout = (over: Record<string, unknown> = {}) => mint({
      kind: 'account_event_optout', user_id: U1, contact_id: null,
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days', ...over,
    });
    await expect(optout({ event_type: 'booking_confirmed_player' })).rejects.toThrow(/required-delivery/);
    await expect(optout({ event_type: 'does_not_exist' })).rejects.toThrow(/required-delivery/);
    // ...and the guard reads the CATALOG, not a copy: flipping the flag flips the refusal.
    await c.query(`UPDATE public.notification_event_types SET required_delivery = true,
                     email_footer_policy = 'none' WHERE key = 'open_slots_player'`);
    await expect(optout({ event_type: 'open_slots_player' })).rejects.toThrow(/required-delivery/);
    await c.query(`UPDATE public.notification_event_types SET required_delivery = false,
                     email_footer_policy = 'manage_prefs' WHERE key = 'open_slots_player'`);
    await expect(optout({ event_type: 'open_slots_player' })).resolves.toBeTruthy();
  });

  it('an account grant may bind the CONTACT the mail was delivered to, not only the account email', async () => {
    // The resolver prefers an eligible contact over the persons.email fallback, so a capability
    // must be able to bind whichever one actually delivered this mail.
    const contact = (await c.query(
      `INSERT INTO public.notification_contacts (destination_normalized, user_id)
       VALUES ('contact-inbox@example.com', $1) RETURNING id`, [U1])).rows[0].id;
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, contact_id: contact,
      address: 'contact-inbox@example.com',
      event_type: 'open_slots_player', source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    // it acts while the CONTACT address is unchanged, even though it differs from persons.email
    expect(await apply(cap.capability_id, 'event_optout')).toBe('applied');
    // ...and dies with that contact's address, not the account's
    const cap2 = await mint({
      kind: 'account_event_optout', user_id: U1, contact_id: contact,
      address: 'contact-inbox@example.com',
      event_type: 'session_reminder_player', source_kind: 'outbox', source_id: SEND_B, ttl: '90 days',
    });
    await c.query(`UPDATE public.notification_contacts SET destination_normalized = 'moved@example.com'
                    WHERE id = $1`, [contact]);
    expect(await apply(cap2.capability_id, 'event_optout')).toBe('rejected_revoked');
  });
});

describe('apply_notification_manage_action', () => {
  it('marketing capability applies suppression for ITS scope + address; replay is already_applied', async () => {
    const cap = await mint();
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('applied');
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('already_applied');
    const row = (await c.query(`SELECT * FROM public.email_marketing_suppression`)).rows[0];
    expect(row.address_normalized).toBe('person@example.com');
    expect(row.scope_kind).toBe('academy');
    expect(row.scope_id).toBe(ACADEMY);
    expect(row.capability_id).toBe(cap.capability_id);
  });

  it('a guest manage_context may apply marketing suppression but NEVER an event opt-out', async () => {
    const ctx = await mint({ kind: 'manage_context', source_kind: 'campaign_recipient' });
    expect(await apply(ctx.capability_id, 'event_optout', 'manage_page')).toBe('rejected_kind_mismatch');
    expect(await apply(ctx.capability_id, 'marketing_unsubscribe', 'manage_page')).toBe('applied');
  });

  it('event opt-out writes BOTH columns on insert (event whatsapp default, not the column default)', async () => {
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'session_reminder_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    expect(await apply(cap.capability_id, 'event_optout')).toBe('applied');
    const row = (await c.query(
      `SELECT email_frequency, whatsapp_frequency FROM public.notification_preferences_v2
        WHERE user_id = $1 AND event_type = 'session_reminder_player'`, [U1])).rows[0];
    // session_reminder_player's EVENT whatsapp default is 'instant'; the COLUMN default is 'off'.
    expect(row).toEqual({ email_frequency: 'off', whatsapp_frequency: 'instant' });
  });

  it('the account opt-out is CONSUMPTIVE: a replay cannot undo a later authenticated re-enable', async () => {
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    expect(await apply(cap.capability_id, 'event_optout')).toBe('applied');
    // the person re-enables in authenticated settings…
    await c.query(`UPDATE public.notification_preferences_v2 SET email_frequency = 'weekly'
                    WHERE user_id = $1 AND event_type = 'open_slots_player'`, [U1]);
    // …and the replayed/forwarded link must NOT fight them
    expect(await apply(cap.capability_id, 'event_optout')).toBe('already_applied');
    const row = (await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id = $1 AND event_type = 'open_slots_player'`, [U1])).rows[0];
    expect(row.email_frequency).toBe('weekly');
    // ...but the NEXT email's fresh (per-send) capability must WORK — the consumed grant is
    // spent, not the person's ability to opt out again.
    const next = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_B, ttl: '90 days',
    });
    expect(next.capability_id).not.toBe(cap.capability_id);
    expect(await apply(next.capability_id, 'event_optout')).toBe('applied');
    const after = (await c.query(
      `SELECT email_frequency FROM public.notification_preferences_v2
        WHERE user_id = $1 AND event_type = 'open_slots_player'`, [U1])).rows[0];
    expect(after.email_frequency).toBe('off');
  });

  it('the declared footer policy is re-checked at APPLY: a reclassified-to-marketing event refuses', async () => {
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    await c.query(`UPDATE public.notification_event_types
                     SET category = 'marketing', email_footer_policy = 'marketing_unsubscribe'
                   WHERE key = 'open_slots_player'`);
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_event_policy');
    await c.query(`UPDATE public.notification_event_types
                     SET category = 'booking', email_footer_policy = 'manage_prefs'
                   WHERE key = 'open_slots_player'`);
  });

  it('event opt-out on an EXISTING row moves email only, never the stored whatsapp choice', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2
      (user_id, event_type, email_frequency, whatsapp_frequency) VALUES ($1, 'open_slots_player', 'weekly', 'daily')`,
      [U1]);
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    expect(await apply(cap.capability_id, 'event_optout')).toBe('applied');
    const row = (await c.query(
      `SELECT email_frequency, whatsapp_frequency FROM public.notification_preferences_v2
        WHERE user_id = $1 AND event_type = 'open_slots_player'`, [U1])).rows[0];
    expect(row).toEqual({ email_frequency: 'off', whatsapp_frequency: 'daily' });
  });

  it('an account capability stops acting when the CANONICAL account address changes', async () => {
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    await c.query(`UPDATE public.persons SET email = 'new-inbox@example.com' WHERE user_id = $1`, [U1]);
    // the trigger revokes account-fallback-bound capabilities transactionally...
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_revoked');
    // ...and revocation is PERMANENT: moving the address back does not reactivate the link
    await c.query(`UPDATE public.persons SET email = 'person@example.com' WHERE user_id = $1`, [U1]);
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_revoked');
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.notification_preferences_v2`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('required_delivery is re-checked at APPLY time — a reclassified event wins over an old grant', async () => {
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    await c.query(`UPDATE public.notification_event_types SET required_delivery = true,
                     email_footer_policy = 'none' WHERE key = 'open_slots_player'`);
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_required_event');
    await c.query(`UPDATE public.notification_event_types SET required_delivery = false,
                     email_footer_policy = 'manage_prefs' WHERE key = 'open_slots_player'`);
  });

  it('missing / revoked / expired capabilities are rejected uniformly, and reject BEFORE acting', async () => {
    expect(await apply('99999999-9999-4999-8999-999999999999', 'marketing_unsubscribe'))
      .toBe('rejected_missing');
    const cap = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('rejected_revoked');
    const expired = (await c.query(
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
          source_kind, source_id, key_version, expires_at)
       VALUES ('marketing_unsubscribe', 'trainer', $1, 'person@example.com', md5('person@example.com'),
               'campaign_recipient', $2, 1, now() - interval '1 hour')
       RETURNING id`, [TRAINER, SEND_B])).rows[0].id;
    expect(await apply(expired, 'marketing_unsubscribe')).toBe('rejected_expired');
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.email_marketing_suppression`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('a contact whose address changes revokes its live capabilities transactionally', async () => {
    const contact = (await c.query(
      `INSERT INTO public.notification_contacts (destination_normalized, guest_player_id)
       VALUES ('guest@example.com', gen_random_uuid()) RETURNING id`)).rows[0].id;
    const cap = await mint({
      kind: 'manage_context', contact_id: contact, address: 'guest@example.com',
      source_kind: 'outbox',
    });
    await c.query(
      `UPDATE public.notification_contacts SET destination_normalized = 'new@example.com' WHERE id = $1`,
      [contact]);
    const revoked = (await c.query(
      `SELECT revoked_at IS NOT NULL AS r FROM public.notification_manage_capabilities WHERE id = $1`,
      [cap.capability_id])).rows[0].r;
    expect(revoked).toBe(true);
    expect(await apply(cap.capability_id, 'marketing_unsubscribe', 'manage_page')).toBe('rejected_revoked');
  });
});

describe('key state is the retirement authority, and it fails closed', () => {
  it('the floor is MONOTONIC and the row is permanent — even for a privileged caller', async () => {
    await c.query(`UPDATE public.notification_manage_key_state
                     SET current_version = 3, min_mintable_version = 2`);
    await expect(c.query(
      `UPDATE public.notification_manage_key_state SET min_mintable_version = 1`))
      .rejects.toThrow(/monotonic/);
    await expect(c.query(
      `UPDATE public.notification_manage_key_state SET current_version = 1`))
      .rejects.toThrow(/monotonic/);
    await expect(c.query(`DELETE FROM public.notification_manage_key_state`))
      .rejects.toThrow(/never removed/);
  });

  it('a MISSING key state retires everything — absence is never read as version 1', async () => {
    const cap = await mint();
    await c.query(`
      ALTER TABLE public.notification_manage_key_state DISABLE TRIGGER trg_notif_manage_key_state_guard;
      DELETE FROM public.notification_manage_key_state;
      ALTER TABLE public.notification_manage_key_state ENABLE TRIGGER trg_notif_manage_key_state_guard;`);
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('rejected_retired_key');
    const ctx = (await c.query(
      `SELECT status FROM public.get_notification_manage_context($1)`, [cap.capability_id])).rows[0];
    expect(ctx.status).toBe('retired_key');
    await expect(mint({ source_id: SEND_B })).rejects.toThrow(/signing-key state is missing/);
  });

  it('service_role cannot lower or remove the retirement floor', async () => {
    const as = async (sql: string) => {
      await c2.query(`SET ROLE service_role`);
      try { await c2.query(sql); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    expect(await as(`UPDATE public.notification_manage_key_state SET min_mintable_version = 1`)).toBe('42501');
    expect(await as(`DELETE FROM public.notification_manage_key_state`)).toBe('42501');
    expect(await as(`TRUNCATE public.notification_manage_key_state`)).toBe('42501');
    expect(await as(`SELECT * FROM public.notification_manage_key_state`)).toBeNull();
  });
});

describe('a capability cannot borrow another account\'s authority', () => {
  it('mint REFUSES a contact that is not this recipient\'s email contact for this address', async () => {
    // The hole this closes: pairing (user B, contact/address A) let whoever received mail at A
    // switch off B's event — the apply-time destination check compared A against A and passed.
    const foreign = (await c.query(
      `INSERT INTO public.notification_contacts (destination_normalized, user_id)
       VALUES ('stranger@example.com', gen_random_uuid()) RETURNING id`)).rows[0].id;
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, contact_id: foreign,
      address: 'stranger@example.com', event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    })).rejects.toThrow(/not this recipient's email contact/);
    // ...also refused when the contact belongs to the user but carries a DIFFERENT address
    const own = (await c.query(
      `INSERT INTO public.notification_contacts (destination_normalized, user_id)
       VALUES ('other-inbox@example.com', $1) RETURNING id`, [U1])).rows[0].id;
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, contact_id: own,
      address: 'person@example.com', event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    })).rejects.toThrow(/not this recipient's email contact/);
  });

  it('apply RE-CHECKS ownership: a contact repointed at another account loses its authority', async () => {
    const contact = (await c.query(
      `INSERT INTO public.notification_contacts (destination_normalized, user_id)
       VALUES ('shared-inbox@example.com', $1) RETURNING id`, [U1])).rows[0].id;
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, contact_id: contact,
      address: 'shared-inbox@example.com', event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    // the contact is repointed at somebody else, address unchanged
    await c.query(`UPDATE public.notification_contacts SET user_id = gen_random_uuid() WHERE id = $1`,
      [contact]);
    // the identity trigger revokes; even without it, the ownership re-check refuses
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_revoked');
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.notification_preferences_v2`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('an account-fallback capability dies with the person row, permanently', async () => {
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox', source_id: SEND_A, ttl: '90 days',
    });
    await c.query(`DELETE FROM public.persons WHERE user_id = $1`, [U1]);
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_revoked');
    // recreating the person does not restore the old link's authority
    await c.query(`INSERT INTO public.persons (user_id, email) VALUES ($1, 'person@example.com')`, [U1]);
    expect(await apply(cap.capability_id, 'event_optout')).toBe('rejected_revoked');
  });
});

describe('immutability + ACLs', () => {
  it('claims are immutable — even a privileged direct UPDATE is refused by the guard trigger', async () => {
    const cap = await mint();
    await expect(c.query(
      `UPDATE public.notification_manage_capabilities SET address_normalized = 'other@example.com'
        WHERE id = $1`, [cap.capability_id])).rejects.toThrow(/immutable/);
    // ...while the two lifecycle columns stay writable (that is what revocation IS)
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
  });

  it('no client role touches the tables directly; service_role acts only through the RPCs', async () => {
    const as = async (role: string, sql: string, params: unknown[] = []) => {
      await c2.query(`SET ROLE ${role}`);
      try { await c2.query(sql, params); return null; }
      catch (e) { return (e as { code?: string }).code ?? 'error'; }
      finally { await c2.query(`RESET ROLE`); }
    };
    // authenticated: nothing at all
    expect(await as('authenticated',
      `SELECT * FROM public.notification_manage_capabilities`)).toBe('42501');
    expect(await as('authenticated',
      `SELECT * FROM public.email_marketing_suppression`)).toBe('42501');
    // The signature is spelled out per the REAL arity: a stale call would fail 42883
    // (undefined function) and quietly "pass" a permission test it never reached.
    expect(await as('authenticated',
      `SELECT public.mint_notification_manage_capability('marketing_unsubscribe','platform',NULL,'a@b.nl',NULL,NULL,NULL,'campaign_recipient',gen_random_uuid(),'400 days'::interval)`))
      .toBe('42501');
    expect(await as('authenticated',
      `SELECT * FROM public.notification_manage_key_state`)).toBe('42501');
    // service_role: the RPCs work, direct writes to the capability table do not
    expect(await as('service_role',
      `SELECT public.record_marketing_suppression('svc@b.nl','platform',NULL,'manual')`)).toBeNull();
    expect(await as('service_role',
      `UPDATE public.notification_manage_capabilities SET revoked_at = now()`)).toBe('42501');
    expect(await as('service_role',
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, address_normalized, destination_fingerprint, source_kind, source_id, key_version, expires_at)
       VALUES ('manage_context','platform','a@b.nl','x','outbox', gen_random_uuid(), 1, now())`)).toBe('42501');
  });
});

describe('get_notification_manage_context', () => {
  it('returns a REDACTED destination and the scope display name — never the raw address', async () => {
    const cap = await mint();
    const ctx = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [cap.capability_id])).rows[0];
    expect(ctx.status).toBe('live');
    expect(ctx.scope_display_name).toBe('Padel Academy Zuid');
    expect(ctx.destination_redacted).not.toContain('person@example.com');
    expect(ctx.destination_redacted).toMatch(/\*/);
  });

  it('non-live capabilities disclose their STATUS and nothing else', async () => {
    const missing = (await c.query(
      `SELECT * FROM public.get_notification_manage_context('99999999-9999-4999-8999-999999999999')`)).rows[0];
    expect(missing.status).toBe('missing');
    expect(missing.destination_redacted).toBeNull();

    const cap = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
    const revoked = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [cap.capability_id])).rows[0];
    expect(revoked.status).toBe('revoked');
    expect(revoked.kind).toBeNull();
    expect(revoked.scope_display_name).toBeNull();
    expect(revoked.destination_redacted).toBeNull();

    const expiredId = (await c.query(
      `INSERT INTO public.notification_manage_capabilities
         (kind, scope_kind, scope_id, address_normalized, destination_fingerprint,
          source_kind, source_id, key_version, expires_at)
       VALUES ('marketing_unsubscribe', 'trainer', $1, 'person@example.com', md5('person@example.com'),
               'campaign_recipient', $2, 1, now() - interval '1 hour')
       RETURNING id`, [TRAINER, SEND_B])).rows[0].id;
    const expired = (await c.query(
      `SELECT * FROM public.get_notification_manage_context($1)`, [expiredId])).rows[0];
    expect(expired.status).toBe('expired');
    expect(expired.destination_redacted).toBeNull();
  });
});

describe('email_footer_policy (seeded on a POPULATED catalog, the production order)', () => {
  it('required events are none, marketing is marketing_unsubscribe, everything else manage_prefs', async () => {
    const rows = (await c.query(
      `SELECT key, email_footer_policy FROM public.notification_event_types ORDER BY key`)).rows;
    expect(Object.fromEntries(rows.map((r: { key: string; email_footer_policy: string }) => [r.key, r.email_footer_policy])))
      .toEqual({
        booking_confirmed_player: 'none',
        marketing_updates: 'marketing_unsubscribe',
        open_slots_player: 'manage_prefs',
        session_reminder_player: 'manage_prefs',
      });
  });

  it('a required event cannot carry a mutating footer policy (constraint, not convention)', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'manage_prefs'
        WHERE key = 'booking_confirmed_player'`)).rejects.toThrow(/coherent/i);
  });

  it('an optional MARKETING event cannot carry a weaker policy than marketing_unsubscribe', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'manage_prefs'
        WHERE key = 'marketing_updates'`)).rejects.toThrow(/coherent/i);
    await expect(c.query(
      `INSERT INTO public.notification_event_types (key, category, required_delivery) VALUES
         ('future_marketing_blast', 'marketing', false)`)).rejects.toThrow(/coherent/i);
  });

  it('every OPTIONAL email-capable event must carry a MUTATING footer policy', async () => {
    await expect(c.query(
      `UPDATE public.notification_event_types SET email_footer_policy = 'none'
        WHERE key = 'open_slots_player'`)).rejects.toThrow(/has_footer/i);
    // ...and a required→optional reclassification is LOUD unless it declares the footer too
    await expect(c.query(
      `UPDATE public.notification_event_types SET required_delivery = false
        WHERE key = 'booking_confirmed_player'`)).rejects.toThrow(/has_footer/i);
    await c.query(
      `UPDATE public.notification_event_types SET required_delivery = false, email_footer_policy = 'manage_prefs'
        WHERE key = 'booking_confirmed_player'`);
    await c.query(
      `UPDATE public.notification_event_types SET required_delivery = true, email_footer_policy = 'none'
        WHERE key = 'booking_confirmed_player'`);
  });

  it('MARKETING IS NEVER REQUIRED — the previously legal atomic transition is refused', async () => {
    // All three earlier arms were satisfied by category='marketing' + required + 'none':
    // mandatory marketing with no unsubscribe. One statement, so no arm can be blamed on ordering.
    await expect(c.query(
      `UPDATE public.notification_event_types
          SET category = 'marketing', required_delivery = true, email_footer_policy = 'none'
        WHERE key = 'open_slots_player'`)).rejects.toThrow(/never_required/i);
    await expect(c.query(
      `INSERT INTO public.notification_event_types
         (key, category, required_delivery, email_footer_policy)
       VALUES ('mandatory_marketing', 'marketing', true, 'none')`)).rejects.toThrow(/never_required/i);
  });

  it('onboarding templates default to the SUPPRESSIBLE class; optional_service does not exist yet', async () => {
    const cls = (await c.query(
      `INSERT INTO public.onboarding_email_templates DEFAULT VALUES RETURNING delivery_class`)).rows[0];
    expect(cls.delivery_class).toBe('marketing');
    await expect(c.query(
      `UPDATE public.onboarding_email_templates SET delivery_class = 'optional_service'`)).rejects.toThrow(/check/i);
    await c.query(`UPDATE public.onboarding_email_templates SET delivery_class = 'required_service'`);
  });
});
