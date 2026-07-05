// Guest booking cart state (cart PR 4). The pure rules mirror the server's
// validateCartSlots (_shared/cart-payment.ts) — the server re-enforces everything;
// these rules only keep guests out of checkouts the server would refuse.
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CartProvider } from './CartContext';
import {
  CART_MAX_ITEMS,
  addSlotToItems,
  cartOrgKey,
  isCartableSlot,
  sanitizeStoredItems,
  useCart,
} from './cartStore';
import type { PublicSlot } from '@/lib/publicAvailability';

let seq = 0;
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function slot(overrides: Partial<PublicSlot> = {}): PublicSlot {
  seq += 1;
  return {
    id: `slot-${seq}`,
    start_time: FUTURE,
    end_time: FUTURE,
    cyclus_id: null,
    cyclus_name: null,
    court_type: null,
    location_name: 'Hal 1',
    trainer_id: 'trainer-1',
    academy_profile_id: 'academy-1',
    trainer_name: 'Trainer T',
    trainer_slug: null,
    price_per_session: 25,
    total_price: null,
    extra_costs: [],
    max_participants: 4,
    allow_single_booking: true,
    whole_slot_booking: false,
    spots_left: 4,
    split_payment: false,
    ...overrides,
  };
}

describe('cart rules (mirror of the server validateCartSlots)', () => {
  it('org key follows the PAYMENT RECIPIENT: academy slots share a key across trainers', () => {
    const own = slot({ academy_profile_id: null });
    const acad = slot();
    // trainer-own is its own bucket, distinct from any academy
    expect(cartOrgKey(own)).not.toBe(cartOrgKey(acad));
    expect(cartOrgKey(own)).toBe(cartOrgKey(slot({ academy_profile_id: null })));
    // two trainers of ONE academy: same recipient (the academy's Mollie) → same key
    expect(cartOrgKey(acad)).toBe(cartOrgKey(slot({ trainer_id: 'trainer-2' })));
    // trainer-own buckets are per trainer
    expect(cartOrgKey(own)).not.toBe(cartOrgKey(slot({ trainer_id: 'trainer-2', academy_profile_id: null })));
  });

  it('eligibility: split sessions and locked cyclus sessions are not cartable', () => {
    expect(isCartableSlot(slot())).toBe(true);
    expect(isCartableSlot(slot({ split_payment: true }))).toBe(false);
    expect(isCartableSlot(slot({ cyclus_id: 'cyc-1', allow_single_booking: false }))).toBe(false);
    expect(isCartableSlot(slot({ cyclus_id: 'cyc-1', allow_single_booking: true }))).toBe(true);
    // standalone whole-court slot: cartable as one whole-slot item
    expect(isCartableSlot(slot({ cyclus_id: null, allow_single_booking: false }))).toBe(true);
    expect(isCartableSlot(slot({ trainer_id: null }))).toBe(false);
  });

  it('add: dedupes, blocks a different RECIPIENT, caps at CART_MAX_ITEMS', () => {
    const a = slot();
    expect(addSlotToItems([a], a)).toEqual({ reason: 'already_in_cart' });
    // another trainer of the SAME academy: same recipient → allowed
    const sameAcademy = addSlotToItems([a], slot({ trainer_id: 'trainer-2' }));
    expect('items' in sameAcademy && sameAcademy.items).toHaveLength(2);
    // a different academy, or a trainer-own slot: different Mollie/invoicing → blocked
    expect(addSlotToItems([a], slot({ academy_profile_id: 'academy-2' }))).toEqual({ reason: 'different_org' });
    expect(addSlotToItems([a], slot({ academy_profile_id: null }))).toEqual({ reason: 'different_org' });
    const full = Array.from({ length: CART_MAX_ITEMS }, () => slot());
    expect(addSlotToItems(full, slot())).toEqual({ reason: 'cart_full' });
    const added = addSlotToItems([a], slot());
    expect('items' in added && added.items).toHaveLength(2);
  });

  it('hydration guard: drops junk and past items', () => {
    const past = slot({ start_time: new Date(Date.now() - 60_000).toISOString() });
    const ok = slot();
    expect(sanitizeStoredItems([past, ok, null, { id: 42 }, 'x'])).toEqual([ok]);
    expect(sanitizeStoredItems('garbage')).toEqual([]);
  });
});

describe('CartProvider', () => {
  beforeEach(() => localStorage.clear());

  const wrapper = ({ children }: { children: ReactNode }) => <CartProvider>{children}</CartProvider>;

  it('add/remove/clear round-trip with localStorage persistence', () => {
    const a = slot();
    const b = slot();
    const { result, unmount } = renderHook(() => useCart(), { wrapper });

    act(() => {
      expect(result.current.addItem(a)).toEqual({ ok: true });
      expect(result.current.addItem(b)).toEqual({ ok: true });
    });
    expect(result.current.count).toBe(2);
    expect(result.current.isInCart(a.id)).toBe(true);

    // a fresh provider hydrates the same cart from storage (Mollie round-trip survival)
    unmount();
    const fresh = renderHook(() => useCart(), { wrapper });
    expect(fresh.result.current.count).toBe(2);

    act(() => fresh.result.current.removeItems([a.id, b.id]));
    expect(fresh.result.current.count).toBe(0);
    expect(localStorage.getItem('bookingCart:v1')).toBeNull();
  });

  it('surfaces the add refusal so the UI can explain it', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      expect(result.current.addItem(slot())).toEqual({ ok: true });
      // a different ACADEMY = a different payment recipient → refused
      expect(result.current.addItem(slot({ academy_profile_id: 'academy-2' }))).toEqual({
        ok: false,
        reason: 'different_org',
      });
      // another trainer of the SAME academy = same recipient → allowed
      expect(result.current.addItem(slot({ trainer_id: 'trainer-2' }))).toEqual({ ok: true });
    });
    expect(result.current.count).toBe(2);
  });

  it('clearCart empties state and storage (the success-page hook)', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.addItem(slot());
    });
    act(() => result.current.clearCart());
    expect(result.current.count).toBe(0);
    expect(localStorage.getItem('bookingCart:v1')).toBeNull();
  });
});
