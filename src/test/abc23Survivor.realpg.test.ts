// @vitest-environment node
//
// ABC-23 Boundary A — M-17 survivor semantics INSIDE the atomic settlement command.
//
// A paid hold can collide with the partial unique indexes when staff added the same person to the
// same slot while the payment was in flight:
//   uniq_active_booking_per_slot_guest  (slot_id, guest_player_id) WHERE guest IS NOT NULL
//   uniq_active_booking_per_slot_player (slot_id, player_id)       WHERE player IS NOT NULL
//                                                                    AND guest IS NULL
// Both are guest-first by construction, so a dual-key row's player_id is never pure-profile
// identity. Confirming the hold would raise 23505 and turn captured money into an endless retry.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreH0, applyH0, FIXTURE_SQL, IDS } from './abc16Fixture';

const { Client } = pg;
const PORT = 54399;

let epg: InstanceType<typeof EmbeddedPostgres> | undefined;
let a: pg.Client;
let b: pg.Client;
let obs: pg.Client;
let pidA = 0;
let pidB = 0;

const SLOT = 'a9000000-0000-4000-8000-000000000001';
const GUEST = '29000000-0000-4000-8000-000000000001';
const OTHER_GUEST = '29000000-0000-4000-8000-000000000002';
const PROFILE = IDS.nascentProfile;
const PAY = 'tr_surv';

type Result = {
  confirmed_paid: string[]; already_confirmed_paid: string[];
  paid_no_seat: string[]; replayed_paid_no_seat: string[];
  refused: string[]; refusal_reason: string | null;
};

const settle = (c: pg.Client, ids: string[], pay = PAY, invoice: string | null = null) =>
  c.query(`SELECT * FROM public.settle_paid_bookings($1::uuid[], $2::text, $3::text, $4::uuid)`,
    [ids, pay, 'txn_s', invoice])
   .then((r) => r.rows[0] as Result)
   .catch((e) => ({ error: String(e.message) } as unknown as Result));

const mk = (c: pg.Client, id: string, cols: Record<string, unknown>) => {
  const base: Record<string, unknown> = {
    id, slot_id: SLOT, status: 'payment_pending', payment_status: 'pending',
    guest_player_id: null, player_id: null, hold_expires_at: null,
    mollie_payment_id: null, paid_at: null, ...cols,
  };
  const keys = Object.keys(base);
  return c.query(
    `INSERT INTO public.bookings (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => base[k]),
  );
};
/** an EXPIRED hold (the shape a late payment lands on) */
const expired = (extra: Record<string, unknown> = {}) => ({
  status: 'payment_pending', hold_expires_at: new Date(Date.now() - 6e5).toISOString(), ...extra,
});

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc23-surv-'));
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
  // the REAL M-17 indexes: the survivor path exists because of these
  await boot.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_booking_per_slot_guest
      ON public.bookings (slot_id, guest_player_id)
      WHERE guest_player_id IS NOT NULL AND status IN ('pending','confirmed','completed');
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_booking_per_slot_player
      ON public.bookings (slot_id, player_id)
      WHERE player_id IS NOT NULL AND guest_player_id IS NULL
        AND status IN ('pending','confirmed','completed');
    INSERT INTO public.guest_players (id, full_name, academy_profile_id) VALUES
      ('${GUEST}', 'Surv Guest', '${IDS.attackerAcademy}'),
      ('${OTHER_GUEST}', 'Other Guest', '${IDS.attackerAcademy}');
    INSERT INTO public.availability_slots (id, academy_profile_id, max_participants, split_payment)
      VALUES ('${SLOT}', '${IDS.attackerAcademy}', 2, true);
  `);
  await boot.end();

  a = new Client({ connectionString: url }); await a.connect();
  b = new Client({ connectionString: url }); await b.connect();
  obs = new Client({ connectionString: url }); await obs.connect();
  pidA = (await a.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  pidB = (await b.query('SELECT pg_backend_pid() AS p')).rows[0].p;
  expect(pidA).not.toBe(pidB);
}, 300_000);

beforeEach(async () => { await a.query(`DELETE FROM public.bookings WHERE slot_id = '${SLOT}'`); });

afterAll(async () => {
  for (const c of [a, b, obs]) { try { await c?.end(); } catch { /* ignore */ } }
  try { await epg?.stop(); } catch { /* ignore */ }
});

const row = async (id: string) => (await a.query(
  `SELECT status, payment_status, hold_expires_at, mollie_payment_id FROM public.bookings WHERE id = $1`,
  [id])).rows[0];

describe('Boundary A · guest survivor', () => {
  it('stamps the survivor paid, cancels the redundant hold, returns the survivor once', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000000a';
    const hold = 'b9000000-0000-4000-8000-00000000000b';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });

    const r = await settle(a, [hold]);
    expect(r.confirmed_paid).toEqual([surv]);
    expect(await row(surv)).toMatchObject({ status: 'confirmed', payment_status: 'paid', mollie_payment_id: PAY });
    // the redundant hold is cancelled and NOT marked paid — one payment, one paid row
    expect(await row(hold)).toMatchObject({ status: 'cancelled', hold_expires_at: null });
    expect((await row(hold)).payment_status).not.toBe('paid');
  });

  it('same-provider replay emits NO first transition', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000001a';
    const hold = 'b9000000-0000-4000-8000-00000000001b';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    await settle(a, [hold]);
    const second = await settle(a, [hold]);
    expect(second.confirmed_paid).toEqual([]);
  });

  it('preserves a COMPLETED survivor — never demoted to confirmed', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000002a';
    const hold = 'b9000000-0000-4000-8000-00000000002b';
    await mk(a, surv, { guest_player_id: GUEST, status: 'completed' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    const r = await settle(a, [hold]);
    expect(r.confirmed_paid).toEqual([surv]);
    expect((await row(surv)).status).toBe('completed');
  });

  it('a survivor already paid by a DIFFERENT provider is untouched; the hold becomes paid_no_seat', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000003a';
    const hold = 'b9000000-0000-4000-8000-00000000003b';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed', payment_status: 'paid', mollie_payment_id: 'tr_OTHER' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });

    const first = await settle(a, [hold]);
    expect(first.paid_no_seat).toEqual([hold]);
    expect(await row(surv)).toMatchObject({ mollie_payment_id: 'tr_OTHER' });
    expect(await row(hold)).toMatchObject({ status: 'cancelled', payment_status: 'paid' });

    const second = await settle(a, [hold]);
    expect(second.replayed_paid_no_seat).toEqual([hold]);
    expect(second.paid_no_seat).toEqual([]);
  });

  it('a survivor in an otherwise FULL slot still settles — the hold takes no new seat', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000004a';
    const filler = 'b9000000-0000-4000-8000-00000000004b';
    const hold = 'b9000000-0000-4000-8000-00000000004c';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, filler, { guest_player_id: OTHER_GUEST, status: 'confirmed' });   // slot now full (2/2)
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    const r = await settle(a, [hold]);
    expect(r.confirmed_paid).toEqual([surv]);
    expect(r.paid_no_seat).toEqual([]);
  });

  it('an UNRELATED hold in a full slot is still paid_no_seat', async () => {
    const f1 = 'b9000000-0000-4000-8000-00000000005a';
    const f2 = 'b9000000-0000-4000-8000-00000000005b';
    const hold = 'b9000000-0000-4000-8000-00000000005c';
    await mk(a, f1, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, f2, { guest_player_id: OTHER_GUEST, status: 'confirmed' });
    await mk(a, hold, { player_id: PROFILE, ...expired() });   // nobody's survivor
    const r = await settle(a, [hold]);
    expect(r.paid_no_seat).toEqual([hold]);
  });

  it('TWO target holds for ONE typed seat consume one seat and yield ONE first transition', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000006a';
    const h1 = 'b9000000-0000-4000-8000-00000000006b';
    const h2 = 'b9000000-0000-4000-8000-00000000006c';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, h1, { guest_player_id: GUEST, ...expired() });
    await mk(a, h2, { guest_player_id: GUEST, ...expired() });
    const r = await settle(a, [h1, h2]);
    expect(r.confirmed_paid).toEqual([surv]);   // deduplicated, one result
    expect((await row(h1)).status).toBe('cancelled');
    expect((await row(h2)).status).toBe('cancelled');
  });
});

describe('Boundary A · pure-profile survivor and dual-key NON-equivalence', () => {
  it('a pure-profile hold resolves to a pure-profile survivor', async () => {
    const surv = 'b9000000-0000-4000-8000-00000000007a';
    const hold = 'b9000000-0000-4000-8000-00000000007b';
    await mk(a, surv, { player_id: PROFILE, status: 'confirmed' });
    await mk(a, hold, { player_id: PROFILE, ...expired() });
    const r = await settle(a, [hold]);
    expect(r.confirmed_paid).toEqual([surv]);
  });

  it('a DUAL-KEY active row is NOT a survivor for a pure-profile hold', async () => {
    // The player index is pinned to guest IS NULL, so these are different seats. Treating the
    // dual-key row as the survivor would attribute a guest's seat to an account.
    const dual = 'b9000000-0000-4000-8000-00000000008a';
    const hold = 'b9000000-0000-4000-8000-00000000008b';
    await mk(a, dual, { player_id: PROFILE, guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, hold, { player_id: PROFILE, ...expired() });
    const r = await settle(a, [hold]);
    expect(r.confirmed_paid).toEqual([hold]);     // settled on its own, not onto the dual row
    expect((await row(dual)).payment_status).not.toBe('paid');
  });

  it('a pure-profile active row is NOT a survivor for a dual-key hold', async () => {
    const pure = 'b9000000-0000-4000-8000-00000000009a';
    const hold = 'b9000000-0000-4000-8000-00000000009b';
    await mk(a, pure, { player_id: PROFILE, status: 'confirmed' });
    await mk(a, hold, { player_id: PROFILE, guest_player_id: OTHER_GUEST, ...expired() });
    const r = await settle(a, [hold]);
    expect(r.confirmed_paid).toEqual([hold]);
    expect((await row(pure)).payment_status).not.toBe('paid');
  });

  it('mixed batch: a survivor case and an independent target both settle', async () => {
    const surv = 'b9000000-0000-4000-8000-0000000000aa';
    const hold = 'b9000000-0000-4000-8000-0000000000ab';
    const indep = 'b9000000-0000-4000-8000-0000000000ac';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    await mk(a, indep, { guest_player_id: OTHER_GUEST, ...expired() });
    const r = await settle(a, [hold, indep]);
    expect(r.confirmed_paid.sort()).toEqual([surv, indep].sort());
  });
});

describe('Boundary A · invoice interaction', () => {
  const INV = 'c9000000-0000-4000-8000-000000000001';

  it('substitutes the survivor into booking_ids so no paid invoice cites only a cancelled hold', async () => {
    const surv = 'b9000000-0000-4000-8000-0000000000ba';
    const hold = 'b9000000-0000-4000-8000-0000000000bb';
    await mk(a, surv, { guest_player_id: GUEST, status: 'confirmed' });
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    await a.query(`INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1,'sent',ARRAY[$2]::uuid[])`, [INV, hold]);

    const r = await settle(a, [hold], PAY, INV);
    expect(r.confirmed_paid).toEqual([surv]);
    const inv = (await a.query(`SELECT status, booking_ids FROM public.invoices WHERE id=$1`, [INV])).rows[0];
    expect(inv.status).toBe('paid');
    expect(inv.booking_ids).toContain(surv);
    expect(inv.booking_ids).not.toContain(hold);
  });

  it('a CANCELLED invoice is refused and never resurrected', async () => {
    const hold = 'b9000000-0000-4000-8000-0000000000ca';
    const inv = 'c9000000-0000-4000-8000-000000000002';
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    await a.query(`INSERT INTO public.invoices (id, status, booking_ids) VALUES ($1,'cancelled',ARRAY[$2]::uuid[])`, [inv, hold]);
    const r = await settle(a, [hold], PAY, inv);
    expect(r.refusal_reason).toBe('invoice_cancelled');
    expect((await a.query(`SELECT status FROM public.invoices WHERE id=$1`, [inv])).rows[0].status).toBe('cancelled');
    expect((await row(hold)).payment_status).not.toBe('paid');
  });

  it('a missing invoice is refused without mutation', async () => {
    const hold = 'b9000000-0000-4000-8000-0000000000cb';
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    const r = await settle(a, [hold], PAY, 'c9000000-0000-4000-8000-0000000000ff');
    expect(r.refusal_reason).toBe('invoice_missing');
    expect((await row(hold)).payment_status).not.toBe('paid');
  });

  it('an invoice already claimed by a DIFFERENT provider is refused', async () => {
    const hold = 'b9000000-0000-4000-8000-0000000000cc';
    const inv = 'c9000000-0000-4000-8000-000000000003';
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });
    await a.query(
      `INSERT INTO public.invoices (id, status, booking_ids, mollie_payment_id) VALUES ($1,'sent',ARRAY[$2]::uuid[],'tr_OTHER')`,
      [inv, hold]);
    const r = await settle(a, [hold], PAY, inv);
    expect(r.refusal_reason).toBe('invoice_provider_conflict');
  });
});

describe('Boundary A · concurrency: staff insert races settlement', () => {
  async function race(order: 'A' | 'B', prep: () => Promise<void>, holdId: string, staffId: string) {
    await a.query(`DELETE FROM public.bookings WHERE slot_id = '${SLOT}'`);
    await prep();
    const lead = order === 'A' ? { c: a, pid: pidA } : { c: b, pid: pidB };
    const follow = order === 'A' ? { c: b, pid: pidB } : { c: a, pid: pidA };

    for (const c of [a, b]) {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '20s'`);
      await c.query(`SET LOCAL statement_timeout = '25s'`);
    }
    try {
      const pLead = lead.c.query(
        `SELECT * FROM public.settle_paid_bookings($1::uuid[], $2::text, $3::text, NULL)`,
        [[holdId], PAY, 'txn_s']).then((r) => r.rows[0] as Result);

      const by = Date.now() + 8000;
      let holds = false;
      while (Date.now() < by && !holds) {
        const q = await obs.query(
          `SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=$1 AND granted`, [lead.pid]);
        holds = q.rows[0].n > 0;
        if (!holds) await new Promise((s) => setTimeout(s, 20));
      }
      expect(holds).toBe(true);

      // a staff writer that does NOT take the advisory key
      let settled = false;
      const pStaff = follow.c.query(
        `INSERT INTO public.bookings (id, slot_id, guest_player_id, status, payment_status)
         VALUES ($1, $2, $3, 'confirmed', 'pending')`, [staffId, SLOT, GUEST])
        .then(() => { settled = true; return null; })
        .catch((e) => { settled = true; return { error: String(e.message) }; });

      const verdict = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < verdict && !settled && !blocked) {
        const w = await obs.query(
          `SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND NOT granted`, [follow.pid]);
        blocked = w.rows[0].n > 0;
        if (!blocked && !settled) await new Promise((s) => setTimeout(s, 20));
      }
      expect(settled || blocked).toBe(true);

      await lead.c.query('COMMIT');
      await pStaff;
      await follow.c.query('COMMIT');
      return await pLead;
    } finally {
      for (const c of [a, b]) { try { await c.query('ROLLBACK'); } catch { /* committed */ } }
    }
  }

  it.each([['A first', 'A' as const], ['B first', 'B' as const]])(
    'captured payment never becomes an endless 23505 — %s', async (_l, order) => {
      const hold = 'b9000000-0000-4000-8000-0000000000d1';
      const staff = 'b9000000-0000-4000-8000-0000000000d2';
      const r = await race(order, async () => {
        await mk(a, hold, { guest_player_id: GUEST, ...expired() });
      }, hold, staff);

      // whichever order, the payment is durably represented and nothing 500s
      expect((r as unknown as { error?: string }).error).toBeUndefined();
      const paidRows = await a.query(
        `SELECT count(*)::int n FROM public.bookings WHERE slot_id=$1 AND payment_status='paid'`, [SLOT]);
      expect(paidRows.rows[0].n).toBeGreaterThanOrEqual(1);
      // and the guest never occupies two active seats
      const active = await a.query(
        `SELECT count(*)::int n FROM public.bookings
          WHERE slot_id=$1 AND guest_player_id=$2 AND status IN ('pending','confirmed','completed')`,
        [SLOT, GUEST]);
      expect(active.rows[0].n).toBeLessThanOrEqual(1);
    });
});

describe('Boundary A · 23505 recovery for a writer without the advisory key', () => {
  // The genuine window: staff INSERT is uncommitted while settlement runs, so the survivor scan
  // cannot see it; the confirm UPDATE then blocks on the M-17 index and receives 23505 the moment
  // staff commits. Deterministic, and the exact shape that otherwise loops Mollie forever.
  it('reconciles in-transaction instead of raising — payment lands on the late seat', async () => {
    const hold = 'b9000000-0000-4000-8000-0000000000e1';
    const staff = 'b9000000-0000-4000-8000-0000000000e2';
    await mk(a, hold, { guest_player_id: GUEST, ...expired() });

    await b.query('BEGIN');
    await b.query(
      `INSERT INTO public.bookings (id, slot_id, guest_player_id, status, payment_status)
       VALUES ($1, $2, $3, 'confirmed', 'pending')`, [staff, SLOT, GUEST]);

    const pSettle = a.query(
      `SELECT * FROM public.settle_paid_bookings($1::uuid[], $2::text, $3::text, NULL)`,
      [[hold], PAY, 'txn_s']).then((r) => r.rows[0] as Result).catch((e) => ({ error: String(e.message) }));

    const by = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < by && !blocked) {
      const q = await obs.query(
        `SELECT count(*)::int n FROM pg_locks WHERE pid = $1 AND NOT granted`, [pidA]);
      blocked = q.rows[0].n > 0;
      if (!blocked) await new Promise((s) => setTimeout(s, 20));
    }
    expect(blocked).toBe(true);          // the confirm really is waiting on staff's tuple

    await b.query('COMMIT');
    const r = await pSettle as Result & { error?: string };

    expect(r.error).toBeUndefined();     // captured money, no 500, no endless retry
    expect(r.confirmed_paid).toEqual([staff]);
    expect(await row(staff)).toMatchObject({ payment_status: 'paid', mollie_payment_id: PAY });
    expect((await row(hold)).status).toBe('cancelled');
    expect((await row(hold)).payment_status).not.toBe('paid');
    await a.query(`DELETE FROM public.bookings WHERE id = $1`, [staff]);
  });
});
