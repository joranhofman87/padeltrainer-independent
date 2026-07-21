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

  it('BookForPlayerDialog enqueues ONCE PER RECIPIENT, grouped from the inserted rows', () => {
    // Not once per player from selectedPlayers: the grouping has to come from what the insert
    // actually wrote, and confirmation_player accepts exactly one recipient per call.
    expect(DIALOG).toMatch(/idsByRecipient/);
    expect(DIALOG).toMatch(/for \(const row of insertedRows/);
    expect(DIALOG).toMatch(/\[\.\.\.idsByRecipient\.values\(\)\]\.map/);
  });

  it('DeleteSlotDialog sends ONE call with the complete cancelled set, after the update', () => {
    // The old code looped per booking, so a player losing a whole cycle received one mail per
    // session. And the RPC requires cancelled status, so ordering matters.
    const calls = [...DELETE.matchAll(/enqueueBookingNotification\(/g)];
    expect(calls).toHaveLength(2);           // one per delete path (cyclus + single slot)
    expect(DELETE).toMatch(/bookingsToCancel\.map\(\(bk\) => bk\.id\)/);
    expect(DELETE).not.toMatch(/for \(const booking of bookingsToCancel\)/);
    const update = DELETE.indexOf('status: "cancelled"');
    // the CALL, not the import at the top of the file — anchoring on the bare identifier
    // compared the import's position and passed for the wrong reason.
    const enqueue = DELETE.indexOf('await enqueueBookingNotification(');
    expect(update).toBeGreaterThan(-1);
    expect(enqueue, 'must enqueue AFTER the cancel update').toBeGreaterThan(update);
  });

  it('every call site awaits the enqueue', () => {
    // Fire-and-forget would put the failure outside the flow that could report it.
    for (const [name, s] of [['BookLesson', BOOK], ['BookForPlayerDialog', DIALOG], ['DeleteSlotDialog', DELETE]] as const) {
      for (const m of s.matchAll(/(\w+)\s*\n?\s*enqueueBookingNotification\(/g)) {
        expect(['await', 'map', 'values'].some((k) => m[1].includes(k)) || m[1] === 'await',
          `${name}: enqueue at "${m[1]}" should be awaited (directly or via Promise.all)`).toBe(true);
      }
    }
  });
});
