// @vitest-environment node
// Notification Foundation v2 — PR 6a: the paid-booking PLAYER confirmation → outbox
// (migration 20260915100000). Pins the SQL layer the edge composer wires together:
//   * ensure_guest_email_contact upserts a TENANT-SCOPED, redacted, idempotent email
//     contact for a guest, so a guest paid-booking confirmation is deliverable via the
//     outbox (a guest has no persons.email account fallback — that would cross-tenant-leak),
//   * the same guest/person in ANOTHER academy is a DIFFERENT guest_player → a SEPARATE
//     contact; the resolver never reuses the first academy's contact,
//   * enqueue_notification('booking_confirmed_player') delivers a guest via that contact and
//     a registered player via the persons.email account fallback,
//   * a guest with NO collected email → a VISIBLE required-but-skipped row (no_email_contact),
//   * duplicate paid-claim runs never duplicate the contact OR the outbox row,
//   * raw destinations never appear in the tenant-safe redacted column.
// Runs the REAL schema + resolver + PR-6a migrations.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1'; // academy 1
const A2 = '0a000000-0000-0000-0000-0000000000a2'; // academy 2
const T1 = '0c000000-0000-0000-0000-0000000000c1'; // trainer of academy 1
const T2 = '0c000000-0000-0000-0000-0000000000c2'; // trainer of academy 2
const U_R = '0e000000-0000-0000-0000-0000000000e1'; // registered player's login
const P_R = '0d000000-0000-0000-0000-0000000000d1'; // registered player's person (has email)
const G1 = '0b000000-0000-0000-0000-0000000000b1'; // guest in academy 1
const PG1 = '0d000000-0000-0000-0000-0000000000d2'; // G1's person
const G2 = '0b000000-0000-0000-0000-0000000000b2'; // SAME person, guest in academy 2
const G3 = '0b000000-0000-0000-0000-0000000000b3'; // guest in academy 1 with NO email

const GUEST_EMAIL = 'shared@example.com'; // deliberately shared by G1 and G2 (cross-academy)
const REG_EMAIL = 'player@example.com';

const ensureGuestContact = (guest: string, email: string, academy: string | null, trainer: string | null) =>
  db.query<{ ensure_guest_email_contact: string | null }>(
    `SELECT public.ensure_guest_email_contact('${guest}', ${email === 'NULL' ? 'NULL' : `'${email}'`},
       ${academy ? `'${academy}'` : 'NULL'}, ${trainer ? `'${trainer}'` : 'NULL'}) AS ensure_guest_email_contact`);

type OutRow = {
  outbox_id: string; channel: string; status: string; skip_reason: string | null;
  recipient_user_id: string | null; recipient_person_id: string | null; recipient_guest_player_id: string | null;
  tenant_academy_profile_id: string | null; tenant_trainer_id: string | null; visibility_scope: string;
  destination_normalized: string | null; destination_redacted: string | null; payload: { subject?: string; html?: string };
};

// enqueue_notification INSERTs then RETURNS — re-reading notification_outbox in the SAME
// statement hits the pre-insert snapshot, so take what the resolver returns directly, then
// fetch the few columns it omits (recipient_user_id / recipient_guest_player_id / tenant_*)
// in a SEPARATE statement (which sees the committed row).
async function runEnqueue(callSql: string): Promise<{ rows: OutRow[] }> {
  const e = await db.query<{
    outbox_id: string; channel: string; status: string; skip_reason: string | null;
    visibility_scope: string; destination_normalized: string | null; destination_redacted: string | null;
    recipient_person_id: string | null;
  }>(callSql);
  if (e.rows.length === 0) return { rows: [] };
  const merged: OutRow[] = [];
  for (const r of e.rows) {
    const o = (await db.query<{
      recipient_user_id: string | null; recipient_guest_player_id: string | null;
      tenant_academy_profile_id: string | null; tenant_trainer_id: string | null; payload: { subject?: string; html?: string };
    }>(`SELECT recipient_user_id, recipient_guest_player_id, tenant_academy_profile_id, tenant_trainer_id, payload
        FROM public.notification_outbox WHERE id = '${r.outbox_id}'`)).rows[0];
    merged.push({ ...r, ...o });
  }
  return { rows: merged };
}

const ENQ_COLS = `outbox_id, channel, status, skip_reason, visibility_scope, destination_normalized, destination_redacted, recipient_person_id`;

const enqueuePlayer = (opts: {
  guest: string; academy: string | null; trainer: string | null; payment: string;
}) =>
  runEnqueue(`
    SELECT ${ENQ_COLS} FROM public.enqueue_notification(
      'booking_confirmed_player', NULL, NULL,
      '${opts.guest}'::uuid,
      ${opts.academy ? `'${opts.academy}'::uuid` : 'NULL'},
      ${opts.trainer ? `'${opts.trainer}'::uuid` : 'NULL'},
      NULL, NULL, NULL, '${opts.payment}', NULL,
      '{"subject":"Bevestiging van je boeking","html":"<p>ok</p>"}'::jsonb)`);

const enqueueRegistered = (user: string, academy: string, trainer: string, payment: string) =>
  runEnqueue(`
    SELECT ${ENQ_COLS} FROM public.enqueue_notification(
      'booking_confirmed_player', NULL, '${user}'::uuid, NULL,
      '${academy}'::uuid, '${trainer}'::uuid, NULL, NULL, NULL, '${payment}', NULL,
      '{"subject":"Bevestiging van je boeking","html":"<p>ok</p>"}'::jsonb)`);

const contactsFor = (email: string) =>
  db.query<{
    id: string; guest_player_id: string | null; person_id: string | null; channel: string;
    destination_normalized: string; destination_redacted: string; consent_status: string; consent_scope: string;
    consent_academy_profile_id: string | null; consent_trainer_id: string | null; consent_source: string | null;
  }>(`SELECT id, guest_player_id, person_id, channel, destination_normalized, destination_redacted,
             consent_status, consent_scope, consent_academy_profile_id, consent_trainer_id, consent_source
      FROM public.notification_contacts WHERE destination_normalized = '${email}' ORDER BY consent_academy_profile_id`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY, user_id uuid, email text);
    CREATE TABLE public.person_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), person_id uuid, guest_player_id uuid);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY, user_id uuid);
    CREATE TABLE public.email_address_state (email text PRIMARY KEY, state text NOT NULL);
    CREATE OR REPLACE FUNCTION public.is_email_suppressed(p_email text) RETURNS boolean LANGUAGE sql STABLE AS $fn$
      SELECT EXISTS (SELECT 1 FROM public.email_address_state WHERE email = lower(btrim(p_email)) AND state IN ('hard_bounced','complained')); $fn$;
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL, bounce_type text, reason text, recipient_email text NOT NULL,
      invoice_id uuid, academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(MIG('20260915100000_notification_paid_booking_player.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_R}');
    INSERT INTO public.persons (id, user_id, email) VALUES
      ('${P_R}','${U_R}','${REG_EMAIL}'), ('${PG1}',NULL,NULL);
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}'), ('${A2}');
    INSERT INTO public.trainer_profiles (id, user_id) VALUES ('${T1}',NULL), ('${T2}',NULL);
    -- G1 and G2 are the SAME person (PG1), a guest in TWO academies.
    INSERT INTO public.person_links (person_id, guest_player_id) VALUES ('${PG1}','${G1}'), ('${PG1}','${G2}');
  `);
});

beforeEach(async () => {
  await db.exec(`DELETE FROM public.notification_outbox; DELETE FROM public.notification_contacts; DELETE FROM public.email_address_state;`);
});

describe('ensure_guest_email_contact — tenant-scoped, redacted, idempotent', () => {
  it('PIN 1+6: a guest email → an academy-scoped, redacted contact (no marketing opt-in, no person_id)', async () => {
    const id = (await ensureGuestContact(G1, GUEST_EMAIL, A1, T1)).rows[0].ensure_guest_email_contact;
    expect(id).toBeTruthy();
    const [c] = (await contactsFor(GUEST_EMAIL)).rows;
    expect(c.guest_player_id).toBe(G1);
    expect(c.person_id).toBeNull();                       // guest-keyed, not person-keyed
    expect(c.channel).toBe('email');
    expect(c.destination_normalized).toBe(GUEST_EMAIL);
    expect(c.destination_redacted).toBe('s***@example.com'); // PIN 6: raw address never bare
    expect(c.consent_status).toBe('unknown');             // transactional, NOT a marketing opt-in
    expect(c.consent_scope).toBe('tenant');
    expect(c.consent_academy_profile_id).toBe(A1);        // academy-when-present …
    expect(c.consent_trainer_id).toBeNull();              // … trainer dimension left open (multi-trainer safe)
    expect(c.consent_source).toBe('paid_booking');
  });

  it('an INDEPENDENT trainer (no academy) → a trainer-scoped contact', async () => {
    await ensureGuestContact(G1, GUEST_EMAIL, null, T1);
    const [c] = (await contactsFor(GUEST_EMAIL)).rows;
    expect(c.consent_academy_profile_id).toBeNull();
    expect(c.consent_trainer_id).toBe(T1);
  });

  it('normalizes case/whitespace and rejects an empty / malformed email (→ NULL, no contact)', async () => {
    const upper = (await ensureGuestContact(G1, '  SHARED@Example.com ', A1, T1)).rows[0].ensure_guest_email_contact;
    expect(upper).toBeTruthy();
    expect((await contactsFor(GUEST_EMAIL)).rows[0].destination_normalized).toBe(GUEST_EMAIL);
    expect((await ensureGuestContact(G3, 'NULL', A1, T1)).rows[0].ensure_guest_email_contact).toBeNull();
    expect((await ensureGuestContact(G3, 'not-an-email', A1, T1)).rows[0].ensure_guest_email_contact).toBeNull();
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_contacts WHERE guest_player_id = '${G3}'`)).rows[0].n).toBe(0);
  });

  it('PIN 2: repeated upsert for the same guest is idempotent (one contact, refreshed)', async () => {
    const a = (await ensureGuestContact(G1, GUEST_EMAIL, A1, T1)).rows[0].ensure_guest_email_contact;
    const b = (await ensureGuestContact(G1, GUEST_EMAIL, A1, T1)).rows[0].ensure_guest_email_contact;
    expect(a).toBe(b);
    expect((await contactsFor(GUEST_EMAIL)).rows).toHaveLength(1);
  });

  it('PIN 3: the SAME shared email in another academy is a SEPARATE, separately-scoped contact', async () => {
    await ensureGuestContact(G1, GUEST_EMAIL, A1, T1);
    await ensureGuestContact(G2, GUEST_EMAIL, A2, T2);
    const rows = (await contactsFor(GUEST_EMAIL)).rows;          // the OLD email-only unique index would have collapsed these
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.consent_academy_profile_id).sort()).toEqual([A1, A2].sort());
    expect(rows.map((r) => r.guest_player_id).sort()).toEqual([G1, G2].sort());
  });

  it('SCOPE STABILITY (why academy, not academy+trainer): a guest booking a 2nd trainer in the SAME academy keeps ONE academy-scoped contact — both trainers stay deliverable', async () => {
    await ensureGuestContact(G1, GUEST_EMAIL, A1, T1);           // books trainer T1 in academy A1
    await ensureGuestContact(G1, GUEST_EMAIL, A1, T2);           // later books a DIFFERENT trainer in the SAME academy
    const rows = (await contactsFor(GUEST_EMAIL)).rows;
    expect(rows).toHaveLength(1);                                // one contact, not duplicated
    expect(rows[0].consent_academy_profile_id).toBe(A1);
    expect(rows[0].consent_trainer_id).toBeNull();              // academy-scoped → never flips to a single trainer
    // both trainers' required confirmations resolve in-scope (a trainer-scoped contact would have
    // stranded whichever trainer it wasn't currently pinned to).
    expect((await enqueuePlayer({ guest: G1, academy: A1, trainer: T1, payment: 'p_st1' })).rows[0].status).toBe('pending');
    expect((await enqueuePlayer({ guest: G1, academy: A1, trainer: T2, payment: 'p_st2' })).rows[0].status).toBe('pending');
  });
});

describe('enqueue_notification(booking_confirmed_player) — delivery routing', () => {
  it('PIN 1: guest WITH a contact → a pending, private email row addressed to the contact', async () => {
    await ensureGuestContact(G1, GUEST_EMAIL, A1, T1);
    const rows = (await enqueuePlayer({ guest: G1, academy: A1, trainer: T1, payment: 'pay_g1' })).rows;
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.channel).toBe('email');
    expect(r.status).toBe('pending');
    expect(r.recipient_guest_player_id).toBe(G1);
    expect(r.recipient_person_id).toBe(PG1);               // normalized via person_links
    expect(r.recipient_user_id).toBeNull();
    expect(r.tenant_academy_profile_id).toBe(A1);
    expect(r.visibility_scope).toBe('private_user_only');  // the payer's own confirmation, NOT tenant-visible
    expect(r.destination_normalized).toBe(GUEST_EMAIL);
    expect(r.destination_redacted).toBe('s***@example.com'); // PIN 6
    expect(r.payload.subject).toContain('Bevestiging');
  });

  it('PIN 5: registered player → delivered via the persons.email ACCOUNT fallback (no contact row)', async () => {
    const rows = (await enqueueRegistered(U_R, A1, T1, 'pay_reg')).rows;
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.status).toBe('pending');
    expect(r.recipient_user_id).toBe(U_R);
    expect(r.recipient_person_id).toBe(P_R);
    expect(r.recipient_guest_player_id).toBeNull();
    expect(r.destination_normalized).toBe(REG_EMAIL);
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_contacts`)).rows[0].n).toBe(0);
  });

  it('PIN 4: guest with NO email/contact → a VISIBLE required-but-skipped row (no_email_contact)', async () => {
    const rows = (await enqueuePlayer({ guest: G3, academy: A1, trainer: T1, payment: 'pay_g3' })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].skip_reason).toBe('no_email_contact');
    expect(rows[0].destination_normalized).toBeNull();
    expect(rows[0].recipient_guest_player_id).toBe(G3);
  });

  it('PIN 3 (delivery): G2 resolves to its OWN academy-2 contact and NEVER reuses G1s academy-1 one', async () => {
    await ensureGuestContact(G1, GUEST_EMAIL, A1, T1); // academy-1 contact only
    // With ONLY the academy-1 contact, an academy-2 payment for the same person is undeliverable
    // (the resolver must not borrow the out-of-scope academy-1 contact).
    const beforeC2 = (await enqueuePlayer({ guest: G2, academy: A2, trainer: T2, payment: 'pay_g2a' })).rows[0];
    expect(beforeC2.status).toBe('skipped');
    expect(beforeC2.skip_reason).toBe('no_email_contact');
    // Give academy 2 its own contact → now it delivers, via C2 (not C1).
    await ensureGuestContact(G2, GUEST_EMAIL, A2, T2);
    const afterC2 = (await enqueuePlayer({ guest: G2, academy: A2, trainer: T2, payment: 'pay_g2b' })).rows[0];
    expect(afterC2.status).toBe('pending');
    expect(afterC2.tenant_academy_profile_id).toBe(A2);
    expect(afterC2.destination_normalized).toBe(GUEST_EMAIL);
  });

  it('PIN 2 (outbox): the SAME payment re-enqueued is a no-op (idempotency key already exists)', async () => {
    await ensureGuestContact(G1, GUEST_EMAIL, A1, T1);
    const first = (await enqueuePlayer({ guest: G1, academy: A1, trainer: T1, payment: 'pay_dupe' })).rows;
    expect(first).toHaveLength(1);
    const second = (await enqueuePlayer({ guest: G1, academy: A1, trainer: T1, payment: 'pay_dupe' })).rows;
    expect(second).toHaveLength(0); // resolver returns only NEWLY created rows
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`)).rows[0].n).toBe(1);
  });
});

describe('lockdown — ensure_guest_email_contact is service-role-only', () => {
  // A SECURITY DEFINER writer of PII contacts must NOT be reachable by anon/authenticated
  // (else it is a client-callable way to seed arbitrary tenant-scoped contacts).
  const canExec = async (role: string) =>
    (await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege($1, 'public.ensure_guest_email_contact(uuid,text,uuid,uuid)', 'EXECUTE') AS ok`, [role])).rows[0].ok;

  it('anon + authenticated CANNOT execute; service_role CAN', async () => {
    expect(await canExec('anon')).toBe(false);
    expect(await canExec('authenticated')).toBe(false);
    expect(await canExec('service_role')).toBe(true);
  });
});
