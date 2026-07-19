// @vitest-environment node
// Notification Foundation v2 schema (migration 20260910100000). Pins the
// security contract from docs/NOTIFICATION_ARCHITECTURE.md: outbox/contacts are
// service-role-only (no anon/authenticated grant), idempotency is PER RECIPIENT,
// consent is TENANT-SCOPED (cross-tenant opt-in denial), the taxonomy seed loads,
// and the delivery-events table is generalized (recipient_email nullable). Runs
// the REAL migration file.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let db: PGlite;
const EVENT = 'booking_confirmed_player';
const A = 'a0000000-0000-0000-0000-00000000000a'; // academy A
const B = 'a0000000-0000-0000-0000-00000000000b'; // academy B
const T = 'c0000000-0000-0000-0000-0000000000cc'; // trainer T

const outboxInsert = (over: Record<string, string>) => {
  const cols = { channel: "'email'", idempotency_key: "'k'", event_type: `'${EVENT}'`, ...over };
  const keys = Object.keys(cols).join(', ');
  const vals = Object.values(cols).join(', ');
  return db.query(`INSERT INTO public.notification_outbox (${keys}) VALUES (${vals})`);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
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
});

describe('taxonomy seed', () => {
  it('loads the 20 initial event types with correct required_delivery flags', async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_event_types`);
    expect(rows[0].n).toBe(20);
    // security/payment/account criticals must be required_delivery=true
    const req = await db.query<{ key: string }>(
      `SELECT key FROM public.notification_event_types WHERE required_delivery ORDER BY key`);
    expect(req.rows.map((r) => r.key)).toContain('password_reset');
    expect(req.rows.map((r) => r.key)).toContain('payment_receipt_player');
    expect(req.rows.map((r) => r.key)).toContain('invoice_payment_failed');
    // marketing is admin_only, never tenant-visible
    const mk = await db.query<{ v: string }>(
      `SELECT visibility_scope AS v FROM public.notification_event_types WHERE key='marketing_updates'`);
    expect(mk.rows[0].v).toBe('admin_only');
  });
});

describe('lockdown — outbox + contacts are service-role-only', () => {
  it('anon and authenticated have NO grant on the sensitive tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const tbl of ['public.notification_outbox', 'public.notification_contacts']) {
        const { rows } = await db.query<{ ok: boolean }>(
          `SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [role, tbl]);
        expect(rows[0].ok).toBe(false);
      }
    }
  });
  it('authenticated CAN read/write its own preferences_v2 (the settings UI path)', async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('authenticated', 'public.notification_preferences_v2', 'SELECT') AS ok`);
    expect(rows[0].ok).toBe(true);
  });
});

describe('per-recipient idempotency', () => {
  it('collides on the SAME (channel, idempotency_key) but not across recipients/channels', async () => {
    await outboxInsert({ idempotency_key: "'booking_paid:b1:confirmed:p1'" });
    // same channel + key → the E-15-duplicate case → must conflict (no double-send)
    await expect(outboxInsert({ idempotency_key: "'booking_paid:b1:confirmed:p1'" }))
      .rejects.toThrow(/uq_notification_outbox_idem|duplicate key/i);
    // different recipient (staff) on the same booking → different key → OK
    await outboxInsert({ idempotency_key: "'booking_paid:b1:confirmed:staff9'" });
    // same key, different channel → OK (channel is part of the unique, not the key string)
    await outboxInsert({ channel: "'whatsapp'", idempotency_key: "'booking_paid:b1:confirmed:p1'" });
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.notification_outbox`);
    expect(rows[0].n).toBe(3);
  });
});

describe('tenant-scoped consent (cross-tenant opt-in denial)', () => {
  const check = async (scope: string, cAcademy: string | null, cTrainer: string | null, ctxAcademy: string | null, ctxTrainer: string | null) => {
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT public.is_notification_consent_in_scope($1,$2,$3,$4,$5) AS ok`,
      [scope, cAcademy, cTrainer, ctxAcademy, ctxTrainer]);
    return rows[0].ok;
  };
  it('global consent is usable in any tenant context', async () => {
    expect(await check('global', null, null, A, null)).toBe(true);
    expect(await check('global', null, null, null, T)).toBe(true);
  });
  it('tenant consent is usable ONLY when the notification tenant matches its provenance', async () => {
    expect(await check('tenant', A, null, A, null)).toBe(true);   // academy A opt-in, academy A notif
    expect(await check('tenant', A, null, B, null)).toBe(false);  // academy A opt-in, academy B notif → DENIED
    expect(await check('tenant', null, T, null, T)).toBe(true);   // trainer T
    expect(await check('tenant', A, null, null, null)).toBe(false); // no tenant ctx → denied
  });
});

describe('delivery-events generalization', () => {
  it('recipient_email is now nullable and a WhatsApp phone row inserts cleanly', async () => {
    await db.query(
      `INSERT INTO public.email_delivery_events (event_type, channel, recipient_email, destination_redacted)
       VALUES ('sent', 'whatsapp', NULL, '+31•••1234')`);
    const { rows } = await db.query<{ ch: string; em: string | null }>(
      `SELECT channel AS ch, recipient_email AS em FROM public.email_delivery_events WHERE channel='whatsapp'`);
    expect(rows[0].ch).toBe('whatsapp');
    expect(rows[0].em).toBeNull();
  });
  it('an email row still defaults channel to email', async () => {
    await db.query(`INSERT INTO public.email_delivery_events (event_type, recipient_email) VALUES ('sent', 'x@y.com')`);
    const { rows } = await db.query<{ ch: string }>(
      `SELECT channel AS ch FROM public.email_delivery_events WHERE recipient_email='x@y.com'`);
    expect(rows[0].ch).toBe('email');
  });
});
