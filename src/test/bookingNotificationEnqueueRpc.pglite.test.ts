// @vitest-environment node
// enqueue_booking_notification — the privileged, actor-callable enqueue (migration 20260926100000).
//
// This function is SECURITY DEFINER and takes a caller-supplied ARRAY of booking ids, which
// makes it the highest-risk surface in PR 10b. `supabase db reset` proves the SQL compiles; it
// proves nothing about who may call it or what it emits. These are the behaviour and DENIAL
// tests for the defects the first version actually had:
//
//   * authorization checked only booking[0], so appending someone else's ids escalated;
//   * `IF NOT (actor = trainer OR ...)` FAILED OPEN when the trainer had no account;
//   * a NULL intent fell through into the cancellation branch;
//   * one session table built from ALL bookings was emitted per booking — an email storm,
//     and a cross-player leak in a mixed set;
//   * intent was never checked against booking STATE;
//   * idempotency keyed on the first id, so reordering duplicated the mail.
//
// enqueue_notification is stubbed to CAPTURE its arguments: what matters here is exactly what
// this function decides to emit, to whom, under which key. The resolver has its own suites.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1';   // academy
const A2 = '0a000000-0000-0000-0000-0000000000a2';   // a DIFFERENT academy
const T1 = '0c000000-0000-0000-0000-0000000000c1';   // trainer (has an account)
const T2 = '0c000000-0000-0000-0000-0000000000c2';   // trainer under A2
const T3 = '0c000000-0000-0000-0000-0000000000c3';   // ORPHAN trainer: user_id IS NULL
const T1B = '0c000000-0000-0000-0000-0000000000c4';  // a SECOND trainer, also under A1 (own account)
const U_T1B = '0e000000-0000-0000-0000-0000000000eb';
const U_T = '0e000000-0000-0000-0000-0000000000e2';  // T1's login
const U_M = '0e000000-0000-0000-0000-0000000000e3';  // academy manager's login
const U_P1 = '0e000000-0000-0000-0000-0000000000e1'; // player 1 login
const U_P2 = '0e000000-0000-0000-0000-0000000000e4'; // player 2 login
const U_X = '0e000000-0000-0000-0000-0000000000e9';  // an unrelated logged-in stranger
const PR1 = '0f000000-0000-0000-0000-0000000000f1';  // player 1 profile
const PR2 = '0f000000-0000-0000-0000-0000000000f4';  // player 2 profile
const G1 = '0b000000-0000-0000-0000-0000000000b1';   // guest player

const as = (uid: string | null) =>
  db.exec(`SELECT set_config('test.uid', ${uid ? `'${uid}'` : `''`}, false);`);

const call = (ids: string[], kind: string | null) =>
  db.query<{ v: number }>(
    `SELECT public.enqueue_booking_notification(ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]::uuid[], ${kind === null ? 'NULL' : `'${kind}'`}) AS v`,
  );

const captured = async () =>
  (await db.query<{ event_key: string; ruser: string | null; rguest: string | null; subject: string; html: string; ids: string[] }>(
    `SELECT event_key, ruser, rguest, subject, html, ids FROM public._captured ORDER BY id`,
  )).rows;

const mkBooking = (id: string, slot: string, opts: { player?: string; guest?: string; status?: string; pay?: string } = {}) =>
  db.exec(`INSERT INTO public.bookings (id, slot_id, player_id, guest_player_id, status, payment_status)
           VALUES ('${id}', '${slot}', ${opts.player ? `'${opts.player}'` : 'NULL'},
                   ${opts.guest ? `'${opts.guest}'` : 'NULL'}, '${opts.status ?? 'confirmed'}',
                   ${opts.pay ? `'${opts.pay}'` : 'NULL'});`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
      SELECT nullif(current_setting('test.uid', true), '')::uuid $fn$;
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, user_id uuid, full_name text, email text);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.guest_players (id uuid PRIMARY KEY, full_name text);
    CREATE TABLE public.locations (id uuid PRIMARY KEY, name text, city text);
    CREATE TABLE public.availability_slots (
      id uuid PRIMARY KEY, trainer_id uuid NOT NULL, academy_profile_id uuid, location_id uuid,
      start_time timestamptz NOT NULL, end_time timestamptz NOT NULL, cyclus_name text,
      price_per_session numeric);
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_id uuid NOT NULL,
      player_id uuid, guest_player_id uuid, status text DEFAULT 'confirmed', payment_status text,
      payment_amount numeric);

    -- academy managers: U_M manages A1 only
    CREATE OR REPLACE FUNCTION public.is_academy_manager(_user_id uuid, _academy uuid)
      RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT _user_id = '${U_M}'::uuid AND _academy = '${A1}'::uuid $fn$;

    ALTER TABLE public.guest_players ADD COLUMN email text;
    CREATE TABLE public.notification_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), guest_player_id uuid, person_id uuid,
      channel text, destination_normalized text, destination_redacted text,
      consent_status text, consent_scope text, consent_academy_profile_id uuid,
      consent_trainer_id uuid, consent_source text, consent_at timestamptz,
      revoked_at timestamptz, updated_at timestamptz);
    CREATE UNIQUE INDEX ON public.notification_contacts (channel, guest_player_id)
      WHERE guest_player_id IS NOT NULL;
    CREATE OR REPLACE FUNCTION public.notification_redact_destination(d text, c text)
      RETURNS text LANGUAGE sql IMMUTABLE AS $fn$ SELECT '***' $fn$;
    -- identity resolver: returns nothing here, so the guest_players fallback is exercised
    CREATE OR REPLACE FUNCTION public.get_invoice_recipient_identity(
      _player_id uuid DEFAULT NULL, _guest_player_id uuid DEFAULT NULL, _academy_profile_id uuid DEFAULT NULL)
      RETURNS TABLE (email text) LANGUAGE sql STABLE AS $fn$ SELECT NULL::text WHERE false $fn$;

    -- capture stub for the resolver
    CREATE TABLE public._captured (
      id serial PRIMARY KEY, event_key text, ruser uuid, rguest uuid,
      subject text, html text, ids uuid[], idem text);
    CREATE OR REPLACE FUNCTION public.enqueue_notification(
      p_event_key text, p_recipient_person_id uuid DEFAULT NULL, p_recipient_user_id uuid DEFAULT NULL,
      p_recipient_guest_player_id uuid DEFAULT NULL, p_tenant_academy_profile_id uuid DEFAULT NULL,
      p_tenant_trainer_id uuid DEFAULT NULL, p_idempotency_subject text DEFAULT NULL,
      p_related_booking_ids uuid[] DEFAULT NULL, p_related_invoice_id uuid DEFAULT NULL,
      p_related_payment_id text DEFAULT NULL, p_template_key text DEFAULT NULL,
      p_payload jsonb DEFAULT '{}'::jsonb, p_public_summary jsonb DEFAULT NULL,
      p_scheduled_for timestamptz DEFAULT NULL)
      -- RETURNS TABLE like the real resolver, so the RPC's row COUNTING is exercised. It
      -- emits NO row when the idempotency key was already used, which is what makes the
      -- duplicate/no-op pin below meaningful.
      RETURNS TABLE (outbox_id uuid) LANGUAGE plpgsql AS $fn$
      BEGIN
        IF EXISTS (SELECT 1 FROM public._captured c WHERE c.idem = p_idempotency_subject) THEN
          RETURN;
        END IF;
        INSERT INTO public._captured (event_key, ruser, rguest, subject, html, ids, idem)
        VALUES (p_event_key, p_recipient_user_id, p_recipient_guest_player_id,
                p_payload->>'subject', p_payload->>'html', p_related_booking_ids, p_idempotency_subject);
        RETURN QUERY SELECT gen_random_uuid();
      END $fn$;
  `);

  await db.exec(MIG('20260926100000_booking_notification_enqueue_rpc.sql'));

  await db.exec(`
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}'), ('${A2}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}', '${U_T}'), ('${T2}', NULL), ('${T3}', NULL), ('${T1B}', '${U_T1B}');
    INSERT INTO public.profiles (id, user_id, full_name) VALUES
      ('${PR1}', '${U_P1}', 'Speler <Een>'), ('${PR2}', '${U_P2}', 'Speler Twee'),
      ('0f000000-0000-0000-0000-0000000000f2', '${U_T}', 'Trainer T'),
      ('0f000000-0000-0000-0000-0000000000f5', '${U_T1B}', 'Trainer B');
    UPDATE public.profiles SET email = 'speler1@example.com' WHERE id = '${PR1}';
    INSERT INTO public.guest_players (id, full_name, email) VALUES ('${G1}', 'Gast G', 'gast@example.com');
    INSERT INTO public.locations (id, name, city) VALUES
      ('0d000000-0000-0000-0000-0000000000d1', 'Hal <1>', 'Utrecht');
    INSERT INTO public.availability_slots (id, trainer_id, academy_profile_id, location_id, start_time, end_time) VALUES
      ('01000000-0000-0000-0000-000000000001', '${T1}', '${A1}', '0d000000-0000-0000-0000-0000000000d1', now() + interval '3 days', now() + interval '3 days 1 hour'),
      ('01000000-0000-0000-0000-000000000002', '${T1}', '${A1}', '0d000000-0000-0000-0000-0000000000d1', now() + interval '4 days', now() + interval '4 days 1 hour'),
      ('01000000-0000-0000-0000-000000000003', '${T2}', '${A2}', NULL, now() + interval '5 days', now() + interval '5 days 1 hour'),
      ('01000000-0000-0000-0000-000000000004', '${T3}', NULL,   NULL, now() + interval '6 days', now() + interval '6 days 1 hour'),
      ('01000000-0000-0000-0000-000000000006', '${T1B}', '${A1}', NULL, now() + interval '7 days', now() + interval '7 days 1 hour'),
      ('01000000-0000-0000-0000-000000000007', '${T1B}', NULL,   NULL, now() + interval '8 days', now() + interval '8 days 1 hour');
    UPDATE public.availability_slots SET price_per_session = 25, cyclus_name = 'Herfst <reeks>'
     WHERE id IN ('01000000-0000-0000-0000-000000000001','01000000-0000-0000-0000-000000000002');
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public._captured; DELETE FROM public.bookings;
                 DELETE FROM public.notification_contacts;`);
  await as(null);
});

const S1 = '01000000-0000-0000-0000-000000000001';
const S2 = '01000000-0000-0000-0000-000000000002';
const S_OTHER = '01000000-0000-0000-0000-000000000003';
const S_ORPHAN = '01000000-0000-0000-0000-000000000004';
const S_A1B = '01000000-0000-0000-0000-000000000006';   // T1B's slot, in academy A1
const S_INDEP2 = '01000000-0000-0000-0000-000000000007';   // T1B's slot, NO academy (independent)
const B1 = '02000000-0000-0000-0000-000000000001';
const B2 = '02000000-0000-0000-0000-000000000002';
const B_OTHER = '02000000-0000-0000-0000-000000000003';

describe('who may call it at all', () => {
  it('refuses an anonymous caller', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'pending_approval' });
    await expect(call([B1], 'request_staff')).rejects.toThrow(/no authenticated actor/);
  });

  it('refuses a NULL intent instead of falling through to cancellation', async () => {
    // `p_kind NOT IN (...)` is NULL for a NULL kind, so the guard used to be SKIPPED and the
    // IF/ELSIF chain landed in the ELSE branch — a null intent silently meant "cancelled".
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_P1);
    await expect(call([B1], null)).rejects.toThrow(/unknown kind/);
  });

  it('refuses an unknown intent', async () => {
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_P1);
    await expect(call([B1], 'something_else')).rejects.toThrow(/unknown kind/);
  });
});

describe('the WHOLE set is validated, not the first id', () => {
  it('refuses a set mixing another player\'s booking into an authorized one', async () => {
    // THE ESCALATION: book one slot yourself, then append a stranger's booking id.
    await mkBooking(B1, S1, { player: PR1, status: 'pending_approval' });
    await mkBooking(B2, S2, { player: PR2, status: 'pending_approval' });
    await as(U_P1);
    await expect(call([B1, B2], 'request_staff')).rejects.toThrow(/not the player on every booking/);
    expect(await captured()).toHaveLength(0);
  });

  it('refuses a set spanning two tenants', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await mkBooking(B_OTHER, S_OTHER, { player: PR1, status: 'cancelled' });
    await as(U_T);
    await expect(call([B1, B_OTHER], 'cancelled_player')).rejects.toThrow(/multiple academy scopes/);
  });

  it('refuses a set containing an id that does not exist', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'pending_approval' });
    await as(U_P1);
    await expect(call([B1, '02000000-0000-0000-0000-0000000000ff'], 'request_staff'))
      .rejects.toThrow(/unknown booking id/);
  });
});

describe('cancellation authorization fails CLOSED', () => {
  it('refuses a stranger', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await as(U_X);
    await expect(call([B1], 'cancelled_player')).rejects.toThrow(/does not own this slot/);
  });

  it('refuses when the trainer has NO account (the NULL fail-open)', async () => {
    // `IF NOT (actor = NULL OR ...)` evaluates to NULL → the RAISE was skipped → authorized.
    await mkBooking(B1, S_ORPHAN, { player: PR1, status: 'cancelled' });
    await as(U_X);
    await expect(call([B1], 'cancelled_player')).rejects.toThrow(/does not own this slot/);
    expect(await captured()).toHaveLength(0);
  });

  it('allows the slot owner, and an academy manager of THAT academy', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await as(U_T);
    expect((await call([B1], 'cancelled_player')).rows[0].v).toBe(1);
    await db.exec(`DELETE FROM public._captured;`);
    await as(U_M);
    expect((await call([B1], 'cancelled_player')).rows[0].v).toBe(1);
  });
});

describe('intent must match booking STATE', () => {
  it('refuses a cancellation announcement for a live booking', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'confirmed' });
    await as(U_T);
    await expect(call([B1], 'cancelled_player')).rejects.toThrow(/needs cancelled bookings/);
  });

  it('refuses a booking request for a booking that is not awaiting approval', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'confirmed' });
    await as(U_P1);
    await expect(call([B1], 'request_staff')).rejects.toThrow(/needs pending_approval/);
  });

  it('refuses a manual confirmation for a PAID booking — that is the paid path\'s job', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'confirmed', pay: 'paid' });
    await as(U_P1);
    await expect(call([B1], 'confirmation_player')).rejects.toThrow(/unpaid CONFIRMED/);
  });

  it('refuses a manual confirmation for a PENDING booking — the Mollie upfront state', async () => {
    // BookLesson's upfront cycle flow inserts status='pending', payment_status='pending'
    // immediately before redirecting to Mollie. Allowing 'pending' let a player call this and
    // receive a false "pay your trainer directly" confirmation, then the real paid one later.
    await mkBooking(B1, S1, { player: PR1, status: 'pending', pay: 'pending' });
    await as(U_P1);
    await expect(call([B1], 'confirmation_player')).rejects.toThrow(/unpaid CONFIRMED/);
  });
});

describe('staff booking on a player\'s behalf', () => {
  it('lets STAFF confirm for a REGISTERED player (BookForPlayerDialog)', async () => {
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_T);
    expect((await call([B1], 'confirmation_player')).rows[0].v).toBe(1);
    const rows = await captured();
    expect(rows[0].event_key).toBe('booking_confirmed_player');
    expect(rows[0].ruser).toBe(U_P1);
  });

  it('lets STAFF confirm for a GUEST player — who has no account at all', async () => {
    // The first version required the actor to BE the registered player, so this whole flow
    // was impossible: staff were rejected, and a guest had no recipient to address.
    await mkBooking(B1, S1, { guest: G1 });
    await as(U_T);
    expect((await call([B1], 'confirmation_player')).rows[0].v).toBe(1);
    const rows = await captured();
    expect(rows[0].rguest).toBe(G1);
    expect(rows[0].ruser).toBeNull();
  });

  it('still refuses a stranger confirming for someone else', async () => {
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_X);
    await expect(call([B1], 'confirmation_player')).rejects.toThrow(/neither the player nor the slot owner/);
  });

  it('refuses a confirmation covering two different recipients', async () => {
    await mkBooking(B1, S1, { player: PR1 });
    await mkBooking(B2, S2, { player: PR2 });
    await as(U_T);
    await expect(call([B1, B2], 'confirmation_player')).rejects.toThrow(/multiple recipients/);
  });
});

describe('cycle cancellation fans out per RECIPIENT, not per booking', () => {
  it('sends one email per player, each listing only their own sessions', async () => {
    // The storm + leak: N bookings produced N emails, each containing EVERY booking's rows.
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await mkBooking(B2, S2, { player: PR1, status: 'cancelled' });
    await mkBooking(B_OTHER, S2, { player: PR2, status: 'cancelled' });
    await as(U_T);
    expect((await call([B1, B2, B_OTHER], 'cancelled_player')).rows[0].v).toBe(2);

    const rows = await captured();
    expect(rows).toHaveLength(2);
    const p1 = rows.find((r) => r.ruser === U_P1)!;
    const p2 = rows.find((r) => r.ruser === U_P2)!;
    expect(p1.ids).toHaveLength(2);
    expect(p2.ids).toHaveLength(1);
    // and player 2's mail must not carry player 1's extra session
    expect(p2.html.match(/<tr>/g) ?? []).toHaveLength(1);
    expect(p1.html.match(/<tr>/g) ?? []).toHaveLength(2);
  });
});

describe('idempotency is derived from the canonical set', () => {
  it('is identical however the ids are ordered or duplicated', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await mkBooking(B2, S2, { player: PR1, status: 'cancelled' });
    await as(U_T);
    await call([B1, B2], 'cancelled_player');
    const first = (await db.query<{ idem: string }>(`SELECT idem FROM public._captured ORDER BY id`)).rows[0].idem;
    await db.exec(`DELETE FROM public._captured;`);
    await call([B2, B1, B1], 'cancelled_player');
    const second = (await db.query<{ idem: string }>(`SELECT idem FROM public._captured ORDER BY id`)).rows[0].idem;
    expect(second).toBe(first);
  });

  it('cannot collide with the paid path, which keys on the Mollie payment id', async () => {
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_P1);
    await call([B1], 'confirmation_player');
    const idem = (await db.query<{ idem: string }>(`SELECT idem FROM public._captured`)).rows[0].idem;
    expect(idem).toMatch(/^confirmation_player:/);
    expect(idem).not.toMatch(/^tr_/);
  });
});

describe('guests are made DELIVERABLE before enqueueing', () => {
  // The resolver only falls back to persons.email for ACCOUNT HOLDERS. Without a
  // tenant-scoped contact a guest-only recipient resolves to no_email_contact: a required
  // confirmation becomes a visible 'skipped' row, and a cancellation produces NO row at all.
  const contacts = async () =>
    (await db.query<{ guest_player_id: string; destination_normalized: string; consent_source: string; consent_scope: string; consent_trainer_id: string | null; consent_academy_profile_id: string | null }>(
      `SELECT guest_player_id, destination_normalized, consent_source, consent_scope,
              consent_trainer_id, consent_academy_profile_id FROM public.notification_contacts`)).rows;

  it('provisions a tenant-scoped contact for a staff-created GUEST confirmation', async () => {
    await mkBooking(B1, S1, { guest: G1 });
    await as(U_T);
    expect((await call([B1], 'confirmation_player')).rows[0].v).toBe(1);
    const c = await contacts();
    expect(c).toHaveLength(1);
    expect(c[0].destination_normalized).toBe('gast@example.com');
    expect(c[0].consent_scope).toBe('tenant');
    expect(c[0].consent_academy_profile_id).toBe(A1);
  });

  it('records PROVENANCE as staff_booking, not the paid path\'s label', async () => {
    // consent_source is the evidence for why we hold the address; borrowing 'paid_booking'
    // for a staff-created booking would be a false record.
    await mkBooking(B1, S1, { guest: G1 });
    await as(U_T);
    await call([B1], 'confirmation_player');
    expect((await contacts())[0].consent_source).toBe('staff_booking');
  });

  it('provisions for a guest CANCELLATION too (non-required: no row would exist at all)', async () => {
    await mkBooking(B1, S1, { guest: G1, status: 'cancelled' });
    await as(U_T);
    expect((await call([B1], 'cancelled_player')).rows[0].v).toBe(1);
    expect(await contacts()).toHaveLength(1);
  });

  it('is idempotent across repeated calls', async () => {
    await mkBooking(B1, S1, { guest: G1 });
    await as(U_T);
    await call([B1], 'confirmation_player');
    await call([B1], 'confirmation_player');
    expect(await contacts()).toHaveLength(1);
  });
});

describe('the caller-controlled array is bounded', () => {
  it('refuses an oversized TOTAL set (bound fires before the existence check)', async () => {
    await as(U_P1);
    const many = Array.from({ length: 2001 }, (_, i) =>
      `02000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    await expect(call(many, 'request_staff')).rejects.toThrow(/too many bookings in one call/);
  });
});

describe('identity resolution failure ABORTS — it must not fall back to raw data', () => {
  // PR 10a doctrine: recipient-discovery reads fail loudly. Swallowing this one would send to
  // a possibly-stale raw address AND permanently overwrite the tenant contact with it, since
  // the upsert refreshes destination_normalized. A stale address becoming authoritative is
  // worse than not sending.
  it('creates neither a contact nor an enqueue when the identity lookup throws', async () => {
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.get_invoice_recipient_identity(
        _player_id uuid DEFAULT NULL, _guest_player_id uuid DEFAULT NULL, _academy_profile_id uuid DEFAULT NULL)
        RETURNS TABLE (email text) LANGUAGE plpgsql STABLE AS $fn$
        BEGIN RAISE EXCEPTION 'identity backend unavailable'; END $fn$;`);
    await mkBooking(B1, S1, { guest: G1 });
    await as(U_T);
    await expect(call([B1], 'confirmation_player')).rejects.toThrow(/identity backend unavailable/);
    expect((await db.query(`SELECT 1 FROM public.notification_contacts`)).rows).toHaveLength(0);
    expect(await captured()).toHaveLength(0);
    // restore the no-override stub for the remaining tests
    await db.exec(`
      CREATE OR REPLACE FUNCTION public.get_invoice_recipient_identity(
        _player_id uuid DEFAULT NULL, _guest_player_id uuid DEFAULT NULL, _academy_profile_id uuid DEFAULT NULL)
        RETURNS TABLE (email text) LANGUAGE sql STABLE AS $fn$ SELECT NULL::text WHERE false $fn$;`);
  });
});

describe('the ported legacy content is present and escaped', () => {
  // Owner decision: a migration must not quietly reduce what a trainer can act on.
  it('the request mail keeps player contact, price, cycle title and a dashboard link', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'pending_approval' });
    await as(U_P1);
    await call([B1], 'request_staff');
    const html = (await captured())[0].html;
    expect(html).toContain('speler1@example.com');
    expect(html).toContain('&euro;25.00');
    expect(html).toContain('Herfst &lt;reeks&gt;');          // escaped, not raw
    expect(html).toContain('padeltrainer.ai/app/trainer/agenda');
    expect(html).not.toContain('Herfst <reeks>');
  });

  it('the manual confirmation keeps the cycle title and amount', async () => {
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_P1);
    await call([B1], 'confirmation_player');
    const html = (await captured())[0].html;
    expect(html).toContain('Herfst &lt;reeks&gt;');
    expect(html).toContain('&euro;25.00');
  });
});

describe('values reaching the HTML are escaped', () => {
  it('escapes player and location names', async () => {
    // 'Speler <Een>' and 'Hal <1>' are deliberately hostile fixtures.
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await as(U_T);
    await call([B1], 'cancelled_player');
    const html = (await captured())[0].html;
    expect(html).toContain('Hal &lt;1&gt;');
    expect(html).not.toContain('Hal <1>');
  });
});

describe('the returned count is ROWS ENQUEUED, not recipients attempted', () => {
  it('a duplicate call returns 0 — the idempotent no-op is not reported as a send', async () => {
    // The old code set v_count from the recipient list, so a repeat call (double-click,
    // retry, re-render) reported "1 enqueued" while the resolver correctly emitted nothing.
    // A count that cannot say "nothing happened" is not worth logging.
    await mkBooking(B1, S1, { player: PR1 });
    await as(U_P1);
    expect((await call([B1], 'confirmation_player')).rows[0].v).toBe(1);
    expect((await call([B1], 'confirmation_player')).rows[0].v).toBe(0);
    expect(await captured()).toHaveLength(1);
  });

  it('counts one row per RECIPIENT actually emitted in a cancellation fan-out', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await mkBooking(B2, S2, { player: PR2, status: 'cancelled' });
    await as(U_T);
    expect((await call([B1, B2], 'cancelled_player')).rows[0].v).toBe(2);
  });
});

describe('the ACL boundary is explicit', () => {
  // This repo runs ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions to anon and
  // authenticated, and a bare REVOKE FROM PUBLIC does NOT undo it. The migration revokes
  // explicitly and re-grants only to authenticated — but "the migration currently says the
  // right thing" is not the same as "the boundary holds", which is what this asserts.
  const canExec = async (role: string, sig: string) =>
    (await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig])).rows[0].ok;

  it('enqueue_booking_notification: anon=false, authenticated=true, service_role=true', async () => {
    const sig = 'public.enqueue_booking_notification(uuid[],text)';
    // authenticated CAN call it — that is the point of an actor-callable RPC; the actor
    // validation inside is what protects it, not the grant.
    expect(await canExec('authenticated', sig)).toBe(true);
    expect(await canExec('service_role', sig)).toBe(true);
    // anon must NOT: every intent here requires an identified actor.
    expect(await canExec('anon', sig), 'anon must never reach the enqueue RPC').toBe(false);
  });

  it('notification_html_escape stays service_role only', async () => {
    const sig = 'public.notification_html_escape(text)';
    expect(await canExec('service_role', sig)).toBe(true);
    expect(await canExec('anon', sig)).toBe(false);
    expect(await canExec('authenticated', sig)).toBe(false);
  });
});

describe('P1 #1 — guest-first canonical identity (FAM-02)', () => {
  const capturedFor = async () =>
    (await db.query<{ ruser: string | null; rguest: string | null; ids: string[] }>(
      `SELECT ruser, rguest, ids FROM public._captured ORDER BY id`)).rows;

  it('a DUAL-KEY booking (player_id AND guest_player_id) is addressed to the GUEST, never the profile', async () => {
    // The resolver prefers a registered profile if handed both, so passing both would mail the
    // wrong identity. Guest-first + XOR args prevent it.
    await mkBooking(B1, S1, { player: PR1, guest: G1, status: 'cancelled' });
    await as(U_T);
    expect((await call([B1], 'cancelled_player')).rows[0].v).toBe(1);
    const [row] = await capturedFor();
    expect(row.rguest, 'addressed as the guest').toBe(G1);
    expect(row.ruser, 'NOT the registered profile').toBeNull();
  });

  it('a guest-only row and a dual-key row for the SAME guest are ONE recipient (confirmation not rejected)', async () => {
    // The old DISTINCT (player_id, guest_player_id) counted these as two recipients and rejected
    // the confirmation. Canonical guest-first collapses them.
    await mkBooking(B1, S1, { guest: G1 });                    // guest-only
    await mkBooking(B2, S2, { player: PR1, guest: G1 });       // dual-key, same guest
    await as(U_T);
    expect((await call([B1, B2], 'confirmation_player')).rows[0].v, 'one recipient, both sessions').toBe(1);
    const rows = await capturedFor();
    expect(rows).toHaveLength(1);
    expect(rows[0].rguest).toBe(G1);
    expect(rows[0].ruser).toBeNull();
    expect(rows[0].ids).toHaveLength(2);
  });

  it('a pure REGISTERED player is addressed by user_id only (rguest null)', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await as(U_T);
    await call([B1], 'cancelled_player');
    const [row] = await capturedFor();
    expect(row.ruser).toBe(U_P1);
    expect(row.rguest).toBeNull();
  });
});

describe('P1 #2 — intent-aware bounds (bookings are not sessions)', () => {
  it('a legitimate 52-session x 2-player cancellation (104 rows) SUCCEEDS and fans out to 2 recipients', async () => {
    // 52 slots would be ideal but the bound counts ROWS; 104 cancelled bookings under T1/A1,
    // 52 per player, is the shape DeleteSlotDialog produces for a 2-player season.
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, player_id, status)
      SELECT gen_random_uuid(), '${S1}', p.pid, 'cancelled'
        FROM (VALUES ('${PR1}'::uuid), ('${PR2}'::uuid)) AS p(pid), generate_series(1, 52) g;`);
    const ids = (await db.query<{ id: string }>(`SELECT id FROM public.bookings WHERE status='cancelled'`)).rows.map((r) => r.id);
    expect(ids).toHaveLength(104);
    await as(U_T);
    const n = (await db.query<{ v: number }>(
      `SELECT public.enqueue_booking_notification(ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]::uuid[], 'cancelled_player') AS v`)).rows[0].v;
    expect(n, 'two recipients enqueued').toBe(2);
    const perRecipient = (await db.query<{ n: number }>(
      `SELECT array_length(ids,1) AS n FROM public._captured ORDER BY id`)).rows.map((r) => r.n);
    expect(perRecipient.sort()).toEqual([52, 52]);
  });

  it('rejects when ONE recipient exceeds the session cap (201 sessions)', async () => {
    await db.exec(`
      INSERT INTO public.bookings (id, slot_id, player_id, status)
      SELECT gen_random_uuid(), '${S1}', '${PR1}', 'cancelled' FROM generate_series(1, 201);`);
    const ids = (await db.query<{ id: string }>(`SELECT id FROM public.bookings WHERE status='cancelled'`)).rows.map((r) => r.id);
    await as(U_T);
    await expect(db.query(
      `SELECT public.enqueue_booking_notification(ARRAY[${ids.map((i) => `'${i}'::uuid`).join(',')}]::uuid[], 'cancelled_player')`))
      .rejects.toThrow(/too many sessions for one recipient/);
  });
});

describe('P1 #3 — academy-first tenant', () => {
  it('an ACADEMY MANAGER may cancel a MULTI-TRAINER cycle within one academy, with no falsely-named trainer', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });       // T1, A1
    await mkBooking(B2, S_A1B, { player: PR1, status: 'cancelled' });    // T1B, A1
    await as(U_M);   // academy manager of A1
    expect((await call([B1, B2], 'cancelled_player')).rows[0].v).toBe(1);
    const html = (await db.query<{ h: string }>(`SELECT html AS h FROM public._captured LIMIT 1`)).rows[0].h;
    // multi-trainer → generic copy, never one arbitrary trainer name
    expect(html).toContain('Je trainer');
    expect(html).not.toContain('Trainer T');
    expect(html).not.toContain('Trainer B');
  });

  it('an INDIVIDUAL TRAINER may NOT cancel a multi-trainer cycle (does not own every slot)', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });       // T1
    await mkBooking(B2, S_A1B, { player: PR1, status: 'cancelled' });    // T1B
    await as(U_T);   // trainer T1, not the academy manager
    await expect(call([B1, B2], 'cancelled_player')).rejects.toThrow(/does not own this slot/);
  });

  it('a SINGLE-trainer academy cancellation by that trainer still succeeds', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });
    await as(U_T);
    expect((await call([B1], 'cancelled_player')).rows[0].v).toBe(1);
  });

  it('rejects an INDEPENDENT set spanning multiple trainers (no coherent tenant)', async () => {
    await mkBooking(B1, S_ORPHAN, { player: PR1, status: 'cancelled' });   // T3, no academy
    await mkBooking(B2, S_INDEP2, { player: PR1, status: 'cancelled' });   // T1B, no academy
    await as(U_T1B);
    await expect(call([B1, B2], 'cancelled_player')).rejects.toThrow(/independent slots span multiple trainers/);
  });

  it('rejects an academy + INDEPENDENT (no-academy) mix', async () => {
    await mkBooking(B1, S1, { player: PR1, status: 'cancelled' });       // A1
    await mkBooking(B2, S_ORPHAN, { player: PR1, status: 'cancelled' }); // no academy
    await as(U_T);
    await expect(call([B1, B2], 'cancelled_player')).rejects.toThrow(/multiple academy scopes/);
  });
});
