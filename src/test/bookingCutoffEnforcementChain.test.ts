// @vitest-environment node
// Source pins for the booking-cutoff enforcement chain.
//
// The cutoff is enforced by adding ONE reason token to can_book_slot rather than by adding a
// second trigger, because can_book_slot already sits on every registered-player route into
// public.bookings. That is a good design only for as long as those routes keep calling it —
// so what is pinned here is the WIRING, which no behavioural test would notice being cut.
//
// These read source text on purpose. The alternative is a live Postgres + a real Mollie call,
// and a pin that says "this call site still exists" is worth more than nothing while being
// honest about what it does not prove: it does not prove the call WORKS, only that it is there.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

const migration = read('supabase', 'migrations', '20260925100000_player_booking_min_notice.sql');
const molliePayment = read('supabase', 'functions', 'create-mollie-payment', 'index.ts');
const guestSlot = read('supabase', 'functions', 'create-guest-slot-payment', 'index.ts');
const guestCyclus = read('supabase', 'functions', 'create-guest-cyclus-payment', 'index.ts');
const guestCart = read('supabase', 'functions', 'create-guest-cart-payment', 'index.ts');

describe('can_book_slot carries the cutoff', () => {
  it('returns the booking_cutoff token', () => {
    expect(migration).toMatch(/RETURN 'booking_cutoff';/);
  });

  it('checks the cutoff AFTER the tier checks, so visibility still wins', () => {
    // a hidden slot must report slot_not_released, never leak that it exists but is merely late
    const hidden = migration.indexOf("RETURN 'slot_not_released'");
    const cutoff = migration.indexOf('is_slot_within_player_booking_cutoff(_slot_id)');
    expect(hidden).toBeGreaterThan(-1);
    expect(cutoff).toBeGreaterThan(hidden);
  });

  it('takes the STRICTER of the two tenants', () => {
    expect(migration).toMatch(/SELECT greatest\(/);
    expect(migration).not.toMatch(/SELECT least\(/);
  });

  it('locks both helpers down to service_role', () => {
    // this project auto-grants EXECUTE on new functions to anon/authenticated
    for (const fn of ['get_slot_player_booking_min_notice_minutes', 'is_slot_within_player_booking_cutoff']) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(uuid\\) FROM PUBLIC, anon, authenticated;`),
      );
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(uuid\\) TO service_role;`));
    }
  });
});

describe('create-mollie-payment — the registered-player self-booking path', () => {
  it('still pre-checks can_book_slot before minting a payment', () => {
    // this is what makes the cutoff reach the online-pay route without touching this function:
    // remove the call and a player could pay for a session inside the cutoff
    expect(molliePayment).toMatch(/rpc\("can_book_slot"/);
  });

  it('gates at BOOKING CREATION, not payment completion', () => {
    // Anchored on the CALL SITES, not on any mention: `book_slot_for_payment` appears in
    // comments well above its rpc() call, and matching those made this pass for the wrong
    // reason. Neither step waits for the webhook.
    const gate = molliePayment.indexOf('rpc("can_book_slot"');
    const book = molliePayment.indexOf('rpc("book_slot_for_payment"');
    expect(gate).toBeGreaterThan(-1);
    expect(book).toBeGreaterThan(-1);
    expect(book).toBeGreaterThan(gate);
  });
});

describe('guest/public checkout — the path can_book_slot cannot reach', () => {
  const guests: Array<[string, string]> = [
    ['create-guest-slot-payment', guestSlot],
    ['create-guest-cyclus-payment', guestCyclus],
    ['create-guest-cart-payment', guestCart],
  ];

  it('every guest checkout checks the cutoff', () => {
    // book_guest_*_for_payment take no user id, so they never reach can_book_slot — an
    // unchecked guest flow is a hole straight through the rule
    for (const [name, src] of guests) {
      expect(src, `${name} must check the booking cutoff`).toMatch(/assertSlotsOutsideBookingCutoff\(/);
    }
  });

  it('refuses BEFORE the guest player or payment is created', () => {
    for (const [name, src] of guests) {
      const check = src.indexOf('assertSlotsOutsideBookingCutoff(');
      const guest = src.indexOf('resolveOrCreateGuestPlayer(supabase');
      expect(check, `${name}: cutoff check missing`).toBeGreaterThan(-1);
      expect(guest, `${name}: guest resolve missing`).toBeGreaterThan(-1);
      expect(check, `${name}: must refuse before creating anything`).toBeLessThan(guest);
    }
  });

  it('never sends a tenant id with the check — the slot decides', () => {
    for (const [name, src] of guests) {
      const call = src.slice(src.indexOf('assertSlotsOutsideBookingCutoff('), src.indexOf('assertSlotsOutsideBookingCutoff(') + 260);
      expect(call, `${name} must not pass a tenant`).not.toMatch(/academyProfileId|trainerId/);
    }
  });
});
