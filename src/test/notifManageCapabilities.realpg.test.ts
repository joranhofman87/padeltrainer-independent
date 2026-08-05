// @vitest-environment node
// N2 S1 — the marketing-suppression + manage-capability migrations, executed FOR REAL.
//
// These three migrations are the data layer under every N2 surface: the address-keyed marketing
// opt-out the campaign/onboarding senders will consult at send time, the capability rows behind
// the signed footer links, and the declared footer policy the attach layers read. The properties
// pinned here are the ones a later edit is most likely to break silently:
//   * mint is DETERMINISTIC for the same logical grant (same capability id → the edge layer
//     derives the same token bytes → frozen provider requests stay byte-identical on retry);
//   * a REQUIRED event can never gain an opt-out capability (mint refuses — the mutation pin);
//   * guests' manage_context can apply marketing suppression but NEVER an event opt-out;
//   * an address change on the underlying contact revokes live capabilities transactionally;
//   * suppression is monotonic, idempotent, normalized in the database, and platform-scope
//     uniqueness really is unique (partial index — plain UNIQUE dedupes nothing over NULL);
//   * the event opt-out writes BOTH preference columns on insert (the PR-8 column-default trap).
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

const U1 = '11111111-1111-4111-8111-111111111111';
const ACADEMY = '22222222-2222-4222-8222-222222222222';
const TRAINER = '33333333-3333-4333-8333-333333333333';

const mint = async (over: Record<string, unknown> = {}) => {
  const a = {
    kind: 'marketing_unsubscribe', scope_kind: 'academy', scope_id: ACADEMY,
    address: 'Person@Example.com', user_id: null, contact_id: null, event_type: null,
    source_kind: 'campaign_recipient', source_id: null, ttl: '400 days', key_version: 1,
    ...over,
  };
  const r = await c.query(
    `SELECT * FROM public.mint_notification_manage_capability($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::interval,$11)`,
    [a.kind, a.scope_kind, a.scope_id, a.address, a.user_id, a.contact_id,
     a.event_type, a.source_kind, a.source_id, a.ttl, a.key_version]);
  return r.rows[0] as { capability_id: string; key_version: number };
};

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

  // Prod-shaped base the migrations reference (same device as the sibling realpg suites: hand
  // stubs for the PRE-EXISTING tables, real migration files for the code under test).
  await c.query(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.notification_event_types (
      key text PRIMARY KEY,
      category text NOT NULL DEFAULT 'booking',
      required_delivery boolean NOT NULL DEFAULT false,
      default_whatsapp_frequency text NOT NULL DEFAULT 'off');

    CREATE TABLE public.notification_preferences_v2 (
      user_id uuid NOT NULL, event_type text NOT NULL,
      email_frequency text NOT NULL DEFAULT 'instant',
      whatsapp_frequency text NOT NULL DEFAULT 'off',
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, event_type));

    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      destination_normalized text NOT NULL);

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

  // The migrations under test — the REAL files.
  await c.query(MIG('20261014100000_notif_n2_marketing_suppression.sql'));
  await c.query(MIG('20261014110000_notif_n2_manage_capabilities.sql'));
  await c.query(MIG('20261014120000_notif_n2_footer_policy.sql'));

  await c.query(`
    INSERT INTO auth.users (id) VALUES ('${U1}');
    INSERT INTO public.academy_profiles VALUES ('${ACADEMY}', 'Padel Academy Zuid');
    INSERT INTO public.trainer_profiles (id, business_name) VALUES ('${TRAINER}', 'Coach Co');
    -- Seeded AFTER the policy migration, so the required event must declare 'none' explicitly —
    -- the coherence constraint refuses a required event on the mutating default, which is the
    -- property production seeds will now be held to at db:reset.
    INSERT INTO public.notification_event_types
      (key, category, required_delivery, default_whatsapp_frequency, email_footer_policy) VALUES
      ('open_slots_player', 'booking', false, 'off', 'manage_prefs'),
      ('session_reminder_player', 'reminder', false, 'instant', 'manage_prefs'),
      ('booking_confirmed_player', 'booking', true, 'off', 'none'),
      ('marketing_updates', 'marketing', false, 'off', 'marketing_unsubscribe');
  `);
}, 180_000);

afterAll(async () => {
  await c?.end();
  await epg?.stop();
});

beforeEach(async () => {
  await c.query(`
    DELETE FROM public.email_marketing_suppression;
    DELETE FROM public.notification_manage_capabilities;
    DELETE FROM public.notification_preferences_v2;
    DELETE FROM public.notification_contacts;
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

  it('scope coherence is validated, not trusted', async () => {
    await expect(c.query(
      `SELECT public.record_marketing_suppression('a@b.nl', 'academy', NULL, 'manual')`))
      .rejects.toThrow(/disagree/);
    await expect(c.query(
      `SELECT public.record_marketing_suppression('a@b.nl', 'platform', $1, 'manual')`, [ACADEMY]))
      .rejects.toThrow(/disagree/);
  });
});

describe('mint_notification_manage_capability', () => {
  it('the same logical grant returns the SAME capability id (deterministic tokens)', async () => {
    const a = await mint();
    const b = await mint();
    expect(b.capability_id).toBe(a.capability_id);
  });

  it('a revoked or expired capability is NOT reused — a fresh grant is minted', async () => {
    const a = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [a.capability_id]);
    const b = await mint();
    expect(b.capability_id).not.toBe(a.capability_id);
    await c.query(`UPDATE public.notification_manage_capabilities SET expires_at = now() - interval '1 day'
                    WHERE id = $1`, [b.capability_id]);
    const d = await mint();
    expect(d.capability_id).not.toBe(b.capability_id);
  });

  it('REFUSES an opt-out capability for a required-delivery event — and for an unknown one', async () => {
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'booking_confirmed_player',
      source_kind: 'outbox',
    })).rejects.toThrow(/required-delivery/);
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'does_not_exist',
      source_kind: 'outbox',
    })).rejects.toThrow(/required-delivery/);
    // ...and the guard reads the CATALOG, not a copy: flipping the flag flips the refusal.
    await c.query(`UPDATE public.notification_event_types SET required_delivery = true,
                     email_footer_policy = 'none' WHERE key = 'open_slots_player'`);
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox',
    })).rejects.toThrow(/required-delivery/);
    await c.query(`UPDATE public.notification_event_types SET required_delivery = false,
                     email_footer_policy = 'manage_prefs' WHERE key = 'open_slots_player'`);
    await expect(mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player',
      source_kind: 'outbox',
    })).resolves.toBeTruthy();
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
      source_kind: 'outbox',
    });
    expect(await apply(cap.capability_id, 'event_optout')).toBe('applied');
    const row = (await c.query(
      `SELECT email_frequency, whatsapp_frequency FROM public.notification_preferences_v2
        WHERE user_id = $1 AND event_type = 'session_reminder_player'`, [U1])).rows[0];
    // session_reminder_player's EVENT whatsapp default is 'instant'; the COLUMN default is 'off'.
    expect(row).toEqual({ email_frequency: 'off', whatsapp_frequency: 'instant' });
    expect(await apply(cap.capability_id, 'event_optout')).toBe('already_applied');
  });

  it('event opt-out on an EXISTING row moves email only, never the stored whatsapp choice', async () => {
    await c.query(`INSERT INTO public.notification_preferences_v2
      (user_id, event_type, email_frequency, whatsapp_frequency) VALUES ($1, 'open_slots_player', 'weekly', 'daily')`,
      [U1]);
    const cap = await mint({
      kind: 'account_event_optout', user_id: U1, event_type: 'open_slots_player', source_kind: 'outbox',
    });
    expect(await apply(cap.capability_id, 'event_optout')).toBe('applied');
    const row = (await c.query(
      `SELECT email_frequency, whatsapp_frequency FROM public.notification_preferences_v2
        WHERE user_id = $1 AND event_type = 'open_slots_player'`, [U1])).rows[0];
    expect(row).toEqual({ email_frequency: 'off', whatsapp_frequency: 'daily' });
  });

  it('missing / revoked / expired capabilities are rejected uniformly, and reject BEFORE acting', async () => {
    expect(await apply('99999999-9999-4999-8999-999999999999', 'marketing_unsubscribe'))
      .toBe('rejected_missing');
    const cap = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET revoked_at = now() WHERE id = $1`,
      [cap.capability_id]);
    expect(await apply(cap.capability_id, 'marketing_unsubscribe')).toBe('rejected_revoked');
    const cap2 = await mint();
    await c.query(`UPDATE public.notification_manage_capabilities SET expires_at = now() - interval '1 hour'
                    WHERE id = $1`, [cap2.capability_id]);
    expect(await apply(cap2.capability_id, 'marketing_unsubscribe')).toBe('rejected_expired');
    const n = (await c.query(`SELECT count(*)::int AS n FROM public.email_marketing_suppression`)).rows[0].n;
    expect(n).toBe(0);
  });

  it('a contact whose address changes revokes its live capabilities transactionally', async () => {
    const contact = (await c.query(
      `INSERT INTO public.notification_contacts (destination_normalized)
       VALUES ('guest@example.com') RETURNING id`)).rows[0].id;
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

  it('reports missing / revoked / expired as status, exposing nothing else', async () => {
    const missing = (await c.query(
      `SELECT status FROM public.get_notification_manage_context('99999999-9999-4999-8999-999999999999')`)).rows[0];
    expect(missing.status).toBe('missing');
  });
});

describe('email_footer_policy', () => {
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

  it('onboarding templates default to the SUPPRESSIBLE class', async () => {
    const cls = (await c.query(
      `INSERT INTO public.onboarding_email_templates DEFAULT VALUES RETURNING delivery_class`)).rows[0];
    expect(cls.delivery_class).toBe('marketing');
  });
});
