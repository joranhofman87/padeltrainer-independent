// @vitest-environment node
// Notification Foundation v2 — PR 7: the tenant-visible timeline READ RPCs
// (migration 20260917100000). These are SECURITY DEFINER over service-role-only tables, so
// the auth-binding IS the security story. Pins:
//   * player SELF visibility — the signed-in player sees their own private_user_only rows,
//   * academy-manager visibility — only tenant_visible rows carrying THEIR academy,
//   * trainer visibility — only tenant_visible rows carrying THEIR trainer,
//   * CROSS-TENANT DENIAL — both at the subject gate (42501 on another tenant's booking/
//     invoice) and at the row filter (another academy's row on a shared subject is invisible),
//   * staff never see a player's private confirmation, nobody sees admin_only,
//   * PII-SAFE SHAPE — the projection carries no raw destination / contact_id / recipient ids
//     / idempotency_key.
// Runs the REAL notification schema + the REAL PR-7 migration on top of faithful stand-ins of
// the pre-existing auth helpers (is_admin / is_academy_manager / get_my_person_id /
// get_profile_id_for_user / can_manage_slot / get_person_refs_for_scope).
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1'; // academy 1
const A2 = '0a000000-0000-0000-0000-0000000000a2'; // academy 2
const T1 = '0c000000-0000-0000-0000-0000000000c1'; // trainer of academy 1
const T2 = '0c000000-0000-0000-0000-0000000000c2'; // trainer of academy 2
const U_T1 = '0e000000-0000-0000-0000-0000000000e1';
const U_T2 = '0e000000-0000-0000-0000-0000000000e2';
const U_M1 = '0e000000-0000-0000-0000-0000000000e3'; // manager of academy 1
const U_M2 = '0e000000-0000-0000-0000-0000000000e4'; // manager of academy 2
const U_P1 = '0e000000-0000-0000-0000-0000000000e5'; // the player
const PR1 = '0f000000-0000-0000-0000-0000000000f1'; // player's profiles.id
const PE1 = '0d000000-0000-0000-0000-0000000000d1'; // player's persons.id
const PE_M1 = '0d000000-0000-0000-0000-0000000000d2'; // manager's person
const S1 = '01000000-0000-0000-0000-000000000011'; // slot: trainer T1, academy A1
const S2 = '01000000-0000-0000-0000-000000000012'; // slot: trainer T2, academy A2
const B1 = '02000000-0000-0000-0000-000000000021'; // booking on S1 by player PR1
const B2 = '02000000-0000-0000-0000-000000000022'; // booking on S2 (other tenant)
const INV1 = '03000000-0000-0000-0000-000000000031'; // invoice of academy A1 / trainer T1

const as = (uid: string | null) =>
  db.exec(`SELECT set_config('test.uid', ${uid ? `'${uid}'` : `''`}, false);`);

type Row = {
  outbox_id: string; delivery_event_id: string | null; event_type: string; channel: string;
  status: string; skip_reason: string | null; destination_redacted: string | null;
  public_summary: unknown; created_at: string; scheduled_for: string;
  sent_at: string | null; failed_at: string | null; occurred_at: string | null;
};

const bookingTimeline = (id: string) =>
  db.query<Row>(`SELECT * FROM public.get_booking_notification_timeline('${id}'::uuid)`);
const invoiceTimeline = (id: string) =>
  db.query<Row>(`SELECT * FROM public.get_invoice_notification_timeline('${id}'::uuid)`);
const selfTimeline = () =>
  db.query<Row>(`SELECT * FROM public.get_player_notification_timeline()`);
const staffPlayerTimeline = (scope: string, scopeId: string, profileId: string) =>
  db.query<Row>(`SELECT * FROM public.get_player_notification_timeline('${scope}', '${scopeId}'::uuid, NULL, '${profileId}'::uuid)`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    -- caller identity is settable per test; the RPCs are DEFINER so the ROLE does not matter
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);

    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id uuid, profile_id uuid, guest_player_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, trainer_id uuid);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_managers (user_id uuid, academy_profile_id uuid);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.availability_slots (id uuid PRIMARY KEY, trainer_id uuid, academy_profile_id uuid);
    CREATE TABLE public.bookings (id uuid PRIMARY KEY, slot_id uuid, player_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY, academy_profile_id uuid, trainer_id uuid);
    CREATE TABLE public.platform_admins (user_id uuid PRIMARY KEY);
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT false $fn$;
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text, recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());

    -- ---- faithful stand-ins of the pre-existing auth helpers the RPCs reuse ----
    CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id) $fn$;
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy_profile_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.academy_managers
                     WHERE user_id = _user_id AND academy_profile_id = _academy_profile_id) $fn$;
    CREATE OR REPLACE FUNCTION public.get_user_academy_ids(_user_id uuid) RETURNS SETOF uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT academy_profile_id FROM public.academy_managers WHERE user_id = _user_id $fn$;
    CREATE OR REPLACE FUNCTION public.get_my_person_id() RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT pl.person_id FROM public.person_links pl
      JOIN public.profiles p ON p.id = pl.profile_id WHERE p.user_id = auth.uid() LIMIT 1 $fn$;
    CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_user_id uuid) RETURNS uuid
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1 $fn$;
    CREATE OR REPLACE FUNCTION public.can_manage_slot(_user_id uuid, _slot_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      SELECT public.is_admin(_user_id)
        OR EXISTS (SELECT 1 FROM public.availability_slots s
                   JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
                   WHERE s.id = _slot_id AND tp.user_id = _user_id)
        OR EXISTS (SELECT 1 FROM public.availability_slots s
                   WHERE s.id = _slot_id AND s.academy_profile_id IS NOT NULL
                     AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))) $fn$;
    -- mirrors the real reader: scope pin (academy manager | owning trainer) then the refs
    CREATE OR REPLACE FUNCTION public.get_person_refs_for_scope(
      p_scope text, p_scope_id uuid, p_guest_id uuid DEFAULT NULL, p_profile_id uuid DEFAULT NULL)
      RETURNS TABLE (guest_ids uuid[], profile_id uuid, has_login boolean)
      LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
      BEGIN
        IF p_scope = 'academy' THEN
          IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
            RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
          END IF;
        ELSIF p_scope = 'trainer' THEN
          IF NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp
                         WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()) THEN
            RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
          END IF;
        ELSE
          RAISE EXCEPTION 'unknown scope %', p_scope USING ERRCODE = '22023';
        END IF;
        RETURN QUERY SELECT CASE WHEN p_guest_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_guest_id] END,
                            p_profile_id, true;
      END $fn$;
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260917100000_notification_tenant_timelines.sql'));

  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_T1}'),('${U_T2}'),('${U_M1}'),('${U_M2}'),('${U_P1}');
    INSERT INTO public.persons (id, user_id, email) VALUES ('${PE1}','${U_P1}','p@x.com'), ('${PE_M1}','${U_M1}','m@x.com');
    INSERT INTO public.profiles (id, user_id) VALUES ('${PR1}','${U_P1}');
    INSERT INTO public.person_links (person_id, profile_id) VALUES ('${PE1}','${PR1}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}'),('${A2}');
    INSERT INTO public.academy_managers (user_id, academy_profile_id) VALUES ('${U_M1}','${A1}'),('${U_M2}','${A2}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}','${U_T1}'),('${T2}','${U_T2}');
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id) VALUES
      ('${S1}','${T1}','${A1}'), ('${S2}','${T2}','${A2}');
    INSERT INTO public.bookings (id, slot_id, player_id) VALUES ('${B1}','${S1}','${PR1}'), ('${B2}','${S2}',NULL);
    INSERT INTO public.invoices (id, academy_profile_id, trainer_id) VALUES ('${INV1}','${A1}','${T1}');

    -- the player's own PRIVATE confirmation (booking + invoice related)
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_person_id, recipient_user_id, visibility_scope,
       related_booking_ids, related_invoice_id, destination_redacted, destination_normalized,
       idempotency_key, status, sent_at)
    VALUES ('booking_confirmed_player','email','${PE1}','${U_P1}','private_user_only',
       ARRAY['${B1}']::uuid[], '${INV1}', 'p***@x.com', 'player@example.com',
       'booking_confirmed_player:pay1:${PE1}', 'sent', now());

    -- the ACADEMY manager's staff row (tenant_visible, academy A1)
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_person_id, recipient_user_id, tenant_academy_profile_id,
       visibility_scope, public_summary, related_booking_ids, related_invoice_id,
       destination_redacted, destination_normalized, idempotency_key, status)
    VALUES ('booking_confirmed_staff','email','${PE_M1}','${U_M1}','${A1}',
       'tenant_visible','{"event_type":"booking_confirmed_staff","sessions":1}'::jsonb,
       ARRAY['${B1}']::uuid[], '${INV1}', 'm***@x.com', 'manager@example.com',
       'booking_confirmed_staff:pay1:${PE_M1}', 'pending');

    -- the TRAINER's staff row (tenant_visible, trainer T1)
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_user_id, tenant_trainer_id, visibility_scope, public_summary,
       related_booking_ids, related_invoice_id, destination_redacted, destination_normalized,
       idempotency_key, status)
    VALUES ('booking_confirmed_staff','email','${U_T1}','${T1}',
       'tenant_visible','{"event_type":"booking_confirmed_staff","sessions":1}'::jsonb,
       ARRAY['${B1}']::uuid[], '${INV1}', 't***@x.com', 'trainer@example.com',
       'booking_confirmed_staff:pay1:trainer', 'pending');

    -- a FOREIGN academy's row planted on the SAME booking/invoice (cross-tenant probe)
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_user_id, tenant_academy_profile_id, visibility_scope, public_summary,
       related_booking_ids, related_invoice_id, destination_redacted, destination_normalized,
       idempotency_key, status)
    VALUES ('booking_confirmed_staff','email','${U_M2}','${A2}',
       'tenant_visible','{"event_type":"booking_confirmed_staff"}'::jsonb,
       ARRAY['${B1}']::uuid[], '${INV1}', 'x***@x.com', 'foreign@example.com',
       'booking_confirmed_staff:pay1:foreign', 'pending');
  `);
});

describe('player SELF timeline', () => {
  it('the signed-in player sees their OWN private confirmation', async () => {
    await as(U_P1);
    const { rows } = await selfTimeline();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('booking_confirmed_player');
    expect(rows[0].destination_redacted).toBe('p***@x.com');
    expect(rows[0].status).toBe('sent');
  });

  it('the player does NOT see staff rows (not addressed to them)', async () => {
    await as(U_P1);
    const { rows } = await selfTimeline();
    expect(rows.every((r) => r.event_type !== 'booking_confirmed_staff')).toBe(true);
  });

  it('an unauthenticated caller is rejected', async () => {
    await as(null);
    await expect(selfTimeline()).rejects.toThrow(/not authenticated/);
  });
});

describe('booking timeline — tenant scoping', () => {
  it('ACADEMY MANAGER sees only their academy row — not the player private row, not the foreign academy row', async () => {
    await as(U_M1);
    const { rows } = await bookingTimeline(B1);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('booking_confirmed_staff');
    expect(rows[0].destination_redacted).toBe('m***@x.com');
  });

  it('TRAINER sees only their own trainer-scoped row', async () => {
    await as(U_T1);
    const { rows } = await bookingTimeline(B1);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination_redacted).toBe('t***@x.com');
  });

  it('the booking PLAYER sees their own private row (and no staff rows)', async () => {
    await as(U_P1);
    const { rows } = await bookingTimeline(B1);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('booking_confirmed_player');
  });

  it('CROSS-TENANT subject gate: academy-2 manager cannot open academy-1s booking at all', async () => {
    await as(U_M2);
    await expect(bookingTimeline(B1)).rejects.toThrow(/not authorized for booking/);
  });

  it('CROSS-TENANT subject gate: academy-1 manager cannot open academy-2s booking', async () => {
    await as(U_M1);
    await expect(bookingTimeline(B2)).rejects.toThrow(/not authorized for booking/);
  });

  // A tenant_visible row belongs to its TENANT, not to whoever is in a recipient column.
  // Being the addressee must NOT bypass the tenant-scope check, or a malformed / mis-routed
  // row carrying a FOREIGN tenant ref would leak to the caller purely via their user id.
  it('CROSS-TENANT row filter: a foreign-tenant row ADDRESSED TO the caller is still invisible', async () => {
    await db.exec(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_user_id, tenant_academy_profile_id, visibility_scope,
         public_summary, related_booking_ids, destination_redacted, idempotency_key, status)
      VALUES ('booking_confirmed_staff','email','${U_M1}','${A2}','tenant_visible',
         '{"event_type":"booking_confirmed_staff"}'::jsonb, ARRAY['${B1}']::uuid[],
         'leak***@x.com', 'booking_confirmed_staff:misrouted:${U_M1}', 'pending');`);
    await as(U_M1); // academy-1 manager: addressee of the row, but A2 is outside their scope
    const { rows } = await bookingTimeline(B1);
    expect(rows.some((r) => r.destination_redacted === 'leak***@x.com')).toBe(false);
    expect(rows).toHaveLength(1); // still just their legitimate academy-1 row
    expect(rows[0].destination_redacted).toBe('m***@x.com');
  });
});

describe('invoice timeline — tenant scoping', () => {
  it('ACADEMY MANAGER sees their academy staff row, never the players private confirmation', async () => {
    await as(U_M1);
    const { rows } = await invoiceTimeline(INV1);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('booking_confirmed_staff');
    expect(rows.some((r) => r.event_type === 'booking_confirmed_player')).toBe(false);
  });

  it('the owning TRAINER sees their own row', async () => {
    await as(U_T1);
    const { rows } = await invoiceTimeline(INV1);
    expect(rows).toHaveLength(1);
    expect(rows[0].destination_redacted).toBe('t***@x.com');
  });

  it('CROSS-TENANT: a foreign academy manager is refused the invoice entirely', async () => {
    await as(U_M2);
    await expect(invoiceTimeline(INV1)).rejects.toThrow(/not authorized for invoice/);
  });
});

describe('player timeline — staff (tenant) mode', () => {
  it('is legitimately EMPTY for a staff viewer while player events are private_user_only', async () => {
    await as(U_M1);
    const { rows } = await staffPlayerTimeline('academy', A1, PR1);
    expect(rows).toHaveLength(0);
  });

  it('CROSS-TENANT: a foreign academy manager is refused by the person-scope gate', async () => {
    await as(U_M2);
    await expect(staffPlayerTimeline('academy', A1, PR1)).rejects.toThrow(/not authorized for academy/);
  });
});

describe('PII-safe projection', () => {
  it('returns ONLY the safe columns — no raw destination, contact/recipient ids or idempotency key', async () => {
    await as(U_M1);
    const { rows } = await bookingTimeline(B1);
    const cols = Object.keys(rows[0]).sort();
    expect(cols).toEqual([
      'channel', 'created_at', 'delivery_event_id', 'destination_redacted', 'event_type',
      'failed_at', 'occurred_at', 'outbox_id', 'public_summary', 'scheduled_for',
      'sent_at', 'skip_reason', 'status',
    ]);
    for (const banned of ['destination_normalized', 'contact_id', 'recipient_person_id', 'recipient_user_id', 'recipient_guest_player_id', 'idempotency_key', 'payload']) {
      expect(cols).not.toContain(banned);
    }
    expect(JSON.stringify(rows)).not.toContain('manager@example.com'); // the raw address never leaves
  });
});

describe('admin_only rows', () => {
  it('are hidden from tenant staff AND from the recipient themselves', async () => {
    await db.exec(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_person_id, recipient_user_id, visibility_scope,
         related_booking_ids, destination_redacted, idempotency_key, status)
      VALUES ('booking_confirmed_player','email','${PE1}','${U_P1}','admin_only',
         ARRAY['${B1}']::uuid[], 'a***@x.com', 'admin_only:probe:${PE1}', 'pending');`);
    await as(U_P1);
    expect((await bookingTimeline(B1)).rows.some((r) => r.destination_redacted === 'a***@x.com')).toBe(false);
    await as(U_M1);
    expect((await bookingTimeline(B1)).rows.some((r) => r.destination_redacted === 'a***@x.com')).toBe(false);
  });
});
