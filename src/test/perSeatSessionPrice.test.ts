// F01 (MASTER_AUDIT) golden test: the public single-session QUOTE (perSeatSessionPrice,
// shared by PublicSlotRow, GuestBookingDialog and the cart) must equal the server CHARGE
// (computeSingleSlotPaymentAmount + sumSlotExtraCosts in
// supabase/functions/_shared/booking-pricing.ts) for every (split_payment, max_participants,
// price, extras) combination — otherwise the guest is quoted one number and charged another.
//
// Owner rule (live data confirmed there are no standalone slots; the only individually
// bookable sessions are NON-split cycle sessions): division by capacity is driven by
// split_payment ("paid individually"), NOT allow_single_booking. A non-split session is
// "paid at once" → the FULL price_per_session.
//
// The server math is re-implemented here as the reference oracle (it lives in Deno edge
// code that can't be imported into vitest). It is intentionally verbatim, so any drift in
// either the client helper or this mirror fails the parity assertion.
import { describe, it, expect } from 'vitest';
import { perSeatSessionPrice } from '@/lib/pricing';

type Slot = {
  price_per_session: number | null;
  max_participants?: number | null;
  split_payment?: boolean | null;
  extra_costs?: { price: number }[] | null;
};

// Verbatim mirror of computeSingleSlotPaymentAmount(slot, hourlyRate=null, 1) + sumSlotExtraCosts.
// (hourly-rate fallback is irrelevant: the quote sites only render a price when price_per_session > 0.)
function serverCharge(slot: Slot): number | null {
  const base = slot.price_per_session;
  if (base == null || !(base > 0)) return null;
  const maxP = slot.max_participants || 1;
  const split = slot.split_payment === true;
  const chargedBase = split && maxP > 1 ? base / maxP : base;
  const extras = Array.isArray(slot.extra_costs)
    ? slot.extra_costs.reduce((sum, ec) => {
        const p = Number(ec?.price);
        return sum + (Number.isFinite(p) && p > 0 ? p : 0);
      }, 0)
    : 0;
  return chargedBase + extras;
}

describe('perSeatSessionPrice — pinned values', () => {
  it('charges the FULL base for a non-split session, even when individually bookable (€40)', () => {
    expect(perSeatSessionPrice({ price_per_session: 40, max_participants: 4, split_payment: false })).toBe(40);
  });

  it('divides the base by capacity ONLY for a split_payment session (€40, cap 4 → €10)', () => {
    expect(perSeatSessionPrice({ price_per_session: 40, max_participants: 4, split_payment: true })).toBe(10);
  });

  it('adds positive extras on top of the (split) divided base, undivided (€40/4 + €5 → €15)', () => {
    expect(
      perSeatSessionPrice({ price_per_session: 40, max_participants: 4, split_payment: true, extra_costs: [{ price: 5 }] }),
    ).toBe(15);
  });

  it('adds extras on top of the full base for a non-split session (€40 + €5 → €45)', () => {
    expect(
      perSeatSessionPrice({ price_per_session: 40, max_participants: 4, split_payment: false, extra_costs: [{ price: 5 }] }),
    ).toBe(45);
  });

  it('does NOT divide a capacity-1 split slot (€40)', () => {
    expect(perSeatSessionPrice({ price_per_session: 40, max_participants: 1, split_payment: true })).toBe(40);
  });

  it('ignores negative extras (as the server does)', () => {
    expect(
      perSeatSessionPrice({ price_per_session: 40, max_participants: 4, split_payment: true, extra_costs: [{ price: -5 }, { price: 5 }] }),
    ).toBe(15);
  });

  it('returns null when there is no positive base price to quote', () => {
    expect(perSeatSessionPrice({ price_per_session: null })).toBeNull();
    expect(perSeatSessionPrice({ price_per_session: 0, max_participants: 4, split_payment: true })).toBeNull();
  });
});

describe('perSeatSessionPrice === server charge (quote == charge parity)', () => {
  const prices = [40, 33, 12.5, 100];
  const caps = [1, 2, 3, 4];
  const splitFlags = [true, false];
  const extrasSets: ({ price: number }[] | null)[] = [null, [], [{ price: 5 }], [{ price: 2.5 }, { price: 7.5 }], [{ price: -1 }, { price: 3 }]];

  for (const price of prices) {
    for (const cap of caps) {
      for (const split of splitFlags) {
        for (const extras of extrasSets) {
          const slot: Slot = { price_per_session: price, max_participants: cap, split_payment: split, extra_costs: extras };
          it(`quote==charge for price=${price} cap=${cap} split=${split} extras=${JSON.stringify(extras)}`, () => {
            const quote = perSeatSessionPrice(slot);
            const charge = serverCharge(slot);
            if (quote == null || charge == null) {
              expect(quote).toBe(charge);
            } else {
              expect(quote).toBeCloseTo(charge, 10);
            }
          });
        }
      }
    }
  }
});
