// @vitest-environment node
//
// ABC-23 §1c — settle_paid_bookings, the atomic paid-settlement authority.
//
// Real multi-session PostgreSQL. The defect this replaces is a TOCTOU: a STABLE, lock-free
// classifier read followed by a later raw UPDATE, so two concurrent settlements could both read
// "fits" and both confirm. That cannot be demonstrated on a single connection.
//
// Harness rules learned the hard way in §1a and applied here:
//   * two worker clients plus a THIRD observer — node-postgres serializes per client, so an
//     observer query issued on a blocked client can never answer;
//   * backend PIDs captured BEFORE any statement can block;
//   * bounded lock/statement timeouts, and the lock budget exceeds the verdict window;
//   * guaranteed rollback in finally.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

const { Client } = pg;
const PORT = 54397;

let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let a: pg.Client;
let b: pg.Client;
let obs: pg.Client;
let pidA = 0;
let pidB = 0;

const SLOT1 = 'a3000000-0000-4000-8000-000000000001';
const SLOT2 = 'a3000000-0000-4000-8000-000000000002';
const PAY = 'tr_abc23_payment';

type Result = {
  confirmed_paid: string[]; already_confirmed_paid: string[];
  paid_no_seat: string[]; replayed_paid_no_seat: string[];
  refused: string[]; refusal_reason: string | null;
};

const settle = (c: pg.Client, ids: string[], pay = PAY, invoice: string | null = null) =>
  c.query(
    `SELECT * FROM public.settle_paid_bookings($1::uuid[], $2::text, $3::text, $4::uuid)`,
    [ids, pay, 'txn_1', invoice],
  ).then((r) => r.rows[0] as Result)
   .catch((e) => ({ error: String(e.message) } as unknown as Result));

const mkBooking = async (
  c: pg.Client, id: string, slot: string,
  status: string, holdOffsetMin: number | null, paymentStatus = 'pending',
) => c.query(
  `INSERT INTO public.bookings (id, slot_id, status, payment_status, hold_expires_at)
   VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL
                                ELSE clock_timestamp() + make_interval(mins => $5::int) END)`,
  [id, slot, status, paymentStatus, holdOffsetMin],
);

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc23-'));
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
    INSERT INTO public.availability_slots (id, academy_profile_id, max_participants, split_payment, allow_single_booking)
    VALUES ('${SLOT1}', '${IDS.attackerAcademy}', 2, true, false),
           ('${SLOT2}', '${IDS.attackerAcademy}', 2, true, false);
  `);
  await boot.end();

  a = new Client({ connectionString: url }); await a.connect();
  b = new Client({ connectionString: url }); await b.connect();
  obs = new Client({ connectionString: url }); await obs.connect();
  pidA = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  pidB = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  expect(pidA).not.toBe(pidB);
}, 300_000);

beforeEach(async () => { await a.query(`DELETE FROM public.bookings WHERE slot_id IN ('${SLOT1}','${SLOT2}')`); });

afterAll(async () => {
  for (const c of [a, b, obs]) { try { await c?.end(); } catch { /* ignore */ } }
  try { await epg?.stop(); } catch { /* ignore */ }
});

describe('ABC-23 · single-session settlement outcomes', () => {
  it('a LIVE hold confirms and is paid', async () => {
    const id = 'b3000000-0000-4000-8000-000000000001';
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    const r = await settle(a, [id]);
    expect(r.confirmed_paid).toEqual([id]);
    const row = await a.query(`SELECT status, payment_status, hold_expires_at, paid_at, mollie_payment_id FROM public.bookings WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ status: 'confirmed', payment_status: 'paid', hold_expires_at: null, mollie_payment_id: PAY });
    expect(row.rows[0].paid_at).not.toBeNull();
  });

  it('an EXPIRED hold that still fits confirms', async () => {
    const id = 'b3000000-0000-4000-8000-000000000002';
    await mkBooking(a, id, SLOT1, 'payment_pending', -30);
    const r = await settle(a, [id]);
    expect(r.confirmed_paid).toEqual([id]);
  });

  it('an EXPIRED hold after the last seat becomes paid_no_seat — paid, cancelled, hold cleared', async () => {
    const taken1 = 'b3000000-0000-4000-8000-00000000000a';
    const taken2 = 'b3000000-0000-4000-8000-00000000000b';
    const late = 'b3000000-0000-4000-8000-000000000003';
    await mkBooking(a, taken1, SLOT1, 'confirmed', null);
    await mkBooking(a, taken2, SLOT1, 'confirmed', null);
    await mkBooking(a, late, SLOT1, 'payment_pending', -30);

    const r = await settle(a, [late]);
    expect(r.paid_no_seat).toEqual([late]);
    expect(r.confirmed_paid).toEqual([]);

    const row = await a.query(
      `SELECT status, payment_status, hold_expires_at, paid_at, mollie_payment_id, mollie_transaction_id
         FROM public.bookings WHERE id = $1`, [late]);
    expect(row.rows[0]).toMatchObject({
      status: 'cancelled', payment_status: 'paid', hold_expires_at: null,
      mollie_payment_id: PAY, mollie_transaction_id: 'txn_1',
    });
    expect(row.rows[0].paid_at).not.toBeNull();
  });

  it('an already-occupying booking is marked paid without needing new capacity', async () => {
    const t1 = 'b3000000-0000-4000-8000-00000000001a';
    const t2 = 'b3000000-0000-4000-8000-00000000001b';
    await mkBooking(a, t1, SLOT1, 'confirmed', null);
    await mkBooking(a, t2, SLOT1, 'confirmed', null);
    const r = await settle(a, [t1]);
    expect(r.confirmed_paid).toEqual([t1]);
  });

  it('replay is a state-derived no-op with the same shape', async () => {
    const id = 'b3000000-0000-4000-8000-000000000004';
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    const first = await settle(a, [id]);
    const second = await settle(a, [id]);
    expect(first.confirmed_paid).toEqual([id]);
    expect(second.confirmed_paid).toEqual([]);
    expect(second.already_confirmed_paid).toEqual([id]);
  });

  it('paid_no_seat replay is stable and does not re-signal', async () => {
    const t1 = 'b3000000-0000-4000-8000-00000000002a';
    const t2 = 'b3000000-0000-4000-8000-00000000002b';
    const late = 'b3000000-0000-4000-8000-000000000005';
    await mkBooking(a, t1, SLOT1, 'confirmed', null);
    await mkBooking(a, t2, SLOT1, 'confirmed', null);
    await mkBooking(a, late, SLOT1, 'payment_pending', -30);
    const first = await settle(a, [late]);
    const second = await settle(a, [late]);
    expect(first.paid_no_seat).toEqual([late]);
    expect(second.paid_no_seat).toEqual([]);
    expect(second.replayed_paid_no_seat).toEqual([late]);
  });

  it('SAME-SLOT expired additions are ALL-OR-NONE — never a uuid-order winner', async () => {
    // one free seat, two expired additions: both must fail, not "lowest uuid wins".
    const taken = 'b3000000-0000-4000-8000-00000000003a';
    const x1 = 'b3000000-0000-4000-8000-000000000006';
    const x2 = 'b3000000-0000-4000-8000-000000000007';
    await mkBooking(a, taken, SLOT1, 'confirmed', null);
    await mkBooking(a, x1, SLOT1, 'payment_pending', -30);
    await mkBooking(a, x2, SLOT1, 'payment_pending', -30);
    const r = await settle(a, [x1, x2]);
    expect(r.paid_no_seat.sort()).toEqual([x1, x2].sort());
    expect(r.confirmed_paid).toEqual([]);
  });

  it('independent slots fulfil independently (partial fulfilment)', async () => {
    const full1 = 'b3000000-0000-4000-8000-00000000004a';
    const full2 = 'b3000000-0000-4000-8000-00000000004b';
    const lateFull = 'b3000000-0000-4000-8000-000000000008';
    const roomy = 'b3000000-0000-4000-8000-000000000009';
    await mkBooking(a, full1, SLOT1, 'confirmed', null);
    await mkBooking(a, full2, SLOT1, 'confirmed', null);
    await mkBooking(a, lateFull, SLOT1, 'payment_pending', -30);
    await mkBooking(a, roomy, SLOT2, 'payment_pending', -30);

    const r = await settle(a, [lateFull, roomy]);
    expect(r.paid_no_seat).toEqual([lateFull]);
    expect(r.confirmed_paid).toEqual([roomy]);
  });

  it('a cancelled booking is never resurrected', async () => {
    const id = 'b3000000-0000-4000-8000-00000000000c';
    await mkBooking(a, id, SLOT1, 'cancelled', null);
    const r = await settle(a, [id]);
    expect(r.refused).toEqual([id]);
    expect(r.refusal_reason).toBe('already_cancelled');
    const row = await a.query(`SELECT status FROM public.bookings WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('cancelled');
  });
});

describe('ABC-23 · input and association refusals', () => {
  it('rejects empty, null and duplicate targets', async () => {
    expect((await settle(a, [])).refusal_reason).toBe('no_targets');
    const id = 'b3000000-0000-4000-8000-00000000000d';
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    expect((await settle(a, [id, id])).refusal_reason).toBe('duplicate_targets');
  });

  it('rejects an unknown target rather than settling the rest', async () => {
    const known = 'b3000000-0000-4000-8000-00000000000e';
    await mkBooking(a, known, SLOT1, 'payment_pending', 30);
    const r = await settle(a, [known, 'b3000000-0000-4000-8000-0000000000ff']);
    expect(r.refusal_reason).toBe('unknown_target');
    const row = await a.query(`SELECT payment_status FROM public.bookings WHERE id = $1`, [known]);
    expect(row.rows[0].payment_status).not.toBe('paid');   // nothing settled
  });

  it('refuses a DIFFERENT stored provider payment id rather than overwriting it', async () => {
    const id = 'b3000000-0000-4000-8000-000000000010';
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    await a.query(`UPDATE public.bookings SET mollie_payment_id = 'tr_OTHER' WHERE id = $1`, [id]);
    const r = await settle(a, [id]);
    expect(r.refusal_reason).toBe('provider_payment_id_conflict');
    const row = await a.query(`SELECT mollie_payment_id, payment_status FROM public.bookings WHERE id = $1`, [id]);
    expect(row.rows[0].mollie_payment_id).toBe('tr_OTHER');
    expect(row.rows[0].payment_status).not.toBe('paid');
  });

  it('refuses when the invoice association does not hold', async () => {
    const id = 'b3000000-0000-4000-8000-000000000011';
    const inv = 'c3000000-0000-4000-8000-000000000001';
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1, 'sent', '{}'::uuid[])`, [inv]);
    const r = await settle(a, [id], PAY, inv);
    expect(r.refusal_reason).toBe('invoice_association_mismatch');
  });

  it('settles invoice and bookings in ONE transaction when the association holds', async () => {
    const id = 'b3000000-0000-4000-8000-000000000012';
    const inv = 'c3000000-0000-4000-8000-000000000002';
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1, 'sent', ARRAY[$2]::uuid[])`, [inv, id]);
    const r = await settle(a, [id], PAY, inv);
    expect(r.confirmed_paid).toEqual([id]);
    const i = await a.query(`SELECT status, paid_at FROM public.invoices WHERE id = $1`, [inv]);
    expect(i.rows[0].status).toBe('paid');
    expect(i.rows[0].paid_at).not.toBeNull();
  });

  it('keeps the invoice PAID even when every booking came back paid_no_seat', async () => {
    const t1 = 'b3000000-0000-4000-8000-00000000005a';
    const t2 = 'b3000000-0000-4000-8000-00000000005b';
    const late = 'b3000000-0000-4000-8000-000000000013';
    const inv = 'c3000000-0000-4000-8000-000000000003';
    await mkBooking(a, t1, SLOT1, 'confirmed', null);
    await mkBooking(a, t2, SLOT1, 'confirmed', null);
    await mkBooking(a, late, SLOT1, 'payment_pending', -30);
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1, 'sent', ARRAY[$2]::uuid[])`, [inv, late]);
    const r = await settle(a, [late], PAY, inv);
    expect(r.paid_no_seat).toEqual([late]);
    const i = await a.query(`SELECT status FROM public.invoices WHERE id = $1`, [inv]);
    expect(i.rows[0].status).toBe('paid');   // money captured; ABC-23 does not auto-refund
  });
});

describe('ABC-23 · capacity provenance is DB-derived', () => {
  it('a split/per-seat slot uses the raw participant cap', async () => {
    const t1 = 'b3000000-0000-4000-8000-00000000006a';
    const late = 'b3000000-0000-4000-8000-000000000014';
    await mkBooking(a, t1, SLOT1, 'confirmed', null);      // 1 of 2 taken
    await mkBooking(a, late, SLOT1, 'payment_pending', -30);
    const r = await settle(a, [late]);
    expect(r.confirmed_paid).toEqual([late]);              // second seat available
  });

  it('a WHOLE-SLOT purchase slot caps at one occupant', async () => {
    const whole = 'a3000000-0000-4000-8000-000000000003';
    await a.query(
      `INSERT INTO public.availability_slots (id, academy_profile_id, max_participants, split_payment, allow_single_booking)
       VALUES ($1, $2, 4, false, false)`, [whole, IDS.attackerAcademy]);
    const t1 = 'b3000000-0000-4000-8000-00000000007a';
    const late = 'b3000000-0000-4000-8000-000000000015';
    await mkBooking(a, t1, whole, 'confirmed', null);
    await mkBooking(a, late, whole, 'payment_pending', -30);
    const r = await settle(a, [late]);
    // max_participants is 4, but a whole-slot purchase seats ONE — the raw cap would oversell.
    expect(r.paid_no_seat).toEqual([late]);
  });
});

describe('ABC-23 · concurrency (two sessions, observer, bounded)', () => {
  /**
   * Genuine race: lead runs first and is PROVEN to hold an advisory lock via the observer, then
   * the follower launches. We wait for a real verdict — follower settled, or follower observably
   * blocked — before committing the lead. Never query a blocked client.
   */
  async function race(
    idsLead: string[], idsFollow: string[], firstMover: 'A' | 'B' = 'A',
  ): Promise<{ lead: Result; follow: Result }> {
    const lead = firstMover === 'A' ? { c: a, pid: pidA } : { c: b, pid: pidB };
    const follow = firstMover === 'A' ? { c: b, pid: pidB } : { c: a, pid: pidA };

    for (const c of [a, b]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '20s'`);
      await c.query(`SET LOCAL statement_timeout = '25s'`);
    }
    try {
      const pLead = lead.c.query(
        `SELECT * FROM public.settle_paid_bookings($1::uuid[], $2::text, $3::text, NULL)`,
        [idsLead, PAY, 'txn_1']).then((r) => r.rows[0] as Result);

      const held = Date.now() + 8000;
      let holds = false;
      while (Date.now() < held && !holds) {
        const r = await obs.query(
          `SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted`, [lead.pid]);
        holds = r.rows[0].n > 0;
        if (!holds) await new Promise((s) => setTimeout(s, 20));
      }
      expect(holds).toBe(true);

      let followSettled = false;
      const pFollow = follow.c.query(
        `SELECT * FROM public.settle_paid_bookings($1::uuid[], $2::text, $3::text, NULL)`,
        [idsFollow, PAY, 'txn_1']).then((r) => { followSettled = true; return r.rows[0] as Result; });

      const verdict = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < verdict && !followSettled && !blocked) {
        const w = await obs.query(
          `SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND NOT granted`, [follow.pid]);
        blocked = w.rows[0].n > 0;
        if (!blocked && !followSettled) await new Promise((s) => setTimeout(s, 20));
      }
      expect(followSettled || blocked).toBe(true);   // a real concurrent window, not a fake race

      await lead.c.query('COMMIT');
      const fr = await pFollow;
      await follow.c.query('COMMIT');
      const lr = await pLead;
      return { lead: lr, follow: fr };
    } finally {
      for (const c of [a, b]) { try { await c.query('ROLLBACK'); } catch { /* committed */ } }
    }
  }

  it.each([['A first', 'A' as const], ['B first', 'B' as const]])(
    'two settlements racing for ONE last seat — %s — exactly one occupies', async (_l, order) => {
      const taken = 'b3000000-0000-4000-8000-00000000008a';
      const x1 = 'b3000000-0000-4000-8000-000000000020';
      const x2 = 'b3000000-0000-4000-8000-000000000021';
      await a.query(`DELETE FROM public.bookings WHERE slot_id = '${SLOT1}'`);
      await mkBooking(a, taken, SLOT1, 'confirmed', null);
      await mkBooking(a, x1, SLOT1, 'payment_pending', -30);
      await mkBooking(a, x2, SLOT1, 'payment_pending', -30);

      const { lead, follow } = await race([x1], [x2], order);
      const confirmed = [...lead.confirmed_paid, ...follow.confirmed_paid];
      const noSeat = [...lead.paid_no_seat, ...follow.paid_no_seat];
      expect(confirmed).toHaveLength(1);
      expect(noSeat).toHaveLength(1);

      // the court is not oversold, and the loser is financially paid
      const occ = await a.query(
        `SELECT count(*)::int n FROM public.bookings
          WHERE slot_id = $1 AND public.booking_occupies_seat(status, hold_expires_at)`, [SLOT1]);
      expect(occ.rows[0].n).toBe(2);
      const loser = await a.query(
        `SELECT status, payment_status FROM public.bookings WHERE id = $1`, [noSeat[0]]);
      expect(loser.rows[0]).toMatchObject({ status: 'cancelled', payment_status: 'paid' });
    });

  it.each([['A first', 'A' as const], ['B first', 'B' as const]])(
    'overlapping multi-booking settlements with INVERSE input order — %s — bounded, no deadlock',
    async (_l, order) => {
      const p = 'b3000000-0000-4000-8000-0000000000';
      const ids = [`${p}30`, `${p}31`];
      await a.query(`DELETE FROM public.bookings WHERE slot_id IN ('${SLOT1}','${SLOT2}')`);
      await mkBooking(a, ids[0], SLOT1, 'payment_pending', 30);
      await mkBooking(a, ids[1], SLOT2, 'payment_pending', 30);
      // inverse input order: the lock protocol must normalize, or these deadlock
      const { lead, follow } = await race([ids[0], ids[1]], [ids[1], ids[0]], order);
      expect([lead, follow].every((r) => !(r as unknown as { error?: string }).error)).toBe(true);
      const rows = await a.query(
        `SELECT count(*)::int n FROM public.bookings WHERE id = ANY($1::uuid[]) AND payment_status = 'paid'`, [ids]);
      expect(rows.rows[0].n).toBe(2);
    });

  it('webhook vs verifier duplicate delivery — exactly one first transition', async () => {
    const id = 'b3000000-0000-4000-8000-000000000040';
    await a.query(`DELETE FROM public.bookings WHERE slot_id = '${SLOT1}'`);
    await mkBooking(a, id, SLOT1, 'payment_pending', 30);
    const { lead, follow } = await race([id], [id], 'A');
    const firsts = [...lead.confirmed_paid, ...follow.confirmed_paid];
    const dupes = [...lead.already_confirmed_paid, ...follow.already_confirmed_paid];
    expect(firsts).toEqual([id]);
    expect(dupes).toEqual([id]);
  });
});

describe('ABC-23 · ACL matrix', () => {
  it('is service_role only, with an unrevoked control proving the default grant is real', async () => {
    const r = await a.query(`
      SELECT has_function_privilege('authenticated','public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)','EXECUTE') AS auth,
             has_function_privilege('anon','public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)','EXECUTE') AS anon,
             has_function_privilege('service_role','public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)','EXECUTE') AS svc,
             has_function_privilege('authenticated','public.booking_occupies_seat(text,timestamptz)','EXECUTE') AS control`);
    expect(r.rows[0]).toMatchObject({ auth: false, anon: false, svc: true, control: true });
  });

  it('SET ROLE authenticated actually cannot execute it', async () => {
    await a.query('SET ROLE authenticated');
    try {
      await expect(a.query(
        `SELECT * FROM public.settle_paid_bookings($1::uuid[], 'x', NULL, NULL)`,
        [['b3000000-0000-4000-8000-000000000099']],
      )).rejects.toThrow(/permission denied/i);
    } finally {
      await a.query('RESET ROLE');
    }
  });
});
