// @vitest-environment node
// Notification Foundation v2 — PR 3 resolver (migration 20260911100000).
// Pins the enqueue_notification contract from docs/NOTIFICATION_ARCHITECTURE.md §3:
//   * recipient normalization (person / user / guest → one person + idem key),
//   * per-recipient idempotency (re-enqueue no-ops; distinct recipients don't collide),
//   * preference resolution (prefs_v2 override else event default; off → skip),
//   * required-delivery guarantee (email can't be turned off) + skipped row when the
//     required event has no deliverable channel (suppressed / no address),
//   * transactional email (account-email fallback + hard-suppression block),
//   * whatsapp requires an opted-in, IN-TENANT-SCOPE contact (cross-tenant denial),
//   * tenant-visible events demand tenant ctx + get a public_summary,
//   * collapse_key set only for collapse-window events,
//   * the resolver + redaction helper are service-role-only.
// Runs the REAL schema + resolver migration files.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;

// persons
const P1 = 'd0000000-0000-0000-0000-000000000001'; // has login U1, account email
const P2 = 'd0000000-0000-0000-0000-000000000002'; // has login U2, SUPPRESSED account email
const P3 = 'd0000000-0000-0000-0000-000000000003'; // has login U3, NO email
const PG = 'd0000000-0000-0000-0000-0000000000fa'; // guest-only person (via person_links), has email
const U1 = 'e0000000-0000-0000-0000-000000000001';
const U2 = 'e0000000-0000-0000-0000-000000000002';
const U3 = 'e0000000-0000-0000-0000-000000000003';
const G1 = 'f0000000-0000-0000-0000-0000000000a1'; // guest_player id linked to PG
const A = 'a0000000-0000-0000-0000-00000000000a';  // academy A
const B = 'a0000000-0000-0000-0000-00000000000b';  // academy B
const T = 'c0000000-0000-0000-0000-0000000000cc';  // trainer T

const MIG = (name: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', name), 'utf8');

// call enqueue_notification with named args (skip the ones we don't need) and return the rows it created
const enqueue = (args: Record<string, string>) => {
  const named = Object.entries(args).map(([k, v]) => `${k} => ${v}`).join(', ');
  return db.query<{
    channel: string; status: string; skip_reason: string | null; visibility_scope: string;
    destination_normalized: string | null; destination_redacted: string | null;
    idempotency_key: string; collapse_key: string | null; recipient_person_id: string | null;
    public_summary: unknown; template_key: string | null;
  }>(`SELECT channel, status, skip_reason, visibility_scope, destination_normalized, destination_redacted,
             idempotency_key, collapse_key, recipient_person_id, public_summary, template_key
      FROM public.enqueue_notification(${named})`);
};

const countOutbox = async () =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    -- person model stand-ins with the columns the resolver actually reads
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY);
    -- email suppression: faithful copy of the prod helper (record_email_event migration)
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean
      LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.email_address_state
                     WHERE email = lower(btrim(p_email)) AND state IN ('hard_bounced','complained'));
    $fn$;
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL, recipient_email text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U1}'), ('${U2}'), ('${U3}');
    INSERT INTO public.persons (id, user_id, email) VALUES
      ('${P1}', '${U1}', 'p1@example.com'),
      ('${P2}', '${U2}', 'bounce@example.com'),
      ('${P3}', '${U3}', NULL),
      ('${PG}', NULL,    'guestperson@example.com');
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PG}', '${G1}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.trainer_profiles (id) VALUES ('${T}');
    INSERT INTO public.email_address_state (email, state) VALUES ('bounce@example.com', 'hard_bounced');
  `);
});

// each test starts from an empty outbox / no contacts / no prefs
// (CASCADE: outbox is referenced by email_delivery_events.outbox_id — empty here)
beforeEach(async () => {
  await db.exec(`TRUNCATE public.notification_outbox, public.notification_contacts, public.notification_preferences_v2 CASCADE;`);
});

describe('recipient normalization + basic email enqueue', () => {
  it('enqueues one email row to the account email, keyed <event>:<subject>:<person>', async () => {
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('email');
    expect(rows[0].status).toBe('pending');
    expect(rows[0].destination_normalized).toBe('p1@example.com');
    expect(rows[0].destination_redacted).toBe('p***@example.com');
    expect(rows[0].idempotency_key).toBe(`booking_confirmed_player:b1:${P1}`);
    expect(rows[0].recipient_person_id).toBe(P1);
    // whatsapp is supported by the event but there is no opted-in contact → no wa row
    expect(await countOutbox()).toBe(1);
  });

  it('resolves person + account email when the caller passes only user_id', async () => {
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_user_id: `'${U1}'`, p_idempotency_subject: `'b1'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].destination_normalized).toBe('p1@example.com');
    // idem key normalizes to the PERSON even though a user_id was supplied
    expect(rows[0].idempotency_key).toBe(`booking_confirmed_player:b1:${P1}`);
  });

  it('resolves a guest-only recipient to its person via person_links (delivering to an in-scope contact)', async () => {
    // a guest-only person has NO global account email → it must use an in-scope tenant contact
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id)
       VALUES ($1,'email','guest-a@example.com','g***@example.com','opted_in','tenant',$2)`, [PG, A]);
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_guest_player_id: `'${G1}'`, p_idempotency_subject: `'b1'`, p_tenant_academy_profile_id: `'${A}'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].destination_normalized).toBe('guest-a@example.com');
    expect(rows[0].idempotency_key).toBe(`booking_confirmed_player:b1:${PG}`); // normalized to the PERSON
  });
});

describe('email respects tenant scope (P1 fix — no cross-tenant guest data)', () => {
  it('a guest email contact for academy A is DENIED for an academy B send (required → skipped, no global fallback)', async () => {
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id)
       VALUES ($1,'email','guest-a@example.com','g***@example.com','opted_in','tenant',$2)`, [PG, A]);
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_guest_player_id: `'${G1}'`, p_idempotency_subject: `'b1'`, p_tenant_academy_profile_id: `'${B}'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');            // A-scoped contact unusable for B; guest has no account fallback
    expect(rows[0].skip_reason).toBe('no_email_contact');
  });

  it('an account holder uses its in-scope contact but falls back to the GLOBAL account email cross-tenant (no leak of the A contact)', async () => {
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id)
       VALUES ($1,$2,'email','p1-academyA@example.com','p***@example.com','opted_in','tenant',$3)`, [P1, U1, A]);
    const forA = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'`, p_tenant_academy_profile_id: `'${A}'` });
    expect(forA.rows[0].destination_normalized).toBe('p1-academyA@example.com'); // in-scope contact wins for A
    const forB = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b2'`, p_tenant_academy_profile_id: `'${B}'` });
    expect(forB.rows[0].destination_normalized).toBe('p1@example.com');          // A contact NOT leaked to B → global account email
  });

  // the 'global' loophole: a global-scoped contact matches any tenant, and the schema
  // used to DEFAULT scope to 'global' — so a guest global contact must be rejected too.
  it('a GUEST-only person with a GLOBAL email contact is DENIED (global is account-holders-only) → skipped', async () => {
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1,'email','guest-global@example.com','g***@example.com','opted_in','global')`, [PG]);
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_guest_player_id: `'${G1}'`, p_idempotency_subject: `'b1'`, p_tenant_academy_profile_id: `'${B}'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('no_email_contact');
  });

  it('an ACCOUNT HOLDER with a GLOBAL email contact DOES use it (global is legitimate for account holders)', async () => {
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, user_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope)
       VALUES ($1,$2,'email','p1-global@example.com','p***@example.com','opted_in','global')`, [P1, U1]);
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'` });
    expect(rows[0].destination_normalized).toBe('p1-global@example.com');
  });
});

describe('idempotency subject is mandatory (derive-or-raise, P1 fix)', () => {
  it('raises when neither a subject nor a derivable ref is supplied', async () => {
    await expect(enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'` }))
      .rejects.toThrow(/needs an idempotency subject/i);
  });
  it('derives a stable subject from SORTED related_booking_ids when the subject is omitted', async () => {
    const { rows } = await enqueue({
      p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`,
      // passed reverse-sorted on purpose → the derived key must be deterministic (sorted)
      p_related_booking_ids: `ARRAY['22222222-2222-2222-2222-222222222222'::uuid,'11111111-1111-1111-1111-111111111111'::uuid]`,
    });
    expect(rows[0].idempotency_key).toBe(
      `booking_confirmed_player:bookings:11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222:${P1}`);
  });
});

describe('per-recipient idempotency', () => {
  it('a second identical enqueue is a no-op (returns no new rows, no duplicate)', async () => {
    const first = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'` });
    expect(first.rows).toHaveLength(1);
    const second = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'` });
    expect(second.rows).toHaveLength(0);
    expect(await countOutbox()).toBe(1);
  });

  it('a different subject or a different recipient produces a distinct row', async () => {
    await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'` });
    await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b2'` }); // subject differs
    await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_user_id: `'${U2}'`, p_idempotency_subject: `'b1'` }); // recipient differs (P2 email is suppressed → skipped, but still a distinct row)
    expect(await countOutbox()).toBe(3);
  });
});

describe('preference resolution', () => {
  it('a NON-required event with email preference off and no other channel enqueues nothing', async () => {
    await db.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ($1,'booking_cancelled_player','off')`, [U1]);
    const { rows } = await enqueue({ p_event_key: `'booking_cancelled_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'c1'` });
    expect(rows).toHaveLength(0);
    expect(await countOutbox()).toBe(0);
  });

  it('a daily email preference schedules the row for a future digest boundary', async () => {
    await db.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ($1,'booking_cancelled_player','daily')`, [U1]);
    await enqueue({ p_event_key: `'booking_cancelled_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'c1'` });
    const { rows } = await db.query<{ future: boolean }>(`SELECT scheduled_for > now() AS future FROM public.notification_outbox LIMIT 1`);
    expect(rows[0].future).toBe(true);
  });
});

describe('required-delivery guarantee', () => {
  it('a required event CANNOT be turned off — email is forced even with preference off', async () => {
    await db.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, email_frequency) VALUES ($1,'password_reset','off')`, [U1]);
    const { rows } = await enqueue({ p_event_key: `'password_reset'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'pr1'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].channel).toBe('email');
  });

  it('a required event with a HARD-SUPPRESSED address records a skipped row (not silence)', async () => {
    const { rows } = await enqueue({ p_event_key: `'password_reset'`, p_recipient_person_id: `'${P2}'`, p_idempotency_subject: `'pr1'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('email_suppressed');
  });

  it('a required event with NO address on file records a skipped row with reason no_email_contact', async () => {
    const { rows } = await enqueue({ p_event_key: `'password_reset'`, p_recipient_person_id: `'${P3}'`, p_idempotency_subject: `'pr1'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('no_email_contact');
  });

  it('a NON-required event with a suppressed address is simply silent (no skipped row)', async () => {
    const { rows } = await enqueue({ p_event_key: `'booking_cancelled_player'`, p_recipient_person_id: `'${P2}'`, p_idempotency_subject: `'c1'` });
    expect(rows).toHaveLength(0);
    expect(await countOutbox()).toBe(0);
  });
});

describe('whatsapp requires BOTH gates: a whatsapp preference AND an opted-in in-scope contact', () => {
  // gate 1 (cadence): event default_whatsapp_frequency is 'off' → user must opt in per event
  const wantWa = () =>
    db.query(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency) VALUES ($1,'booking_confirmed_player','instant')`, [U1]);
  // gate 2 (channel/legal): an opted-in, in-scope whatsapp contact
  const addWa = (scope: string, cA: string | null, cT: string | null, status = 'opted_in') =>
    db.query(
      `INSERT INTO public.notification_contacts
         (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id, consent_trainer_id)
       VALUES ($1,'whatsapp','+31600000009','•••0009',$2,$3,$4,$5)`,
      [P1, status, scope, cA, cT]);
  const enqueueP1 = (over: Record<string, string> = {}) =>
    enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'`, ...over });

  it('gate 1 alone (preference, no contact) → no whatsapp', async () => {
    await wantWa();
    expect((await enqueueP1()).rows.map((r) => r.channel).sort()).toEqual(['email']);
  });

  it('gate 2 alone (contact opted-in, no preference → default off) → no whatsapp', async () => {
    await addWa('global', null, null);
    expect((await enqueueP1()).rows.map((r) => r.channel).sort()).toEqual(['email']);
  });

  it('BOTH gates with a GLOBAL opt-in → whatsapp fires alongside email', async () => {
    await wantWa(); await addWa('global', null, null);
    const { rows } = await enqueueP1();
    expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'whatsapp']);
    const wa = rows.find((r) => r.channel === 'whatsapp')!;
    expect(wa.destination_normalized).toBe('+31600000009');
    expect(wa.destination_redacted).toBe('•••0009');
  });

  it('a TENANT-scoped opt-in for academy A is DENIED when the notification is for academy B', async () => {
    await wantWa(); await addWa('tenant', A, null);
    expect((await enqueueP1({ p_tenant_academy_profile_id: `'${B}'` })).rows.map((r) => r.channel).sort()).toEqual(['email']);
  });

  it('the same tenant-scoped opt-in IS usable when the notification is for academy A', async () => {
    await wantWa(); await addWa('tenant', A, null);
    expect((await enqueueP1({ p_tenant_academy_profile_id: `'${A}'` })).rows.map((r) => r.channel).sort()).toEqual(['email', 'whatsapp']);
  });

  it('an opted-OUT whatsapp contact is never used even with the preference on', async () => {
    await wantWa(); await addWa('global', null, null, 'opted_out');
    expect((await enqueueP1()).rows.map((r) => r.channel).sort()).toEqual(['email']);
  });
});

describe('whatsapp is registered-only for now (P2: guests have no prefs_v2 cadence)', () => {
  it('a guest with an opted-in in-scope whatsapp contact still gets NO whatsapp — only email', async () => {
    // in-scope email contact → the event has a deliverable channel...
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id)
       VALUES ($1,'email','guest-a@example.com','g***@example.com','opted_in','tenant',$2)`, [PG, A]);
    // ...and an opted-in in-scope whatsapp contact that STILL must not fire: a guest can't
    // express a non-off whatsapp cadence (prefs_v2 is user_id-keyed), and the default is 'off'.
    await db.query(
      `INSERT INTO public.notification_contacts (person_id, channel, destination_normalized, destination_redacted, consent_status, consent_scope, consent_academy_profile_id)
       VALUES ($1,'whatsapp','+31600000077','•••0077','opted_in','tenant',$2)`, [PG, A]);
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_guest_player_id: `'${G1}'`, p_idempotency_subject: `'b1'`, p_tenant_academy_profile_id: `'${A}'` });
    expect(rows.map((r) => r.channel).sort()).toEqual(['email']);
  });
});

describe('tenant-visible events', () => {
  it('raise when a tenant-visible event is enqueued with no tenant context', async () => {
    await expect(enqueue({ p_event_key: `'booking_confirmed_staff'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'s1'` }))
      .rejects.toThrow(/no tenant context/i);
  });

  it('with tenant context but no summary, the resolver supplies a sanitized public_summary', async () => {
    const { rows } = await enqueue({ p_event_key: `'booking_confirmed_staff'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'s1'`, p_tenant_academy_profile_id: `'${A}'` });
    expect(rows).toHaveLength(1);
    expect(rows[0].visibility_scope).toBe('tenant_visible');
    expect(rows[0].public_summary).toEqual({ event_type: 'booking_confirmed_staff' });
  });
});

describe('collapse windowing', () => {
  it('a collapse-window event sets collapse_key; a zero-window event leaves it null', async () => {
    const staff = await enqueue({ p_event_key: `'booking_confirmed_staff'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'s1'`, p_tenant_academy_profile_id: `'${A}'` }); // window 15
    expect(staff.rows[0].collapse_key).toMatch(/^booking_confirmed_staff:email:/);
    const player = await enqueue({ p_event_key: `'booking_confirmed_player'`, p_recipient_person_id: `'${P1}'`, p_idempotency_subject: `'b1'` }); // window 0
    expect(player.rows[0].collapse_key).toBeNull();
  });
});

describe('lockdown — resolver + redaction helper are service-role-only', () => {
  it('anon and authenticated CANNOT execute enqueue_notification; service_role can', async () => {
    const priv = async (role: string) => (await db.query<{ ok: boolean }>(
      `SELECT bool_and(has_function_privilege($1, p.oid, 'EXECUTE')) AS ok
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname IN ('enqueue_notification','notification_redact_destination')`, [role])).rows[0].ok;
    expect(await priv('anon')).toBe(false);
    expect(await priv('authenticated')).toBe(false);
    expect(await priv('service_role')).toBe(true);
  });
});

describe('input validation', () => {
  it('raises on an unknown event_type', async () => {
    await expect(enqueue({ p_event_key: `'does_not_exist'`, p_recipient_person_id: `'${P1}'` }))
      .rejects.toThrow(/unknown event_type/i);
  });
  it('raises when no recipient is supplied', async () => {
    await expect(enqueue({ p_event_key: `'booking_confirmed_player'` }))
      .rejects.toThrow(/no recipient/i);
  });
});
