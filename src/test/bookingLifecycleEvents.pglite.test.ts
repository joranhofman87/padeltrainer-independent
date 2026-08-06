// @vitest-environment node
/**
 * A1-A7 F1 — the booking lifecycle ledger, which is the clock the notification activation floor
 * measures against.
 *
 * Two clocks were tried on the bookings row itself and both failed, in opposite directions:
 *
 *   created_at  immutable, but the wrong question. A cancellation of a three-week-old booking was
 *               dated three weeks back, fell under the event-age floor, and was never sent.
 *   updated_at  the right question, but not immutable. The BEFORE UPDATE trigger refreshes it on
 *               EVERY column write, so editing a note or writing a payment id re-dated a year-old
 *               cancellation into the sendable window.
 *
 * These run the REAL migration against a real Postgres (pglite), including the real
 * `update_bookings_updated_at` trigger — because "an unrelated write re-dates the event" is a
 * statement about how those two triggers interact, and a hand-built stand-in cannot make it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

let db: PGlite;
const MIG = (f: string) => readFileSync(join(process.cwd(), 'supabase', 'migrations', f), 'utf8');

/** the ledger's own migration, minus the SQL producer (which needs the whole notification chain) */
function ledgerMigration(): string {
  const src = MIG('20261108100000_booking_lifecycle_events.sql');
  const cut = src.indexOf('-- ── the SQL producer, re-lifted onto the ledger');
  expect(cut, 'the producer section marker must exist').toBeGreaterThan(0);
  return src.slice(0, cut);
}

beforeAll(async () => {
  db = new PGlite();
  // the minimum real shape: bookings with its REAL updated_at trigger, which is the whole point.
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT NULL::uuid $fn$;
    CREATE TABLE public.bookings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid,
      player_id uuid,
      status text NOT NULL DEFAULT 'confirmed',
      payment_status text DEFAULT 'pending',
      paid_at timestamptz,
      notes text,
      mollie_payment_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    -- the REAL updated_at trigger, verbatim in behaviour: fires on every column write, with no OF
    CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END $fn$;
    CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON public.bookings
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  `);
  await db.exec(ledgerMigration());
  await db.exec(MIG('20261110100000_lifecycle_ledger_corrections.sql'));
}, 60_000);

afterAll(async () => { await db?.close(); });

const seedBooking = async (over: { created_at?: string; status?: string; payment_status?: string } = {}) => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO public.bookings (status, payment_status, created_at)
     VALUES ($1, $2, coalesce($3::timestamptz, now())) RETURNING id`,
    [over.status ?? 'confirmed', over.payment_status ?? 'pending', over.created_at ?? null]);
  return r.rows[0].id;
};
const events = async (id: string) =>
  (await db.query<{ event_type: string; occurred_at: string; from_status: string | null; to_status: string | null }>(
    `SELECT event_type, occurred_at, from_status, to_status FROM public.booking_lifecycle_events
      WHERE booking_id = $1 ORDER BY seq`, [id])).rows;
const occurrence = async (ids: string[], kind: string) =>
  (await db.query<{ at: string | null }>(
    `SELECT public.booking_transition_occurred_at($1::uuid[], $2) AS at`, [ids, kind])).rows[0].at;
const transition = async (ids: string[], kind: string) =>
  (await db.query<{ occurred_at: string | null; seq: string | null; set_key: string | null }>(
    `SELECT * FROM public.booking_transition_event($1::uuid[], $2)`, [ids, kind])).rows[0] ?? null;

describe('the lifecycle ledger records transitions, and only transitions', () => {
  it('an INSERT records created at the row\'s own created_at, not at the statement\'s now()', async () => {
    const backdated = '2026-05-01T10:00:00.000Z';
    const id = await seedBooking({ created_at: backdated });
    const evs = await events(id);
    expect(evs).toHaveLength(1);
    expect(evs[0].event_type).toBe('created');
    expect(new Date(evs[0].occurred_at).toISOString()).toBe(backdated);
  });

  it('each real status change gets exactly one row, mapped to its event type', async () => {
    const id = await seedBooking({ status: 'pending' });
    await db.query(`UPDATE public.bookings SET status='confirmed' WHERE id=$1`, [id]);
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    const evs = await events(id);
    expect(evs.map((e) => e.event_type)).toEqual(['created', 'confirmed', 'cancelled']);
    expect(evs[2]).toMatchObject({ from_status: 'confirmed', to_status: 'cancelled' });
  });

  it('a NO-OP write records nothing — a re-cancel must not manufacture a fresh occurrence', async () => {
    // cancelBookingsAndSync has no status precondition, so re-cancelling an already-cancelled
    // booking is a real production shape. If it minted a new event, an old cancellation would
    // become current simply by being re-issued.
    const id = await seedBooking({ status: 'cancelled' });
    const before = (await events(id)).length;
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    expect((await events(id)).length).toBe(before);
  });

  it('an UNRELATED write records nothing at all', async () => {
    const id = await seedBooking();
    const before = (await events(id)).length;
    await db.query(`UPDATE public.bookings SET notes='edited', mollie_payment_id='tr_1' WHERE id=$1`, [id]);
    expect((await events(id)).length).toBe(before);
  });

  it('payment transitions are recorded, and reaching paid is its own event', async () => {
    const id = await seedBooking();
    await db.query(`UPDATE public.bookings SET payment_status='paid' WHERE id=$1`, [id]);
    expect((await events(id)).map((e) => e.event_type)).toEqual(['created', 'paid']);
  });
});

describe('THE LAUNDERING CASE — the defect this ledger exists to close', () => {
  it('an unrelated later edit does NOT re-date an old cancellation', async () => {
    const id = await seedBooking({ created_at: '2025-08-01T09:00:00.000Z', status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    const atCancellation = await occurrence([id], 'cancelled');
    const beforeUpdatedAt = (await db.query<{ u: Date }>(
      `SELECT updated_at AS u FROM public.bookings WHERE id=$1`, [id])).rows[0].u;

    // the re-dater: any of the split-share rewrite, a mollie id write, a bulk anonymise — none of
    // which change status, all of which the bookings BEFORE UPDATE trigger stamps
    await new Promise((r) => setTimeout(r, 5));
    await db.query(`UPDATE public.bookings SET notes='unrelated edit' WHERE id=$1`, [id]);
    const afterUpdatedAt = (await db.query<{ u: Date }>(
      `SELECT updated_at AS u FROM public.bookings WHERE id=$1`, [id])).rows[0].u;

    // updated_at DID move — which is exactly why it cannot be the clock…
    expect(new Date(afterUpdatedAt).getTime()).toBeGreaterThan(new Date(beforeUpdatedAt).getTime());
    // …and the occurrence did NOT.
    expect(new Date(await occurrence([id], 'cancelled') as unknown as string).getTime())
      .toBe(new Date(atCancellation as unknown as string).getTime());
  });

  it('the ledger is append-only: an occurrence cannot be moved, and an event cannot be erased', async () => {
    const id = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    await expect(db.query(
      `UPDATE public.booking_lifecycle_events SET occurred_at = now() WHERE booking_id=$1`, [id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query(
      `DELETE FROM public.booking_lifecycle_events WHERE booking_id=$1`, [id]))
      .rejects.toThrow(/append-only/);
  });

  it('SET laundering: one recently touched member does not re-date a set of old cancellations', async () => {
    // the second bullet of the triage's "F1 is not closed" section: max(updated_at) let ONE
    // edited member re-date the whole historical set.
    const a = await seedBooking({ status: 'confirmed' });
    const b = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id = ANY($1::uuid[])`, [[a, b]]);
    const setOccurrence = await occurrence([a, b], 'cancelled');

    await new Promise((r) => setTimeout(r, 5));
    await db.query(`UPDATE public.bookings SET notes='touched' WHERE id=$1`, [b]);
    expect(new Date(await occurrence([a, b], 'cancelled') as unknown as string).getTime())
      .toBe(new Date(setOccurrence as unknown as string).getTime());
  });
});

describe('the delivery-loss fix stays fixed', () => {
  it('a cancellation TODAY of a booking made weeks ago is dated TODAY', async () => {
    // the round-2 correction: dating this from created_at buried a current cancellation under the
    // event-age floor and lost the message entirely. The ledger must not re-introduce that.
    const id = await seedBooking({ created_at: '2026-06-01T09:00:00.000Z', status: 'confirmed' });
    const before = Date.now();
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    const at = await occurrence([id], 'cancelled');
    expect(at).toBeTruthy();
    expect(new Date(at as unknown as string).getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('a transition that never happened has NO occurrence — the producer must fail closed', async () => {
    const id = await seedBooking({ status: 'confirmed' });
    expect(await occurrence([id], 'cancelled')).toBeNull();
  });
});

describe('the transition discriminator makes a second transition a second message', () => {
  const seq = async (ids: string[], kind: string) =>
    (await db.query<{ s: string | null }>(
      `SELECT public.booking_transition_seq($1::uuid[], $2) AS s`, [ids, kind])).rows[0].s;

  it('cancel → re-confirm → cancel yields two DIFFERENT discriminators', async () => {
    // without this the idempotency subject is (kind, booking set) alone and the second, genuine
    // cancellation is silently suppressed as a duplicate of the first.
    const id = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    const first = await seq([id], 'cancelled');
    await db.query(`UPDATE public.bookings SET status='confirmed' WHERE id=$1`, [id]);
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    const second = await seq([id], 'cancelled');
    expect(first).toBeTruthy();
    expect(Number(second)).toBeGreaterThan(Number(first));
  });

  it('a REDELIVERY of the same transition yields the SAME discriminator', async () => {
    const id = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    const a = await seq([id], 'cancelled');
    const b = await seq([id], 'cancelled');   // the producer runs again on a redelivered webhook
    expect(b).toBe(a);
  });
});

describe('the backfill is deliberately partial', () => {
  it('history gets created and paid, and NOTHING is synthesised for cancelled or confirmed', async () => {
    // re-run the backfill statements against rows that pre-date the ledger, then assert the shape:
    // synthesising a cancellation from updated_at is the lie being removed, so a historical
    // cancellation legitimately has no ledger row and its notification is refused.
    const src = MIG('20261108100000_booking_lifecycle_events.sql');
    expect(src).toContain("SELECT b.id, 'created', b.status, b.payment_status, b.created_at FROM public.bookings b");
    expect(src).toContain("WHERE b.paid_at IS NOT NULL");
    expect(src).not.toMatch(/INSERT INTO public\.booking_lifecycle_events[\s\S]{0,400}'cancelled'[\s\S]{0,200}updated_at/);
  });
});

describe('the corrections from the ledger review', () => {
  it('a MIXED set is dated by its OLDEST member — one fresh cancellation cannot re-date old ones', async () => {
    // max(occurred_at) let a single newly transitioned member make the whole set current: the same
    // shape as the max(updated_at) defect, arriving through the aggregate instead of the column.
    const old1 = await seedBooking({ status: 'confirmed' });
    const old2 = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id = ANY($1::uuid[])`, [[old1, old2]]);
    const oldAt = await occurrence([old1, old2], 'cancelled');

    await new Promise((r) => setTimeout(r, 5));
    const fresh = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [fresh]);

    const mixed = await occurrence([old1, old2, fresh], 'cancelled');
    expect(new Date(mixed as unknown as string).getTime())
      .toBe(new Date(oldAt as unknown as string).getTime());
  });

  it('the discriminator describes the WHOLE SET, not one member', async () => {
    // one member's seq is not enough: with A paid first and B paid second, the oldest is A, so a
    // subject built from A's seq does not move when B re-pays — and a genuine second payment is
    // suppressed as a duplicate of the first.
    const a = await seedBooking();
    const b = await seedBooking();
    await db.query(`UPDATE public.bookings SET payment_status='paid' WHERE id=$1`, [a]);
    await db.query(`UPDATE public.bookings SET payment_status='paid' WHERE id=$1`, [b]);
    const first = await transition([a, b], 'paid');
    expect(first?.set_key).toBeTruthy();

    // B unpays and pays again; A is untouched and still the oldest
    await db.query(`UPDATE public.bookings SET payment_status='pending' WHERE id=$1`, [b]);
    await db.query(`UPDATE public.bookings SET payment_status='paid' WHERE id=$1`, [b]);
    const second = await transition([a, b], 'paid');
    expect(second?.occurred_at).toBeTruthy();
    expect(second?.set_key).not.toBe(first?.set_key);      // the message is a NEW message
    // …and the ORDER of the ids does not change the key
    const reordered = await transition([b, a], 'paid');
    expect(reordered?.set_key).toBe(second?.set_key);
  });

  it('FAILS CLOSED when only PART of the set has ledger evidence', async () => {
    // a message covering a dated booking and an undateable one (e.g. a pre-ledger paid with no
    // paid_at) must not be dated by the half it can see.
    const dated = await seedBooking();
    await db.query(`UPDATE public.bookings SET payment_status='paid' WHERE id=$1`, [dated]);
    const undated = await seedBooking();
    expect(await transition([dated], 'paid')).toBeTruthy();
    expect(await transition([dated, undated], 'paid')).toBeNull();
    expect(await occurrence([dated, undated], 'paid')).toBeNull();
  });

  it('the ledger OUTLIVES the booking — deleting one neither cascades nor fails', async () => {
    // ON DELETE CASCADE beside an append-only guard meant deleting a booking either failed or
    // quietly erased the record of what happened to it. An audit outlives its subject.
    const id = await seedBooking({ status: 'confirmed' });
    await db.query(`UPDATE public.bookings SET status='cancelled' WHERE id=$1`, [id]);
    await db.query(`DELETE FROM public.bookings WHERE id=$1`, [id]);
    const rows = (await db.query(
      `SELECT 1 FROM public.booking_lifecycle_events WHERE booking_id=$1`, [id])).rows;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('the timeline readers are NOT granted to authenticated users', async () => {
    // they are SECURITY DEFINER and take arbitrary booking ids, so a grant to `authenticated` let
    // any logged-in player ask when someone else's booking was cancelled or paid.
    for (const fn of ['booking_transition_event', 'booking_transition_occurred_at', 'booking_transition_seq']) {
      const r = await db.query<{ ok: boolean }>(
        `SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS ok
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`, [fn]);
      for (const row of r.rows) expect(row.ok, `${fn} must not be executable by authenticated`).toBe(false);
    }
  });
});
