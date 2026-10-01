// @vitest-environment node
//
// ABC-23 §§3-5 — the settlement boundaries, exercised for real.
//
// These assert what a caller can OBSERVE, because every defect in this area was a mapping defect:
// a replay reported as a first transition (double confirmation email), a refusal reported as
// success (money captured, seat never given), an invoice marked paid whose bookings were not.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';
import {
  settlePaidBookings,
  hasFirstPaidTransition,
  isHardRefusal,
  type SettlementOutcome,
} from '../../supabase/functions/_shared/settlement.ts';

const { Client } = pg;
const PORT = 54401;

let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let a: pg.Client;
let b: pg.Client;
let obs: pg.Client;
let pidA = 0;
let pidB = 0;

const SLOT = 'aa000000-0000-4000-8000-000000000001';
const GUEST = '2a000000-0000-4000-8000-000000000001';
const GUEST2 = '2a000000-0000-4000-8000-000000000002';
const TRAINER_USER = '5a000000-0000-4000-8000-000000000001';

/** The real Edge-side client seam, backed by a real Postgres session. */
const rpcClient = (c: pg.Client) => ({
  async rpc(fn: string, args: Record<string, unknown>) {
    const keys = Object.keys(args);
    const sql = `SELECT * FROM public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    try {
      const r = await c.query(sql, keys.map((k) => args[k] as unknown));
      return { data: r.rows, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message } };
    }
  },
});

const settle = (c: pg.Client, req: Parameters<typeof settlePaidBookings>[1]) =>
  settlePaidBookings(rpcClient(c), req);

const mk = (c: pg.Client, id: string, cols: Record<string, unknown>) => {
  const base: Record<string, unknown> = {
    id, slot_id: SLOT, status: 'payment_pending', payment_status: 'pending',
    guest_player_id: null, player_id: null, hold_expires_at: null,
    mollie_payment_id: null, paid_at: null, ...cols,
  };
  const keys = Object.keys(base);
  return c.query(
    `INSERT INTO public.bookings (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => base[k]));
};
const expired = (extra: Record<string, unknown> = {}) => ({
  status: 'payment_pending', hold_expires_at: new Date(Date.now() - 6e5).toISOString(), ...extra,
});
const row = async (id: string) => (await a.query(
  `SELECT status, payment_status, mollie_payment_id, mollie_transaction_id, paid_by_player_id, paid_at
     FROM public.bookings WHERE id = $1`, [id])).rows[0];
const invRow = async (id: string) => (await a.query(
  `SELECT status, paid_at, mollie_payment_id, booking_ids FROM public.invoices WHERE id = $1`, [id])).rows[0];
const asUid = (c: pg.Client, uid: string | null) =>
  c.query(`SELECT set_config('abc16.uid', $1, false)`, [uid ?? '']);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc23-bb-'));
  epg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: PORT, persistent: false });
  await epg.initialise();
  await epg.start();
  const url = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

  const boot = new Client({ connectionString: url });
  await boot.connect();
  const exec = async (sql: string) => { await boot.query(sql); };
  await applyPreH0(exec);
  await boot.query(FIXTURE_SQL);
  await applyH0(exec);
  await boot.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_booking_per_slot_guest
      ON public.bookings (slot_id, guest_player_id)
      WHERE guest_player_id IS NOT NULL AND status IN ('pending','confirmed','completed');
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_booking_per_slot_player
      ON public.bookings (slot_id, player_id)
      WHERE player_id IS NOT NULL AND guest_player_id IS NULL
        AND status IN ('pending','confirmed','completed');
    INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES
      ('${GUEST}', 'BB Guest', '${IDS.attackerAcademy}'),
      ('${GUEST2}', 'BB Guest Two', '${IDS.attackerAcademy}');
    INSERT INTO public.availability_slots (id, academy_profile_id, max_participants, split_payment)
      VALUES ('${SLOT}', '${IDS.attackerAcademy}', 2, true);
    INSERT INTO auth.users (id, email) VALUES ('${TRAINER_USER}', 'bbtrainer@example.test')
      ON CONFLICT (id) DO NOTHING;
    -- The fixture already owns the attacker trainer row; adopt ITS user_id rather than asserting
    -- a second one, or the gate would be tested against an identity the mapping never had.
    UPDATE public.trainer_profiles SET user_id = '${TRAINER_USER}' WHERE id = '${IDS.attackerTrainer}';
    INSERT INTO public.trainer_profiles (id, user_id)
      SELECT '${IDS.attackerTrainer}', '${TRAINER_USER}'
       WHERE NOT EXISTS (SELECT 1 FROM public.trainer_profiles WHERE id = '${IDS.attackerTrainer}');
  `);
  await boot.end();

  a = new Client({ connectionString: url }); await a.connect();
  b = new Client({ connectionString: url }); await b.connect();
  obs = new Client({ connectionString: url }); await obs.connect();
  pidA = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  pidB = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
}, 300_000);

beforeEach(async () => {
  await a.query(`DELETE FROM public.bookings WHERE slot_id = '${SLOT}'`);
  await a.query(`DELETE FROM public.invoices`);
});

afterAll(async () => {
  for (const c of [a, b, obs]) { try { await c?.end(); } catch { /* ignore */ } }
  try { await epg?.stop(); } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('§3 · direct webhook boundary — outcome mapping', () => {
  const H = 'ba000000-0000-4000-8000-000000000001';

  it('a first paid transition is the ONLY outcome that may confirm the customer', async () => {
    await mk(a, H, { guest_player_id: GUEST, status: 'payment_pending' });
    const o = await settle(a, { source: 'webhook_direct', bookingIds: [H], providerPaymentId: 'tr_1', providerTransactionId: 'tr_1' });
    expect(o.confirmedPaid).toEqual([H]);
    expect(hasFirstPaidTransition(o)).toBe(true);
    expect(o.source).toBe('webhook_direct');
    expect(await row(H)).toMatchObject({ status: 'confirmed', payment_status: 'paid', mollie_payment_id: 'tr_1' });
  });

  it('a duplicate delivery is a REPLAY — no first transition, no confirmation', async () => {
    await mk(a, H, { guest_player_id: GUEST });
    await settle(a, { source: 'webhook_direct', bookingIds: [H], providerPaymentId: 'tr_1' });
    const second = await settle(a, { source: 'webhook_direct', bookingIds: [H], providerPaymentId: 'tr_1' });
    expect(second.confirmedPaid).toEqual([]);
    expect(second.alreadyConfirmedPaid).toEqual([H]);
    expect(hasFirstPaidTransition(second)).toBe(false);
  });

  it('a lapsed hold in a full slot becomes paid_no_seat — money recorded, nobody confirmed', async () => {
    await mk(a, 'ba000000-0000-4000-8000-0000000000f1', { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, 'ba000000-0000-4000-8000-0000000000f2', { guest_player_id: GUEST2, status: 'confirmed' });
    const late = 'ba000000-0000-4000-8000-0000000000f3';
    await mk(a, late, { player_id: IDS.nascentProfile, ...expired() });

    const o = await settle(a, { source: 'webhook_direct', bookingIds: [late], providerPaymentId: 'tr_2' });
    expect(o.paidNoSeat).toEqual([late]);
    expect(hasFirstPaidTransition(o)).toBe(false);          // no customer confirmation
    expect(await row(late)).toMatchObject({ status: 'cancelled', payment_status: 'paid' });
  });

  it('the no-seat signal is at most once: a redelivery reports it as a replay', async () => {
    await mk(a, 'ba000000-0000-4000-8000-0000000000e1', { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, 'ba000000-0000-4000-8000-0000000000e2', { guest_player_id: GUEST2, status: 'confirmed' });
    const late = 'ba000000-0000-4000-8000-0000000000e3';
    await mk(a, late, { player_id: IDS.nascentProfile, ...expired() });

    const first = await settle(a, { source: 'webhook_direct', bookingIds: [late], providerPaymentId: 'tr_3' });
    const again = await settle(a, { source: 'webhook_direct', bookingIds: [late], providerPaymentId: 'tr_3' });
    expect(first.paidNoSeat).toEqual([late]);
    expect(again.paidNoSeat).toEqual([]);                    // the alert cannot fire twice
    expect(again.replayedPaidNoSeat).toEqual([late]);
  });

  it('an M-17 survivor settles onto the survivor, and the replay is silent', async () => {
    const surv = 'ba000000-0000-4000-8000-0000000000d1';
    const hold = 'ba000000-0000-4000-8000-0000000000d2';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    const first = await settle(a, { source: 'webhook_direct', bookingIds: [hold], providerPaymentId: 'tr_4' });
    expect(first.confirmedPaid).toEqual([surv]);
    const replay = await settle(a, { source: 'webhook_direct', bookingIds: [hold], providerPaymentId: 'tr_4' });
    expect(hasFirstPaidTransition(replay)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('§3 · linked-invoice boundary — atomic, or nothing', () => {
  const INV = 'ca000000-0000-4000-8000-000000000001';
  const H = 'bb000000-0000-4000-8000-000000000001';

  it('invoice and bookings settle together, and only this request claims the invoice', async () => {
    await mk(a, H, { guest_player_id: GUEST });
    await a.query(`INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1,'sent',ARRAY[$2]::uuid[])`, [INV, H]);

    const o = await settle(a, { source: 'webhook_invoice', bookingIds: [H], providerPaymentId: 'tr_i1', invoiceId: INV });
    expect(o.invoicePaidNow).toBe(true);
    expect(o.confirmedPaid).toEqual([H]);
    expect((await invRow(INV)).status).toBe('paid');
    expect(await row(H)).toMatchObject({ payment_status: 'paid' });

    const dup = await settle(a, { source: 'webhook_invoice', bookingIds: [H], providerPaymentId: 'tr_i1', invoiceId: INV });
    expect(dup.invoicePaidNow).toBe(false);       // notify/forward gate closes for the duplicate
    expect(hasFirstPaidTransition(dup)).toBe(false);
  });

  it('ROLLBACK: a refused settlement leaves the invoice unpaid AND the bookings untouched', async () => {
    await mk(a, H, { guest_player_id: GUEST });
    // cancelled invoice: the refusal happens after the invoice row is locked and re-read
    await a.query(`INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1,'cancelled',ARRAY[$2]::uuid[])`, [INV, H]);
    const o = await settle(a, { source: 'webhook_invoice', bookingIds: [H], providerPaymentId: 'tr_i2', invoiceId: INV });

    expect(o.refusalReason).toBe('invoice_cancelled');
    expect(isHardRefusal(o.refusalReason)).toBe(true);
    expect(o.invoicePaidNow).toBe(false);
    expect((await invRow(INV)).status).toBe('cancelled');
    expect((await row(H)).payment_status).not.toBe('paid');   // nothing partially applied
    expect((await row(H)).status).toBe('payment_pending');
  });

  it('an invoice with NO bookings takes the invoice-only path', async () => {
    await a.query(`INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1,'sent','{}'::uuid[])`, [INV]);
    const o = await settle(a, { source: 'webhook_invoice', bookingIds: [], providerPaymentId: 'tr_i3', invoiceId: INV });
    expect(o.refusalReason).toBeNull();
    expect(o.invoicePaidNow).toBe(true);
    expect((await invRow(INV)).status).toBe('paid');
    const again = await settle(a, { source: 'webhook_invoice', bookingIds: [], providerPaymentId: 'tr_i3', invoiceId: INV });
    expect(again.invoicePaidNow).toBe(false);
  });

  it('the invoice-only path REFUSES an invoice that has bookings — no seat may be skipped', async () => {
    await mk(a, H, { guest_player_id: GUEST });
    await a.query(`INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1,'sent',ARRAY[$2]::uuid[])`, [INV, H]);
    const o = await settle(a, { source: 'webhook_invoice', bookingIds: [], providerPaymentId: 'tr_i4', invoiceId: INV });
    expect(o.refusalReason).toBe('invoice_has_bookings');
    expect((await invRow(INV)).status).toBe('sent');
    expect((await row(H)).payment_status).not.toBe('paid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('§3 · rebook member coverage', () => {
  it('stamps the captain as payer INSIDE the settlement, on first transition only', async () => {
    const m1 = 'bc000000-0000-4000-8000-000000000001';
    await mk(a, m1, { guest_player_id: GUEST });
    const o = await settle(a, {
      source: 'webhook_rebook_member', bookingIds: [m1],
      providerPaymentId: 'tr_g1', paidByPlayerId: IDS.nascentProfile,
    });
    expect(o.confirmedPaid).toEqual([m1]);
    expect((await row(m1)).paid_by_player_id).toBe(IDS.nascentProfile);
  });

  it('a member who already paid their own seat is a replay, not a second coverage', async () => {
    const m2 = 'bc000000-0000-4000-8000-000000000002';
    await mk(a, m2, { guest_player_id: GUEST, status: 'confirmed', payment_status: 'paid', mollie_payment_id: 'tr_self' });
    const o = await settle(a, {
      source: 'webhook_rebook_member', bookingIds: [m2],
      providerPaymentId: 'tr_g2', paidByPlayerId: IDS.nascentProfile,
    });
    expect(o.confirmedPaid).toEqual([]);
    expect(o.alreadyConfirmedPaid).toEqual([m2]);
    expect(o.refusalReason).toBeNull();        // one self-paid member must not fail the batch
    expect((await row(m2)).mollie_payment_id).toBe('tr_self');   // their own payment is not overwritten
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('§3 · rebook member coverage — the conflict that IS still refused', () => {
  it('an UNPAID booking bearing a different in-flight payment is refused, not overwritten', async () => {
    const m3 = 'bc000000-0000-4000-8000-000000000003';
    await mk(a, m3, { guest_player_id: GUEST, mollie_payment_id: 'tr_other_inflight' });
    const o = await settle(a, {
      source: 'webhook_rebook_member', bookingIds: [m3], providerPaymentId: 'tr_g3',
    });
    expect(o.refusalReason).toBe('provider_payment_id_conflict');
    expect((await row(m3)).payment_status).not.toBe('paid');
  });
});

describe('§3 · webhook versus verifier duplicate delivery', () => {
  it('two live sessions racing the same payment produce exactly ONE first transition', async () => {
    const H = 'bd000000-0000-4000-8000-000000000001';
    await mk(a, H, { guest_player_id: GUEST });

    for (const c of [a, b]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '20s'`);
      await c.query(`SET LOCAL statement_timeout = '25s'`);
    }
    let outA: SettlementOutcome | undefined;
    let outB: SettlementOutcome | undefined;
    try {
      const pA = settle(a, { source: 'webhook_direct', bookingIds: [H], providerPaymentId: 'tr_race' });

      // wait until A really holds the advisory key, so B genuinely contends
      const by = Date.now() + 8000;
      let held = false;
      while (Date.now() < by && !held) {
        const q = await obs.query(
          `SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted`, [pidA]);
        held = q.rows[0].n > 0;
        if (!held) await new Promise((s) => setTimeout(s, 20));
      }
      expect(held).toBe(true);

      let bSettled = false;
      const pB = settle(b, { source: 'verifier', bookingIds: [H], providerPaymentId: 'tr_race' })
        .then((r) => { bSettled = true; return r; });

      const verdict = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < verdict && !bSettled && !blocked) {
        const w = await obs.query(`SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND NOT granted`, [pidB]);
        blocked = w.rows[0].n > 0;
        if (!blocked && !bSettled) await new Promise((s) => setTimeout(s, 20));
      }
      expect(bSettled || blocked).toBe(true);       // B is genuinely contending, not pre-resolved

      outA = await pA;
      await a.query('COMMIT');
      outB = await pB;
      await b.query('COMMIT');
    } finally {
      for (const c of [a, b]) { try { await c.query('ROLLBACK'); } catch { /* committed */ } }
    }

    const firsts = [outA, outB].filter((o) => o && hasFirstPaidTransition(o)).length;
    expect(firsts).toBe(1);                        // exactly one confirmation email
    expect((await row(H)).payment_status).toBe('paid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('§4 · manual settlement — authorization and no invented Mollie id', () => {
  const INV = 'ce000000-0000-4000-8000-000000000001';
  const H = 'be000000-0000-4000-8000-000000000001';

  const gate = async (uid: string | null, invoiceId: string) => {
    await asUid(a, uid);
    const r = await a.query(`SELECT public.can_settle_invoice_manually($1::uuid) AS ok`, [invoiceId]);
    return r.rows[0].ok as boolean;
  };

  beforeEach(async () => {
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids, trainer_id) VALUES ($1,'sent',ARRAY[$2]::uuid[],$3)`,
      [INV, H, IDS.attackerTrainer]);
    await mk(a, H, { guest_player_id: GUEST });
  });

  it('POSITIVE: the owning trainer may settle', async () => {
    expect(await gate(TRAINER_USER, INV)).toBe(true);
  });

  it('POSITIVE: an academy manager of the owning academy may settle', async () => {
    const inv2 = 'ce000000-0000-4000-8000-000000000002';
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids, academy_profile_id) VALUES ($1,'sent','{}'::uuid[],$2)`,
      [inv2, IDS.attackerAcademy]);
    expect(await gate(IDS.attackerUser, inv2)).toBe(true);
  });

  it('NEGATIVE: an outsider may not, and learns nothing about the invoice', async () => {
    expect(await gate(IDS.victimUser, INV)).toBe(false);
    // identical answer for an invoice that does not exist — no existence oracle
    expect(await gate(IDS.victimUser, 'ce000000-0000-4000-8000-0000000000ff')).toBe(false);
  });

  it('NEGATIVE: a manager of a DIFFERENT academy may not', async () => {
    const inv3 = 'ce000000-0000-4000-8000-000000000003';
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids, academy_profile_id) VALUES ($1,'sent','{}'::uuid[],$2)`,
      [inv3, IDS.victimAcademy]);
    expect(await gate(IDS.attackerUser, inv3)).toBe(false);
  });

  it('NEGATIVE: a NULL uid (the service role) does not satisfy a user check', async () => {
    expect(await gate(null, INV)).toBe(false);
  });

  it('manual settlement writes NO provider columns — no Mollie id is invented', async () => {
    const o = await settle(a, {
      source: 'manual_invoice', bookingIds: [H], providerPaymentId: '',
      invoiceId: INV, settlementSource: 'manual',
    });
    expect(o.refusalReason).toBeNull();
    expect(o.confirmedPaid).toEqual([H]);
    const r = await row(H);
    expect(r.payment_status).toBe('paid');
    expect(r.mollie_payment_id).toBeNull();
    expect(r.mollie_transaction_id).toBeNull();
    expect((await invRow(INV)).mollie_payment_id).toBeNull();
  });

  it('a manual retry is stable: nothing settles twice', async () => {
    const req = {
      source: 'manual_invoice' as const, bookingIds: [H], providerPaymentId: '',
      invoiceId: INV, settlementSource: 'manual' as const,
    };
    await settle(a, req);
    const again = await settle(a, req);
    expect(again.confirmedPaid).toEqual([]);
    expect(again.alreadyConfirmedPaid).toEqual([H]);
    expect(again.invoicePaidNow).toBe(false);
  });

  it('an unknown settlement source is refused outright', async () => {
    const o = await settle(a, {
      source: 'manual_invoice', bookingIds: [H], providerPaymentId: 'x',
      // deno-lint-ignore no-explicit-any
      settlementSource: 'free_money' as unknown as 'manual',
    });
    expect(o.refusalReason).toBe('invalid_settlement_source');
    expect((await row(H)).payment_status).not.toBe('paid');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
describe('§5 · reconciliation of captured money with no seat', () => {
  const OLD = 'bf000000-0000-4000-8000-000000000001';

  const reconcile = async (uid: string | null, since = '30 days') => {
    await asUid(a, uid);
    const r = await a.query(
      `SELECT check_name, severity, entity_id FROM public.reconcile_payments($1::interval)`, [since]);
    return r.rows as { check_name: string; severity: string; entity_id: string }[];
  };

  beforeEach(async () => {
    await a.query(`INSERT INTO public.abc16_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [IDS.attackerUser]);
    // an obligation from long before any reporting window
    await mk(a, OLD, {
      status: 'cancelled', payment_status: 'paid', mollie_payment_id: 'tr_old',
      paid_at: new Date(Date.now() - 400 * 864e5).toISOString(), guest_player_id: GUEST,
    });
    await a.query(`UPDATE public.bookings SET payment_amount = 25 WHERE id = $1`, [OLD]);
  });

  it('reports paid_no_seat even for a booking far OUTSIDE _since', async () => {
    const rows = await reconcile(IDS.attackerUser, '1 day');
    const hit = rows.filter((r) => r.check_name === 'paid_no_seat' && r.entity_id === OLD);
    expect(hit).toHaveLength(1);
    expect(hit[0].severity).toBe('P0');
  });

  it('stays visible on every run until it is handled', async () => {
    expect((await reconcile(IDS.attackerUser, '1 day')).some((r) => r.entity_id === OLD)).toBe(true);
    expect((await reconcile(IDS.attackerUser, '1 day')).some((r) => r.entity_id === OLD)).toBe(true);
  });

  it('disappears ONLY once the local payment status is set to refunded', async () => {
    await a.query(`UPDATE public.bookings SET payment_status = 'refunded' WHERE id = $1`, [OLD]);
    const rows = await reconcile(IDS.attackerUser, '1 day');
    expect(rows.some((r) => r.check_name === 'paid_no_seat' && r.entity_id === OLD)).toBe(false);
  });

  it('any OTHER payment_status keeps it visible — only refunded clears it', async () => {
    for (const st of ['paid', 'pending', 'failed']) {
      await a.query(`UPDATE public.bookings SET payment_status = $2 WHERE id = $1`, [OLD, st]);
      const rows = await reconcile(IDS.attackerUser, '1 day');
      const present = rows.some((r) => r.check_name === 'paid_no_seat' && r.entity_id === OLD);
      expect({ st, present }).toEqual({ st, present: st === 'paid' });
    }
  });

  it('invoice-health-check consumes it: the row carries every column that function reads', async () => {
    await asUid(a, IDS.attackerUser);
    const r = await a.query(
      `SELECT check_name, severity, entity_kind, entity_id, detail
         FROM public.reconcile_payments('1 day'::interval)
        WHERE check_name = 'paid_no_seat'`);
    expect(r.rows.length).toBeGreaterThan(0);
    const row0 = r.rows[0];
    // invoice-health-check groups by check_name and renders `${severity} ${entity_kind}: ${detail}`
    expect(Object.keys(row0).sort()).toEqual(
      ['check_name', 'detail', 'entity_id', 'entity_kind', 'severity']);
    expect(row0.entity_kind).toBe('booking');
    expect(row0.detail).toHaveProperty('resolution');
    expect(String(row0.detail.resolution)).toContain('refunded');

    // and the function really does push every returned check_name, unfiltered
    const hc = readFileSync(
      join(process.cwd(), 'supabase/functions/invoice-health-check/index.ts'), 'utf8');
    expect(hc).toContain('byCheck.set(f.check_name, list)');
    expect(hc).toMatch(/pushAnomaly\(anomalies, `reconcile:\$\{check\}`/);
  });

  it('the admin gate is unchanged: a non-admin JWT is refused', async () => {
    await expect(reconcile(IDS.victimUser)).rejects.toThrow(/forbidden/i);
  });

  it('the service role (NULL uid) still runs it — the nightly job keeps working', async () => {
    const rows = await reconcile(null, '1 day');
    expect(rows.some((r) => r.check_name === 'paid_no_seat')).toBe(true);
  });
});
