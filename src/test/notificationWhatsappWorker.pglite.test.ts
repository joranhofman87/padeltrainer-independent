// @vitest-environment node
// Notification Foundation v2 — PR 9: the WhatsApp worker's server-side halves (migration
// 20260919100000).
//
//   * whatsapp_consent_active      — the SEND-TIME re-check. Consent is verified at enqueue,
//     but a STOP can land in the gap before the worker drains the row. Every "unknown" answer
//     must mean NO, because the failure mode is messaging someone who asked us to stop.
//   * record_whatsapp_status_event — Twilio status callbacks, correlated to the outbox by SID
//     and idempotent across Twilio's retries.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const MIG = (n: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', n), 'utf8');

const A1 = '0a000000-0000-0000-0000-0000000000a1';
const U_P = '0e000000-0000-0000-0000-0000000000e1';
const P_P = '0d000000-0000-0000-0000-0000000000d1';  // current owner of the number
const P_O = '0d000000-0000-0000-0000-0000000000d2';  // previous owner (recycled-number case)
const PHONE = '+31612345678';

const consentActive = async (outboxId: string) =>
  (await db.query<{ v: boolean }>(
    `SELECT public.whatsapp_outbox_consent_active('${outboxId}') AS v`)).rows[0].v;

/** Insert a whatsapp outbox row bound to a contact, returning its id. */
const queueRow = async (
  person: string, phone: string, contactId: string | null, key: string, channel = 'whatsapp',
) =>
  (await db.query<{ id: string }>(`
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_person_id, destination_normalized, destination_redacted,
       contact_id, idempotency_key, status)
    VALUES ('session_reminder_player', '${channel}', '${person}', '${phone}', '+316****5678',
       ${contactId ? `'${contactId}'` : 'NULL'}, '${key}', 'pending')
    RETURNING id`)).rows[0].id;

const statusEvent = async (
  sid: string, status: string, errCode: string | null = null, errMsg: string | null = null,
) =>
  (await db.query<{ v: string }>(
    `SELECT public.record_whatsapp_status_event('${sid}', '${status}',
       ${errCode ? `'${errCode}'` : 'NULL'}, ${errMsg ? `'${errMsg}'` : 'NULL'}) AS v`)).rows[0].v;

// Tiebreak on resend_event_id, NOT id: several rows land in the same instant here (created_at
// DEFAULTs to now()), and a random-uuid tiebreaker makes the returned order non-deterministic
// — which is exactly how the lifecycle assertion below first flaked.
const events = () =>
  db.query<{
    channel: string; event_type: string; outbox_id: string | null; reason: string | null;
    recipient_email: string | null; invoice_id: string | null; destination_redacted: string | null;
    resend_email_id: string | null; resend_event_id: string | null;
  }>(`SELECT channel, event_type, outbox_id, reason, recipient_email, invoice_id,
             destination_redacted, resend_email_id, resend_event_id
      FROM public.email_delivery_events ORDER BY created_at, resend_event_id`);

/** Insert an opted-in whatsapp contact directly (bypassing the auth-bound opt-in RPC). */
const contact = async (person: string, phone: string, opts: { revoked?: boolean } = {}) =>
  (await db.query<{ id: string }>(`
    INSERT INTO public.notification_contacts
      (person_id, channel, destination_normalized, destination_redacted, consent_status,
       consent_scope, consent_academy_profile_id, consent_source, consent_at, revoked_at, is_primary)
    VALUES ('${person}', 'whatsapp', '${phone}', '***', '${opts.revoked ? 'opted_out' : 'opted_in'}',
       'tenant', '${A1}', 'settings', now(), ${opts.revoked ? 'now()' : 'NULL'}, true)
    RETURNING id`)).rows[0].id;

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
    -- email_delivery_events in its PRE-generalization shape (migration 20260615110000), so the
    -- foundation migration's ALTERs (channel/outbox_id/redacted + recipient_email DROP NOT NULL)
    -- are exercised here rather than assumed.
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), resend_event_id text, resend_email_id text,
      event_type text NOT NULL CHECK (event_type IN
        ('sent','delivered','bounced','complained','delivery_delayed','failed','send_failed')),
      bounce_type text CHECK (bounce_type IN ('hard','soft')), reason text,
      recipient_email text NOT NULL, invoice_id uuid,
      academy_profile_id uuid, trainer_id uuid,
      occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
    -- the UNIQUE partial index the status-event idempotency relies on
    CREATE UNIQUE INDEX idx_ede_resend_event_id ON public.email_delivery_events (resend_event_id)
      WHERE resend_event_id IS NOT NULL;
  `);
  await db.exec(MIG('20260910100000_notification_foundation_schema.sql'));
  await db.exec(MIG('20260911100000_notification_resolver.sql'));
  await db.exec(MIG('20260912100000_notification_email_worker.sql'));
  await db.exec(MIG('20260915100000_notification_paid_booking_player.sql'));
  await db.exec(MIG('20260915110000_notification_scrub_attachments_on_terminal.sql'));
  await db.exec(MIG('20260918100000_notification_whatsapp_consent.sql'));
  await db.exec(MIG('20260919100000_notification_whatsapp_worker.sql'));
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${U_P}');
    INSERT INTO public.persons (id, user_id, email) VALUES ('${P_P}','${U_P}','p@x.com'), ('${P_O}',NULL,'o@x.com');
    INSERT INTO public.academy_profiles (id) VALUES ('${A1}');
  `);
});

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.email_delivery_events;
    DELETE FROM public.notification_outbox;
    DELETE FROM public.notification_contacts;`);
});

describe('whatsapp_outbox_consent_active — the send-time re-check', () => {
  it('is TRUE while the row\'s own contact is opted in', async () => {
    const c = await contact(P_P, PHONE);
    expect(await consentActive(await queueRow(P_P, PHONE, c, 'k1'))).toBe(true);
  });

  it('is FALSE once that contact opts out — the gap this function exists to close', async () => {
    const c = await contact(P_P, PHONE);
    const row = await queueRow(P_P, PHONE, c, 'k1');
    expect(await consentActive(row)).toBe(true);
    await db.exec(`SELECT public.record_whatsapp_optout('${PHONE}');`);
    expect(await consentActive(row)).toBe(false);
  });

  it('does NOT let a queued row ride ANOTHER PERSON\'S consent on the same number', async () => {
    // THE reason this is contact-bound rather than number-bound. A number-keyed check answers
    // "is anyone consented on N?", which is not the question:
    //   A opts in with N -> row queued against A's contact
    //   A moves to a new number -> record_whatsapp_optin RETIRES A's contact for N
    //   B (spouse / N's next holder) has their own opted-in contact on N
    // A number-keyed check would return TRUE from B's consent and deliver A's private
    // notification to B's phone.
    const ca = await contact(P_P, PHONE);
    const row = await queueRow(P_P, PHONE, ca, 'k1');
    expect(await consentActive(row)).toBe(true);

    // A changes number: the opt-in RPC retires CA (service_role context, auth.uid() IS NULL)
    await db.exec(`SELECT public.record_whatsapp_optin('${P_P}', '+31600000001', '${A1}', NULL, 'settings');`);
    // B registers the freed number
    await contact(P_O, PHONE);

    expect(await consentActive(row)).toBe(false);
  });

  it('is FALSE when the contact\'s number no longer matches the row\'s destination', async () => {
    const c = await contact(P_P, PHONE);
    const row = await queueRow(P_P, PHONE, c, 'k1');
    await db.exec(
      `UPDATE public.notification_contacts SET destination_normalized = '+31600000009' WHERE id = '${c}';`);
    expect(await consentActive(row)).toBe(false);
  });

  it('FAILS CLOSED on a NULL contact_id, a non-whatsapp row, and an unknown row', async () => {
    // a row we cannot tie to a consent record is a row we cannot justify sending
    expect(await consentActive(await queueRow(P_P, PHONE, null, 'k1'))).toBe(false);
    const c = await contact(P_P, PHONE);
    expect(await consentActive(await queueRow(P_P, PHONE, c, 'k2', 'email'))).toBe(false);
    expect(await consentActive('00000000-0000-0000-0000-0000000000ff')).toBe(false);
  });

  it('is FALSE for a contact that was never opted in', async () => {
    const c = await contact(P_P, PHONE, { revoked: true });
    expect(await consentActive(await queueRow(P_P, PHONE, c, 'k1'))).toBe(false);
  });

  it('is service_role only — never a client-callable consent oracle', async () => {
    const r = await db.query<{ role: string; can: boolean }>(`
      SELECT role, has_function_privilege(role, 'public.whatsapp_outbox_consent_active(uuid)', 'EXECUTE') AS can
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS role`);
    expect(r.rows.find((x) => x.role === 'anon')!.can).toBe(false);
    expect(r.rows.find((x) => x.role === 'authenticated')!.can).toBe(false);
    expect(r.rows.find((x) => x.role === 'service_role')!.can).toBe(true);
  });
});

describe('record_notification_send_result — provider derives from the channel', () => {
  // The default was 'resend', which was right while email was the only worker and silently
  // wrong the moment a second channel existed. Deriving it means the NEXT channel worker
  // cannot mislabel its sends by forgetting an argument.
  const finalize = async (channel: string, key: string, provider?: string) => {
    const id = await queueRow(P_P, channel === 'email' ? 'p@x.com' : PHONE, null, key, channel);
    await db.query(`SELECT public.claim_notification_outbox_batch('${channel}', 'w1', 10)`);
    await db.query(`SELECT public.record_notification_send_result('${id}', 'w1', 'sent', 'MID1',
      NULL, ${provider ? `'${provider}'` : 'NULL'})`);
    return (await db.query<{ provider: string | null }>(
      `SELECT provider FROM public.notification_outbox WHERE id = '${id}'`)).rows[0].provider;
  };

  it('labels a whatsapp send twilio and an email send resend, with no argument passed', async () => {
    expect(await finalize('whatsapp', 'k1')).toBe('twilio');
    expect(await finalize('email', 'k2')).toBe('resend');
  });

  it('still honours an explicit provider', async () => {
    expect(await finalize('whatsapp', 'k3', 'twilio-sandbox')).toBe('twilio-sandbox');
  });
});

describe('defer_notification_outbox_row — a config gap must not burn the retry budget', () => {
  const claimOne = (channel = 'whatsapp', worker = 'w1') =>
    db.query(`SELECT public.claim_notification_outbox_batch('${channel}', '${worker}', 10)`);

  const rowState = async (id: string) =>
    (await db.query<{ status: string; attempts: number; locked_by: string | null; next_attempt_at: string | null }>(
      `SELECT status, attempts, locked_by, next_attempt_at FROM public.notification_outbox WHERE id = '${id}'`
    )).rows[0];

  it('returns the row to pending, GIVES THE ATTEMPT BACK and backs off', async () => {
    const id = await queueRow(P_P, PHONE, null, 'k1');
    await claimOne();
    expect((await rowState(id)).attempts).toBe(1);          // the claim counted an attempt

    const r = await db.query<{ v: string }>(
      `SELECT public.defer_notification_outbox_row('${id}', 'w1', 'missing_content_sid', 5) AS v`);
    expect(r.rows[0].v).toBe('deferred');

    const after = await rowState(id);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);                          // …and the defer gave it back
    expect(after.locked_by).toBeNull();
    expect(after.next_attempt_at).not.toBeNull();
  });

  it('survives a config gap far longer than the retry budget — the actual bug', async () => {
    // record_notification_send_result fails a row at attempts >= max_attempts REGARDLESS of
    // p_terminal, so "retryable" alone only survives ~62 minutes. A Meta template review or a
    // credential fix does not fit in that. Ten deferral cycles must leave the row deliverable.
    const id = await queueRow(P_P, PHONE, null, 'k1');
    for (let i = 0; i < 10; i++) {
      await db.exec(`UPDATE public.notification_outbox SET next_attempt_at = NULL WHERE id = '${id}';`);
      await claimOne();
      await db.query(`SELECT public.defer_notification_outbox_row('${id}', 'w1', 'missing_content_sid', 5)`);
    }
    const after = await rowState(id);
    expect(after.status).toBe('pending');     // NOT 'failed'
    expect(after.attempts).toBe(0);
  });

  it('contrast: a plain retryable FAILURE does exhaust the budget and go terminal', async () => {
    // this is what deferring exists to avoid, pinned so the difference cannot quietly collapse
    const id = await queueRow(P_P, PHONE, null, 'k1');
    for (let i = 0; i < 5; i++) {
      await db.exec(`UPDATE public.notification_outbox SET next_attempt_at = NULL WHERE id = '${id}';`);
      await claimOne();
      await db.query(
        `SELECT public.record_notification_send_result('${id}', 'w1', 'failed', NULL, 'boom', NULL, 60, false)`);
    }
    expect((await rowState(id)).status).toBe('failed');
  });

  it('refuses to rewind a row a NEWER run has claimed (ownership guard)', async () => {
    const id = await queueRow(P_P, PHONE, null, 'k1');
    await claimOne('whatsapp', 'w1');
    const r = await db.query<{ v: string }>(
      `SELECT public.defer_notification_outbox_row('${id}', 'someone-else', 'x', 5) AS v`);
    expect(r.rows[0].v).toBe('stale');
    expect((await rowState(id)).status).toBe('processing');   // untouched
  });

  it('is service_role only', async () => {
    const r = await db.query<{ role: string; can: boolean }>(`
      SELECT role, has_function_privilege(role,
        'public.defer_notification_outbox_row(uuid,text,text,int)', 'EXECUTE') AS can
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS role`);
    expect(r.rows.find((x) => x.role === 'anon')!.can).toBe(false);
    expect(r.rows.find((x) => x.role === 'authenticated')!.can).toBe(false);
    expect(r.rows.find((x) => x.role === 'service_role')!.can).toBe(true);
  });
});

describe('record_whatsapp_status_event', () => {
  const SID = 'SM0123456789abcdef0123456789abcdef';

  const outboxRow = (sid: string) => db.exec(`
    INSERT INTO public.notification_outbox
      (event_type, channel, recipient_person_id, destination_normalized, destination_redacted,
       idempotency_key, status, provider, provider_message_id, sent_at)
    VALUES ('session_reminder_player', 'whatsapp', '${P_P}', '${PHONE}', '+316****5678',
       'session_reminder_player:s1:${P_P}', 'sent', 'twilio', '${sid}', now());`);

  it('correlates to the outbox row and logs on the whatsapp channel', async () => {
    await outboxRow(SID);
    expect(await statusEvent(SID, 'delivered')).toBe('recorded');

    const rows = (await events()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('whatsapp');
    expect(rows[0].event_type).toBe('delivered');
    expect(rows[0].outbox_id).not.toBeNull();
    expect(rows[0].resend_email_id).toBe(SID);
    expect(rows[0].destination_redacted).toBe('+316****5678');
  });

  it('never puts a phone number in recipient_email, and leaves invoice_id NULL', async () => {
    await outboxRow(SID);
    await statusEvent(SID, 'delivered');
    const row = (await events()).rows[0];
    expect(row.recipient_email).toBeNull();
    // invoice_id stays NULL on purpose: get_invoice_delivery_status() correlates by it, so
    // populating it would render a WhatsApp failure as an invoice EMAIL delivery issue
    expect(row.invoice_id).toBeNull();
  });

  it('maps Twilio statuses onto the existing taxonomy, keeping the raw status in reason', async () => {
    const cases: Array<[string, string]> = [
      ['queued', 'sent'], ['sending', 'sent'], ['sent', 'sent'], ['accepted', 'sent'],
      ['delivered', 'delivered'], ['read', 'delivered'],
      ['failed', 'failed'], ['undelivered', 'bounced'],
    ];
    for (const [twilio, expected] of cases) {
      await db.exec(`DELETE FROM public.email_delivery_events;`);
      expect(await statusEvent(`SM_${twilio}`, twilio)).toBe('unmatched');
      const row = (await events()).rows[0];
      expect(row.event_type).toBe(expected);
      expect(row.reason).toContain(twilio);   // 'read' is not lost behind 'delivered'
    }
  });

  it('preserves the Twilio error code + message in reason on a failure', async () => {
    await outboxRow(SID);
    await statusEvent(SID, 'undelivered', '63016', 'Failed to send freeform message');
    const row = (await events()).rows[0];
    expect(row.event_type).toBe('bounced');
    expect(row.reason).toContain('63016');
    expect(row.reason).toContain('Failed to send freeform message');
  });

  it('is IDEMPOTENT across Twilio callback retries for the same (sid, status)', async () => {
    await outboxRow(SID);
    expect(await statusEvent(SID, 'delivered')).toBe('recorded');
    expect(await statusEvent(SID, 'delivered')).toBe('duplicate');
    expect((await events()).rows).toHaveLength(1);
  });

  it('still records each DISTINCT status in the lifecycle', async () => {
    await outboxRow(SID);
    await statusEvent(SID, 'sent');
    await statusEvent(SID, 'delivered');
    await statusEvent(SID, 'read');
    // asserted as a SET: three rows written in the same instant have no reliable order, and
    // the claim under test is "each distinct status is recorded", not "they come back sorted"
    const rows = (await events()).rows;
    expect(rows.map((r) => r.event_type).sort()).toEqual(['delivered', 'delivered', 'sent']);
    expect(rows.map((r) => r.resend_event_id).sort()).toEqual(
      [`twilio:${SID}:delivered`, `twilio:${SID}:read`, `twilio:${SID}:sent`].sort(),
    );
  });

  it('records an UNMATCHED sid rather than dropping it (forensics survive)', async () => {
    expect(await statusEvent('SM_unknown_sid', 'delivered')).toBe('unmatched');
    const rows = (await events()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].outbox_id).toBeNull();
  });

  it('does not correlate to a NON-whatsapp outbox row with the same provider id', async () => {
    await db.exec(`
      INSERT INTO public.notification_outbox
        (event_type, channel, recipient_person_id, destination_normalized, idempotency_key,
         status, provider, provider_message_id)
      VALUES ('session_reminder_player', 'email', '${P_P}', 'p@x.com',
         'session_reminder_player:s2:${P_P}', 'sent', 'resend', '${SID}');`);
    expect(await statusEvent(SID, 'delivered')).toBe('unmatched');
  });

  it('IGNORES an unknown status and a blank sid instead of coercing them', async () => {
    await outboxRow(SID);
    expect(await statusEvent(SID, 'partially_delivered')).toBe('ignored');
    expect(await statusEvent('', 'delivered')).toBe('ignored');
    expect((await events()).rows).toHaveLength(0);
  });

  it('is service_role only', async () => {
    const r = await db.query<{ role: string; can: boolean }>(`
      SELECT role, has_function_privilege(role,
        'public.record_whatsapp_status_event(text,text,text,text)', 'EXECUTE') AS can
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS role`);
    expect(r.rows.find((x) => x.role === 'anon')!.can).toBe(false);
    expect(r.rows.find((x) => x.role === 'authenticated')!.can).toBe(false);
    expect(r.rows.find((x) => x.role === 'service_role')!.can).toBe(true);
  });
});
