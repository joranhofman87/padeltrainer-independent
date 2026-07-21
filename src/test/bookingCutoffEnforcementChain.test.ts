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

  it('has NO edge pre-check — the mutation boundary is the only enforcement point', () => {
    // The pre-check was removed, not relocated. It sat above the live-hold reuse branch, so a
    // guest who began checkout outside the cutoff was refused their own hold on returning from
    // Mollie. Any replacement would need its own notion of "live hold", which is exactly the
    // duplication that caused the bug — so the RPC guard decides, and the token mapping below
    // is what keeps the refusal clean.
    for (const [name, src] of guests) {
      expect(src, `${name} must not re-introduce an edge pre-check`)
        .not.toMatch(/assertSlotsOutsideBookingCutoff/);
    }
  });
});

describe('a booking_cutoff raised by the RPC reaches the guest as a refusal', () => {
  // The guard can still fire AFTER the pre-check: a race across the mutation boundary, or the
  // pre-check degrading open while the RPC is briefly absent. Unmapped, the guest sees a generic
  // failure for a rule we have clear copy for — the mapping is what makes the boundary usable.
  it('slot and cyclus map the token to a 400 with the booking-closed message', () => {
    for (const [name, src] of [
      ['create-guest-slot-payment', guestSlot],
      ['create-guest-cyclus-payment', guestCyclus],
    ] as const) {
      expect(src, `${name} must map booking_cutoff`).toMatch(/includes\("booking_cutoff"\)/);
      const at = src.indexOf('includes("booking_cutoff")');
      expect(src.slice(at, at + 320), `${name} must answer 400`).toMatch(/error: "booking_cutoff"[\s\S]*?\}, 400\)/);
    }
  });

  it('the cart maps it through the shared refusal vocabulary', () => {
    const cart = read('supabase', 'functions', '_shared', 'cart-payment.ts');
    expect(cart).toMatch(/"booking_cutoff",/);
  });

  it('maps EVERY refusal token each guest RPC can raise', () => {
    // The audit Codex asked for. An unmapped mutation-boundary token becomes a generic 500 on
    // the concurrent-change path — a clean refusal exists for each of these, so use it.
    const migration = read('supabase', 'migrations', '20260925100000_player_booking_min_notice.sql');
    const tokensOf = (fnName: string): string[] => {
      const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${fnName}(`);
      const end = migration.indexOf('\n$$;', start);
      const body = migration.slice(start, end);
      return [...new Set([...body.matchAll(/RAISE EXCEPTION '([a-z_]+)'/g)].map((m) => m[1]))];
    };

    for (const [fnName, src, label] of [
      ['book_guest_slot_for_payment', guestSlot, 'create-guest-slot-payment'],
      ['book_guest_cyclus_for_payment', guestCyclus, 'create-guest-cyclus-payment'],
    ] as const) {
      const tokens = tokensOf(fnName);
      expect(tokens.length, `${fnName}: no tokens found — parser drifted`).toBeGreaterThan(2);
      for (const token of tokens) {
        expect(src, `${label} must map ${token} rather than 500`).toContain(`includes("${token}")`);
      }
    }

    // the cart routes every token through the shared vocabulary instead of inline branches
    const cart = read('supabase', 'functions', '_shared', 'cart-payment.ts');
    for (const token of tokensOf('book_guest_cart_for_payment')) {
      expect(cart, `mapCartRpcError must know ${token}`).toContain(`"${token}"`);
    }
  });
});
