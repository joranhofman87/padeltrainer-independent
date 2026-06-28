import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '..', 'pages/BookLesson.tsx'), 'utf8');

/**
 * Regression guard for the public online booking double-insert
 * (Codex foundation-verification Finding 1).
 *
 * Two safe shapes for a `create-mollie-payment` call from this page:
 *   - REUSE: it passes `bookingIds` for bookings the page already inserted
 *     (the cycle branch), so the edge function reuses them; or
 *   - EDGE-OWNED: it passes NO `bookingIds`, and the page does NOT insert a
 *     booking first — the capacity-locked edge function (book_slot_for_payment)
 *     creates exactly one booking (the single-slot online branch, Option A).
 *
 * The bug was the unsafe third shape: the page inserted a booking AND called the
 * edge function without `bookingIds`, so a SECOND booking was minted. This test
 * fails on that shape.
 */
describe('BookLesson — online booking creation has a single owner (no double-insert)', () => {
  it('no create-mollie-payment call both omits bookingIds and follows a page-side booking insert', () => {
    const marker = 'create-mollie-payment';
    let from = 0;
    let count = 0;
    for (;;) {
      const at = source.indexOf(marker, from);
      if (at === -1) break;
      count++;
      from = at + marker.length;
      const callBody = source.slice(at, at + 320); // the invoke body follows immediately
      if (callBody.includes('bookingIds')) continue; // REUSE shape — safe
      // EDGE-OWNED shape: the immediately-preceding code must not insert a booking
      const preceding = source.slice(Math.max(0, at - 500), at);
      expect(preceding).not.toMatch(/from\(\s*['"]bookings['"]\s*\)\s*\.insert/);
    }
    expect(count).toBeGreaterThan(0);
  });

  /**
   * A2 (Codex foundation-verification): the online-cycle payment must charge
   * EXACTLY the bookings it just inserted — captured from the insert's
   * `.select('id')` result — not a re-query by status that could fold a prior
   * abandoned-checkout pending row into the payment.
   */
  it('cycle online payment charges the just-inserted ids, not a status re-query', () => {
    // captures the insert result and reuses it for the payment
    expect(source).toMatch(/insertedCycleBookings/);
    expect(source).toMatch(/\.insert\(bookings\)\.select\(\s*['"]id['"]\s*\)/);
    // the removed bug: a re-read of pending bookings ordered by created_at
    expect(source).not.toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]pending['"]\s*\)\s*\.order\(\s*['"]created_at['"]/);
  });

  /**
   * A3 (Codex foundation-verification): the online-cycle payment goes through
   * initiateCyclePayment, which soft-cancels the just-inserted bookings if
   * payment creation fails — so a failed checkout leaves no orphan pending
   * bookings occupying capacity. The page must not hand-roll the invoke.
   */
  it('cycle online payment is owned by initiateCyclePayment (rollback-on-failure)', () => {
    expect(source).toMatch(/initiateCyclePayment\(/);
  });
});
