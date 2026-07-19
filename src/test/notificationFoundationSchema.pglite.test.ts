// @vitest-environment node
// Notification Foundation v2 schema (migration 20260910100000). Pins the
// security contract from docs/NOTIFICATION_ARCHITECTURE.md: outbox/contacts are
// service-role-only, idempotency is PER RECIPIENT, consent is TENANT-SCOPED
// (cross-tenant opt-in denial — incl. the both-provenance case), no orphan
// contacts/outbox rows, tenant-visible rows must carry tenant context + summary,
// the taxonomy seed loads, and the delivery-events table is generalized. Runs
// the REAL migration file.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const EVENT = 'booking_confirmed_player';
const P1 = 'd0000000-0000-0000-0000-000000000001'; // a persons row
const A = 'a0000000-0000-0000-0000-00000000000a';  // academy A
const B = 'a0000000-0000-0000-0000-00000000000b';  // academy B
const T = 'c0000000-0000-0000-0000-0000000000cc';  // trainer T
const T2 = 'c0000000-0000-0000-0000-0000000000dd'; // trainer T2

const outboxInsert = (over: Record<string, string> = {}) => {
  const cols = { channel: "'email'", idempotency_key: "'k'", event_type: `'${EVENT}'`,
    recipient_person_id: `'${P1}'`, ...over };
  return db.query(`INSERT INTO public.notification_outbox (${Object.keys(cols).join(', ')}) VALUES (${Object.values(cols).join(', ')})`);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    -- FK targets the migration references (minimal stand-ins)
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.persons (id uuid PRIMARY KEY);
    CREATE TABLE public.invoices (id uuid PRIMARY KEY);
    CREATE TABLE public.academy_profiles (id uuid PRIMARY KEY);
    CREATE TABLE public.trainer_profiles (id uuid PRIMARY KEY);
    -- the migration ALTERs this existing table (reuse, not fork)
    CREATE TABLE public.email_delivery_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL,
      recipient_email text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await db.exec(readFileSync(
    join(process.cwd(), 'supabase', 'migrations', '20260910100000_notification_foundation_schema.sql'), 'utf8'));
  await db.exec(`
    INSERT INTO public.persons (id) VALUES ('${P1}');
    INSERT INTO public.academy_profiles (id) VALUES ('${A}'), ('${B}');
    INSERT INTO public.trainer_profiles (id) VALUES ('${T}'), ('${T2}');
  `);
});

describe('taxonomy seed', () => {
  it('loads the 20 event types with correct required_delivery/visibility flags', async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_event_types`);
    expect(rows[0].n).toBe(20);
    const req = (await db.query<{ key: string }>(`SELECT key FROM public.notification_event_types WHERE required_delivery`)).rows.map((r) => r.key);
    expect(req).toEqual(expect.arrayContaining(['password_reset', 'payment_receipt_player', 'invoice_payment_failed']));
    const mk = await db.query<{ v: string }>(`SELECT visibility_scope AS v FROM public.notification_event_types WHERE key='marketing_updates'`);
    expect(mk.rows[0].v).toBe('admin_only');
  });
});

describe('lockdown — outbox + contacts are service-role-only', () => {
  it('anon and authenticated have NO grant on the sensitive tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const tbl of ['public.notification_outbox', 'public.notification_contacts']) {
        const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, tbl]);
        expect(rows[0].ok).toBe(false);
      }
    }
  });
  it('authenticated CAN read/write its own preferences_v2', async () => {
    const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('authenticated', 'public.notification_preferences_v2', 'SELECT') AS ok`);
    expect(rows[0].ok).toBe(true);
  });
});

describe('per-recipient idempotency', () => {
  it('collides on the SAME (channel, idempotency_key) but not across recipients/channels', async () => {
    await outboxInsert({ idempotency_key: "'booking_paid:b1:confirmed:p1'" });
    await expect(outboxInsert({ idempotency_key: "'booking_paid:b1:confirmed:p1'" }))
      .rejects.toThrow(/uq_notification_outbox_idem|duplicate key/i);
    await outboxInsert({ idempotency_key: "'booking_paid:b1:confirmed:staff9'" });      // different recipient key
    await outboxInsert({ channel: "'whatsapp'", idempotency_key: "'booking_paid:b1:confirmed:p1'" }); // different channel
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(rows[0].n).toBe(3);
  });
});

describe('no-orphan + tenant-visibility CHECKs', () => {
  it('rejects an outbox row with NO recipient ref', async () => {
    await expect(db.query(
      `INSERT INTO public.notification_outbox (channel, idempotency_key, event_type) VALUES ('email','orphan','${EVENT}')`))
      .rejects.toThrow(/chk_notification_outbox_recipient/i);
  });
  it('rejects a tenant_visible row with no tenant context', async () => {
    await expect(outboxInsert({ idempotency_key: "'tv1'", visibility_scope: "'tenant_visible'", public_summary: `'{}'::jsonb` }))
      .rejects.toThrow(/chk_notification_outbox_tenant_visible/i);
  });
  it('rejects a tenant_visible row with no public_summary', async () => {
    await expect(outboxInsert({ idempotency_key: "'tv2'", visibility_scope: "'tenant_visible'", tenant_academy_profile_id: `'${A}'` }))
      .rejects.toThrow(/chk_notification_outbox_tenant_visible/i);
  });
  it('ALLOWS a tenant_visible row with tenant context + summary', async () => {
    await outboxInsert({ idempotency_key: "'tv3'", visibility_scope: "'tenant_visible'", tenant_academy_profile_id: `'${A}'`, public_summary: `'{"x":1}'::jsonb` });
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox WHERE idempotency_key='tv3'`);
    expect(rows[0].n).toBe(1);
  });
  it('rejects a contact with no person/user/guest ref', async () => {
    await expect(db.query(
      `INSERT INTO public.notification_contacts (channel, destination_normalized, destination_redacted) VALUES ('email','a@b.com','a***@b.com')`))
      .rejects.toThrow(/chk_notification_contacts_ref/i);
  });
});

describe('tenant-scoped consent (cross-tenant opt-in denial)', () => {
  const check = async (scope: string, cA: string | null, cT: string | null, ctxA: string | null, ctxT: string | null) =>
    (await db.query<{ ok: boolean }>(`SELECT public.is_notification_consent_in_scope($1,$2,$3,$4,$5) AS ok`, [scope, cA, cT, ctxA, ctxT])).rows[0].ok;

  it('global consent is usable in any tenant context', async () => {
    expect(await check('global', null, null, A, null)).toBe(true);
    expect(await check('global', null, null, null, T)).toBe(true);
  });
  it('single-provenance tenant consent matches only its own tenant', async () => {
    expect(await check('tenant', A, null, A, null)).toBe(true);
    expect(await check('tenant', A, null, B, null)).toBe(false); // cross-academy → denied
    expect(await check('tenant', A, null, null, null)).toBe(false);
  });
  it('BOTH-provenance consent requires BOTH to match (the P1 leak)', async () => {
    expect(await check('tenant', A, T, A, T)).toBe(true);
    expect(await check('tenant', A, T, B, T)).toBe(false);  // academy differs → denied (was the leak)
    expect(await check('tenant', A, T, A, T2)).toBe(false); // trainer differs → denied
  });
});

describe('consent_scope ⇔ provenance coherence CHECK', () => {
  const insertContact = (dest: string, scope: string, cA: string | null, cT: string | null) =>
    db.query(
      `INSERT INTO public.notification_contacts
         (person_id, channel, destination_normalized, destination_redacted, consent_scope, consent_academy_profile_id, consent_trainer_id)
       VALUES ($1,'whatsapp',$2,'redacted',$3,$4,$5)`,
      [P1, dest, scope, cA, cT]);
  it("rejects a 'tenant' consent with NO provenance", async () => {
    await expect(insertContact('+31600000001', 'tenant', null, null))
      .rejects.toThrow(/chk_notification_contacts_consent_scope/i);
  });
  it("rejects a 'global' consent that carries tenant provenance", async () => {
    await expect(insertContact('+31600000002', 'global', A, null))
      .rejects.toThrow(/chk_notification_contacts_consent_scope/i);
  });
  it('allows a coherent tenant consent and a coherent global consent', async () => {
    await insertContact('+31600000003', 'tenant', A, null);
    await insertContact('+31600000004', 'global', null, null);
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_contacts`);
    expect(rows[0].n).toBe(2);
  });
});

describe('delivery-events generalization', () => {
  it('recipient_email is now nullable and a WhatsApp phone row inserts cleanly', async () => {
    await db.query(
      `INSERT INTO public.email_delivery_events (event_type, channel, recipient_email, destination_redacted) VALUES ('sent','whatsapp',NULL,'+31•••1234')`);
    const { rows } = await db.query<{ ch: string; em: string | null }>(
      `SELECT channel AS ch, recipient_email AS em FROM public.email_delivery_events WHERE channel='whatsapp'`);
    expect(rows[0].ch).toBe('whatsapp');
    expect(rows[0].em).toBeNull();
  });
  it('an email row still defaults channel to email', async () => {
    await db.query(`INSERT INTO public.email_delivery_events (event_type, recipient_email) VALUES ('sent','x@y.com')`);
    const { rows } = await db.query<{ ch: string }>(`SELECT channel AS ch FROM public.email_delivery_events WHERE recipient_email='x@y.com'`);
    expect(rows[0].ch).toBe('email');
  });
});
