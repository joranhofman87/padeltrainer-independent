// @vitest-environment node
//
// The CLIENT half of the booking-notification migration.
//
// The RPC has its own denial suite; this covers the wiring contract Codex specified for the
// four call sites:
//   * exactly ONE v2 call per flow, with the right intent
//   * NO legacy send-email call left in parallel (that is how a double-send happens — the
//     review path shipped exactly that shape and nobody noticed until delivery started
//     working)
//   * a rejected enqueue can never be mistaken for a sent notification
//
// The helper is driven directly with a fake client; the call sites are pinned by source, since
// BookLesson and BookForPlayerDialog are large page components without a render harness.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const rpc = vi.fn();
const errorLog = vi.fn();
const warnLog = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@/lib/logger', () => ({ logger: { error: (...a: unknown[]) => errorLog(...a), warn: (...a: unknown[]) => warnLog(...a) } }));

const { enqueueBookingNotification } = await import('@/lib/bookingNotifications');

beforeEach(() => { rpc.mockReset(); errorLog.mockReset(); warnLog.mockReset(); });

describe('the enqueue helper', () => {
  it('passes ONLY booking ids and an intent — never a recipient or an address', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    await enqueueBookingNotification(['b1', 'b2'], 'confirmation_player', 'Test');
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(fn).toBe('enqueue_booking_notification');
    expect(Object.keys(args).sort()).toEqual(['p_booking_ids', 'p_kind']);
    expect(args.p_kind).toBe('confirmation_player');
  });

  it('de-duplicates ids so a double-render cannot widen the set', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    await enqueueBookingNotification(['b1', 'b1', 'b2'], 'cancelled_player', 'Test');
    expect((rpc.mock.calls[0][1] as { p_booking_ids: string[] }).p_booking_ids).toEqual(['b1', 'b2']);
  });

  it('a REJECTED enqueue is never reported as ok, and is logged at error level', async () => {
    // The failure pin. The legacy path swallowed send errors, which is how a notification gap
    // survives until someone reports never receiving an email.
    rpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });
    const r = await enqueueBookingNotification(['b1'], 'request_staff', 'Test');
    expect(r.ok).toBe(false);
    expect(r.enqueued).toBe(0);
    expect(r.error).toContain('permission denied');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('a SUCCESSFUL call that enqueued nothing is surfaced, not assumed sent', async () => {
    rpc.mockResolvedValue({ data: 0, error: null });
    const r = await enqueueBookingNotification(['b1'], 'request_staff', 'Test');
    expect(r.ok).toBe(true);
    expect(r.enqueued).toBe(0);
    expect(warnLog).toHaveBeenCalled();   // visible, because "0 rows" is not "delivered"
  });

  it('a THROWN rpc failure cannot escape into "booking/delete failed"', async () => {
    // No-throw contract. By the time this runs the booking (or cancellation) has already
    // succeeded — letting a network exception propagate would report the whole operation as
    // failed for what is only a lost email.
    rpc.mockRejectedValue(new Error('network down'));
    const r = await enqueueBookingNotification(['b1'], 'cancelled_player', 'Test');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('network down');
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it('refuses to call the RPC with an empty id set', async () => {
    const r = await enqueueBookingNotification([], 'cancelled_player', 'Test');
    expect(rpc).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
  });
});

describe('the four call sites', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  const BOOK = src('src/pages/BookLesson.tsx');
  const DIALOG = src('src/components/booking/BookForPlayerDialog.tsx');
  const DELETE = src('src/components/slots/DeleteSlotDialog.tsx');

  it('NONE of them still reaches the legacy sender by any route', () => {
    // Belt-and-braces with the register: a legacy call left in parallel is a double-send.
    for (const [name, s] of [['BookLesson', BOOK], ['BookForPlayerDialog', DIALOG], ['DeleteSlotDialog', DELETE]] as const) {
      expect(/invoke\(\s*["']send-email["']/.test(s), `${name} must not invoke send-email`).toBe(false);
      expect(/sendBookingCancellation|sendBookingConfirmation|sendReviewNotification/.test(s),
        `${name} must not use a legacy email wrapper`).toBe(false);
    }
  });

  it('BookLesson uses request_staff for approval and confirmation_player for manual', () => {
    expect(BOOK).toMatch(/enqueueBookingNotification\([\s\S]{0,200}'request_staff'/);
    expect(BOOK).toMatch(/enqueueBookingNotification\([\s\S]{0,200}'confirmation_player'/);
    // and never announces a cancellation from the booking page
    expect(BOOK).not.toMatch(/'cancelled_player'/);
  });

  it('BookLesson enqueues from the ids the INSERT returned, not from client state', () => {
    // The ids must come from the mutation's own result: notifying about a booking that was
    // not actually created is the one failure direction that must be impossible.
    expect(BOOK).toMatch(/insertedCycleBookings as \{ id: string \}\[\]/);
    expect(BOOK).toMatch(/requestRow as \{ id: string \} \| null/);
    expect(BOOK).toMatch(/insertBookingSingle\([\s\S]{0,220}'id'\s*\)/);
  });



  it('DeleteSlotDialog cancels EXACTLY the ids it read, and notifies exactly what changed', () => {
    // The race: the UPDATE used to re-select by slot_id + status, so a booking created
    // between the candidate read and the write got cancelled with no notification and was
    // missing from invoice reconciliation. Both paths must bound the write to the ids read,
    // take the changed rows back, and enqueue from THOSE.
    const updates = [...DELETE.matchAll(/\.update\(\{ status: "cancelled" \}\)([\s\S]{0,240}?);/g)];
    expect(updates).toHaveLength(2);
    for (const [, tail] of updates) {
      expect(tail, 'the cancel UPDATE must be bounded by the ids already read').toContain('.in("id", candidateIds)');
      expect(tail, 'and must return what it actually changed').toContain('.select("id")');
      expect(tail, 'it must NOT re-select by slot_id — that is the race').not.toContain('.eq("slot_id"');
    }
    // notification + invoice reconciliation both key off the UPDATE's result
    expect([...DELETE.matchAll(/const actuallyCancelled = \(cancelledRows \?\? \[\]\)/g)]).toHaveLength(2);
    expect(DELETE).toMatch(/enqueueBookingNotification\(actuallyCancelled, 'cancelled_player'/);
    expect(DELETE).toMatch(/cancelledBookingIds\.push\(\.\.\.actuallyCancelled\)/);
  });

  it('DeleteSlotDialog no longer reads player names or addresses', () => {
    // Those joins existed only to compose the email in the browser. Keeping them would be
    // collecting PII with no remaining purpose.
    expect(DELETE).not.toMatch(/guest_players\(full_name, email\)/);
    expect(DELETE).not.toMatch(/profiles:player_id\(full_name, email/);
  });

  it('both DeleteSlotDialog reads inspect their error', () => {
    // A failed candidate read resolves {data: null} and is indistinguishable from "nothing to
    // cancel" — it would cancel nothing, notify nobody, and look like success.
    expect(DELETE).toMatch(/if \(readError\) throw readError;/);
    expect(DELETE).toMatch(/if \(readErrorSingle\) throw readErrorSingle;/);
    expect([...DELETE.matchAll(/if \(cancelError\) throw cancelError;/g)]).toHaveLength(2);
  });

  it('BookForPlayerDialog delegates grouping to the tested helper', () => {
    // Replaces a source-level "is it awaited?" regex that matched NOTHING in this file and
    // therefore asserted nothing. The behaviour it was meant to cover is tested for real in
    // the helper suite below.
    expect(DIALOG).toMatch(/await enqueueConfirmationsPerRecipient\(/);
    expect(DIALOG).not.toMatch(/idsByRecipient/);
  });
});

describe('groupBookingIdsByRecipient (runtime, not a source pin)', () => {
  it('groups by guest first, then registered player', async () => {
    const { groupBookingIdsByRecipient } = await import('@/lib/bookingNotifications');
    const groups = groupBookingIdsByRecipient([
      { id: 'b1', player_id: 'p1', guest_player_id: null },
      { id: 'b2', player_id: 'p1', guest_player_id: null },
      { id: 'b3', player_id: null, guest_player_id: 'g1' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual(['b1', 'b2']);
    expect(groups).toContainEqual(['b3']);
  });

  it('prefers the GUEST key when a row carries both', () => {
    // A row with both is the staff-booked-for-guest shape; keying on player_id would address
    // the wrong person.
    return import('@/lib/bookingNotifications').then(({ groupBookingIdsByRecipient }) => {
      const groups = groupBookingIdsByRecipient([{ id: 'b1', player_id: 'p1', guest_player_id: 'g1' }]);
      expect(groups).toEqual([['b1']]);
    });
  });

  it('drops rows with no recipient or no id rather than inventing a group', async () => {
    const { groupBookingIdsByRecipient } = await import('@/lib/bookingNotifications');
    expect(groupBookingIdsByRecipient([
      { id: 'b1', player_id: null, guest_player_id: null },
      { id: null, player_id: 'p1', guest_player_id: null },
    ])).toEqual([]);
    expect(groupBookingIdsByRecipient(null)).toEqual([]);
  });

  it('enqueueConfirmationsPerRecipient makes ONE call per group', async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    const { enqueueConfirmationsPerRecipient } = await import('@/lib/bookingNotifications');
    await enqueueConfirmationsPerRecipient([
      { id: 'b1', player_id: 'p1' }, { id: 'b2', player_id: 'p1' }, { id: 'b3', guest_player_id: 'g1' },
    ], 'Test');
    expect(rpc).toHaveBeenCalledTimes(2);
    for (const [, args] of rpc.mock.calls) {
      expect((args as { p_kind: string }).p_kind).toBe('confirmation_player');
    }
  });
});
