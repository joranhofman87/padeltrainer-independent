// @vitest-environment node
// Notification Foundation v2 — PR 9: E.164 normalization + WhatsApp consent (migration
// 20260918100000). WhatsApp differs from email in that consent is REQUIRED, so these pins
// cover the fail-closed paths as much as the happy one:
//   * normalize_phone_e164 returns NULL for anything it cannot normalize CONFIDENTLY
//     (a wrong guess doesn't error — it messages a stranger),
//   * opt-in is auth-bound (you may only opt in yourself),
//   * opt-out is platform-wide (a STOP addresses the sender, not one academy),
//   * and the resolver still refuses whatsapp unless BOTH gates pass: an opted-in,
//     in-tenant-scope contact AND a non-off cadence.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1';
const A2 = '0a000000-0000-0000-0000-0000000000a2';
const T1 = '0c000000-0000-0000-0000-0000000000c1';
const U_P = '0e000000-0000-0000-0000-0000000000e1';  // the player's login
const P_P = '0d000000-0000-0000-0000-0000000000d1';  // the player's person
const U_O = '0e000000-0000-0000-0000-0000000000e2';  // someone else
const P_O = '0d000000-0000-0000-0000-0000000000d2';
const PR_P = '0f000000-0000-0000-0000-0000000000f1'; // profiles row for U_P

const as = (uid: string | null) =>
  db.exec(`SELECT set_config('test.uid', ${uid ? `'${uid}'` : `''`}, false);`);

const norm = async (input: string | null) =>
  (await db.query<{ v: string | null }>(
    `SELECT public.normalize_phone_e164(${input === null ? 'NULL' : `'${input}'`}) AS v`)).rows[0].v;

const optIn = (person: string, phone: string, academy: string | null, trainer: string | null, source = 'settings') =>
  db.query<{ record_whatsapp_optin: string | null }>(
    `SELECT public.record_whatsapp_optin('${person}', '${phone}',
       ${academy ? `'${academy}'` : 'NULL'}, ${trainer ? `'${trainer}'` : 'NULL'}, '${source}') AS record_whatsapp_optin`);

const contactsFor = (phone: string) =>
  db.query<{ person_id: string; consent_status: string; consent_scope: string; consent_academy_profile_id: string | null; consent_trainer_id: string | null; destination_redacted: string; consent_source: string; revoked_at: string | null }>(
    `SELECT person_id, consent_status, consent_scope, consent_academy_profile_id, consent_trainer_id,
            destination_redacted, consent_source, revoked_at
     FROM public.notification_contacts WHERE channel='whatsapp' AND destination_normalized='${phone}' ORDER BY person_id`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text, phone text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid);
    CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
    CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id) $fn$;
    CREATE OR REPLACE FUNCTION public.get_my_person_id() RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT pl.person_id FROM public.person_links pl
      JOIN public.profiles p ON p.id = pl.profile_id WHERE p.user_id = auth.uid() LIMIT 1 $fn$;
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text, recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(MIG('20260915100000_notification_paid_booking_player.sql')); // the contacts index rework the upsert targets
  await db.exec(MIG('20260918100000_notification_whatsapp_consent.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_P}'), ('${U_O}');
    INSERT INTO public.persons (id, user_id, email) VALUES ('${P_P}','${U_P}','p@x.com'), ('${P_O}','${U_O}','o@x.com');
    INSERT INTO public.profiles (id, user_id) VALUES ('${PR_P}','${U_P}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${P_P}','${PR_P}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}'), ('${A2}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}', NULL);
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id)
      VALUES ('01000000-0000-0000-0000-000000000011','${T1}','${A1}');
    -- the player has played at academy 1 (and therefore trainer 1); NOTHING at academy 2
    INSERT INTO public.bookings (id, slot_id, player_id)
      VALUES ('02000000-0000-0000-0000-000000000021','01000000-0000-0000-0000-000000000011','${PR_P}');
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.notification_contacts; DELETE FROM public.notification_outbox; DELETE FROM public.notification_preferences_v2;`);
  await as(null); // default: service_role context
});

describe('normalize_phone_e164 — fails closed', () => {
  it('normalizes the shapes people actually type', async () => {
    expect(await norm('06 12345678')).toBe('+31612345678');       // NL national
    expect(await norm('+31 6 1234 5678')).toBe('+31612345678');   // spaced international
    expect(await norm('0031612345678')).toBe('+31612345678');     // 00 prefix
    expect(await norm('(06) 1234-5678')).toBe('+31612345678');    // punctuation
    expect(await norm('+44 7911 123456')).toBe('+447911123456');  // non-NL kept as given
  });

  it('returns NULL rather than GUESSING for a bare number with no + and no leading 0', async () => {
    // '612345678' could be a Dutch mobile missing its 0, or a foreign number missing its +.
    // Guessing here would message a stranger, so it is rejected.
    expect(await norm('612345678')).toBeNull();
  });

  it('returns NULL for junk, empty and too-short input', async () => {
    expect(await norm('abc')).toBeNull();
    expect(await norm('')).toBeNull();
    expect(await norm(null)).toBeNull();
    expect(await norm('+3161')).toBeNull();          // too short for E.164
    expect(await norm('+0123456789')).toBeNull();    // country code cannot start with 0
  });
});

describe('record_whatsapp_optin', () => {
  it('creates an OPTED-IN, academy-scoped contact with a redacted destination', async () => {
    const id = (await optIn(P_P, '06 12345678', A1, null, 'booking_form')).rows[0].record_whatsapp_optin;
    expect(id).toBeTruthy();
    const [c] = (await contactsFor('+31612345678')).rows;
    expect(c.person_id).toBe(P_P);
    expect(c.consent_status).toBe('opted_in');
    expect(c.consent_scope).toBe('tenant');
    expect(c.consent_academy_profile_id).toBe(A1);
    expect(c.consent_trainer_id).toBeNull();       // academy-when-present (PR 6a rule)
    expect(c.consent_source).toBe('booking_form');
    expect(c.destination_redacted).toMatch(/•••5678$/); // never the raw number
    expect(c.revoked_at).toBeNull();
  });

  it('falls back to trainer scope when there is no academy', async () => {
    await optIn(P_P, '0612345678', null, T1);
    const [c] = (await contactsFor('+31612345678')).rows;
    expect(c.consent_academy_profile_id).toBeNull();
    expect(c.consent_trainer_id).toBe(T1);
  });

  it('returns NULL and stores NOTHING for an unnormalizable phone', async () => {
    expect((await optIn(P_P, '612345678', A1, null)).rows[0].record_whatsapp_optin).toBeNull();
    expect((await contactsFor('+31612345678')).rows).toHaveLength(0);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_contacts`)).rows[0].n).toBe(0);
  });

  it('returns NULL when no tenant is given (a tenant consent must name its tenant)', async () => {
    expect((await optIn(P_P, '0612345678', null, null)).rows[0].record_whatsapp_optin).toBeNull();
  });

  it('AUTH-BOUND: an authenticated user cannot opt in someone else', async () => {
    await as(U_P);   // signed in as the player...
    // ...trying to opt in a DIFFERENT person
    await expect(optIn(P_O, '0612345678', A1, null)).rejects.toThrow(/not authorized/);
    expect((await contactsFor('+31612345678')).rows).toHaveLength(0);
    await as(null);
  });

  it('is idempotent for the same person+number (one contact, refreshed)', async () => {
    const a = (await optIn(P_P, '0612345678', A1, null)).rows[0].record_whatsapp_optin;
    const b = (await optIn(P_P, '+31612345678', A1, null)).rows[0].record_whatsapp_optin;
    expect(a).toBe(b);
    expect((await contactsFor('+31612345678')).rows).toHaveLength(1);
  });
});

describe('record_whatsapp_optout — platform-wide', () => {
  it('revokes EVERY contact on that number, across tenants', async () => {
    await optIn(P_P, '0612345678', A1, null);
    await optIn(P_O, '0612345678', A2, null);   // same number, different person + academy
    expect((await contactsFor('+31612345678')).rows).toHaveLength(2);

    const n = (await db.query<{ record_whatsapp_optout: number }>(
      `SELECT public.record_whatsapp_optout('06 12345678') AS record_whatsapp_optout`)).rows[0].record_whatsapp_optout;
    expect(n).toBe(2);
    for (const c of (await contactsFor('+31612345678')).rows) {
      expect(c.consent_status).toBe('opted_out');
      expect(c.revoked_at).not.toBeNull();
    }
  });

  it('is a no-op (0) for an unnormalizable number', async () => {
    const n = (await db.query<{ record_whatsapp_optout: number }>(
      `SELECT public.record_whatsapp_optout('nonsense') AS record_whatsapp_optout`)).rows[0].record_whatsapp_optout;
    expect(n).toBe(0);
  });

  it('re-opting in after a STOP clears the revocation', async () => {
    await optIn(P_P, '0612345678', A1, null);
    await db.exec(`SELECT public.record_whatsapp_optout('0612345678')`);
    expect((await contactsFor('+31612345678')).rows[0].consent_status).toBe('opted_out');
    await optIn(P_P, '0612345678', A1, null);
    const [c] = (await contactsFor('+31612345678')).rows;
    expect(c.consent_status).toBe('opted_in');
    expect(c.revoked_at).toBeNull();
  });
});

describe('a new number RETIRES the old one', () => {
  it('opting in with a new phone revokes the previous number and marks the new one primary', async () => {
    await optIn(P_P, '0612345678', A1, null);
    await optIn(P_P, '0698765432', A1, null);          // person changed their number

    const oldC = (await contactsFor('+31612345678')).rows[0];
    const newC = (await contactsFor('+31698765432')).rows[0];
    // The OLD number must be revoked, not merely de-primaried: after recycling it may belong
    // to a stranger, and the resolver's ORDER BY is non-deterministic between two opted-in rows.
    expect(oldC.consent_status).toBe('opted_out');
    expect(oldC.revoked_at).not.toBeNull();
    expect(newC.consent_status).toBe('opted_in');
    expect(newC.revoked_at).toBeNull();
  });

  it('so the resolver can only pick the NEW number', async () => {
    await optIn(P_P, '0612345678', A1, null);
    await optIn(P_P, '0698765432', A1, null);
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency)
                   VALUES ('${U_P}', 'session_reminder_player', 'instant')`);
    const rows = (await db.query<{ channel: string; destination_normalized: string | null }>(`
      SELECT channel, destination_normalized FROM public.enqueue_notification(
        'session_reminder_player', NULL, '${U_P}'::uuid, NULL, '${A1}'::uuid, NULL,
        NULL, NULL, NULL, 'pay_new', NULL, '{"subject":"s","html":"h"}'::jsonb)`)).rows;
    const wa = rows.find((r) => r.channel === 'whatsapp');
    expect(wa?.destination_normalized).toBe('+31698765432');
  });
});

describe('caller-supplied tenant ids are validated for authenticated callers', () => {
  it('CROSS-TENANT DENIAL: a user cannot consent to an academy they have never played at', async () => {
    await as(U_P);
    // the player has bookings at academy 1 only
    await expect(optIn(P_P, '0612345678', A2, null)).rejects.toThrow(/no relationship with that tenant/);
    expect((await contactsFor('+31612345678')).rows).toHaveLength(0);
    await as(null);
  });

  it('allows a tenant the person actually plays at', async () => {
    await as(U_P);
    const id = (await optIn(P_P, '0612345678', A1, null)).rows[0].record_whatsapp_optin;
    expect(id).toBeTruthy();
    await as(null);
  });

  it('service_role (our own booking flow) may still act before a relationship exists', async () => {
    await as(null);   // service_role context
    const id = (await optIn(P_O, '0698765432', A2, null)).rows[0].record_whatsapp_optin;
    expect(id).toBeTruthy();   // P_O has no bookings at all
  });
});

describe('lockdown — person_has_tenant_relationship stays INTERNAL', () => {
  // SECURITY DEFINER + RLS bypass + "does person X know tenant Y?" = a relationship oracle if
  // a client can call it. record_whatsapp_optin is itself DEFINER, so it calls this with the
  // definer's privileges and does not need the caller to hold EXECUTE.
  const canExec = async (role: string) =>
    (await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege($1, 'public.person_has_tenant_relationship(uuid,uuid,uuid)', 'EXECUTE') AS ok`,
      [role])).rows[0].ok;

  it('anon and authenticated CANNOT execute it; service_role can', async () => {
    expect(await canExec('anon')).toBe(false);
    expect(await canExec('authenticated')).toBe(false);
    expect(await canExec('service_role')).toBe(true);
  });

  it('and the authenticated opt-in path still works despite that revoke', async () => {
    await as(U_P);
    expect((await optIn(P_P, '0612345678', A1, null)).rows[0].record_whatsapp_optin).toBeTruthy();
    await as(null);
  });
});

describe('the resolver still gates whatsapp on BOTH consent and cadence', () => {
  const enqueue = (academy: string) =>
    db.query<{ channel: string; status: string; destination_normalized: string | null }>(`
      SELECT channel, status, destination_normalized FROM public.enqueue_notification(
        'session_reminder_player', NULL, '${U_P}'::uuid, NULL, '${academy}'::uuid, NULL,
        NULL, NULL, NULL, 'pay_wa', NULL, '{"subject":"s","html":"h"}'::jsonb)`);

  it('an opted-in contact alone is NOT enough — cadence defaults to off', async () => {
    await optIn(P_P, '0612345678', A1, null);
    const rows = (await enqueue(A1)).rows;
    expect(rows.some((r) => r.channel === 'whatsapp')).toBe(false); // email only
  });

  it('with consent AND a non-off cadence, whatsapp is enqueued to the E.164 number', async () => {
    await optIn(P_P, '0612345678', A1, null);
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency)
                   VALUES ('${U_P}', 'session_reminder_player', 'instant')`);
    const wa = (await enqueue(A1)).rows.find((r) => r.channel === 'whatsapp');
    expect(wa).toBeTruthy();
    expect(wa!.destination_normalized).toBe('+31612345678');
  });

  it('after a STOP, whatsapp is refused even with a non-off cadence', async () => {
    await optIn(P_P, '0612345678', A1, null);
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency)
                   VALUES ('${U_P}', 'session_reminder_player', 'instant')`);
    await db.exec(`SELECT public.record_whatsapp_optout('0612345678')`);
    const rows = (await enqueue(A1)).rows;
    expect(rows.some((r) => r.channel === 'whatsapp')).toBe(false);
  });

  it('consent for ANOTHER academy does not authorise this one', async () => {
    await optIn(P_P, '0612345678', A2, null);   // opted in for academy 2
    await db.exec(`INSERT INTO public.notification_preferences_v2 (user_id, event_type, whatsapp_frequency)
                   VALUES ('${U_P}', 'session_reminder_player', 'instant')`);
    const rows = (await enqueue(A1)).rows;      // ...but the notification is academy 1's
    expect(rows.some((r) => r.channel === 'whatsapp')).toBe(false);
  });
});
