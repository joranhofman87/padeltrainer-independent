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
});
