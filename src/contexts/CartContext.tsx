/**
 * Guest booking cart ("winkelwagen") — client-side selection state for the multi-session
 * cart flow (docs/audits/MULTI_SESSION_CART_BOOKING_AUDIT.md §6.4). Cart PR 4: state only,
 * no visible UI yet (the drawer/checkout land in cart PR 6).
 *
 * Trust model: the cart stores DISPLAY snapshots of public slots. Nothing here is
 * authoritative — create-guest-cart-payment re-reads every slot server-side and reprices;
 * the server also re-enforces every rule this file applies (single org, no split, no
 * locked cyclus sessions, N_MAX). The client rules exist purely so guests aren't led into
 * a checkout the server would refuse.
 *
 * Persistence: localStorage under a versioned key, so a Mollie round-trip / accidental
 * refresh keeps the selection. Stale (past-start) items are dropped on hydrate.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicSlot } from '@/lib/publicAvailability';

const STORAGE_KEY = 'bookingCart:v1';
/** Mirror of CART_MAX_ITEMS in supabase/functions/_shared/cart-payment.ts. */
export const CART_MAX_ITEMS = 20;

export type CartAddRefusal = 'already_in_cart' | 'not_cartable' | 'different_org' | 'cart_full';
export type CartAddResult = { ok: true } | { ok: false; reason: CartAddRefusal };

/**
 * The single-recipient-org bucket a slot pays into. All cart items must share one key so
 * the one Mollie charge routes to one org (charge-org == confirm-org). A null academy is
 * the trainer-own bucket — deliberately distinct from any academy.
 */
export function cartOrgKey(slot: Pick<PublicSlot, 'trainer_id' | 'academy_profile_id'>): string {
  return `${slot.trainer_id ?? ''}|${slot.academy_profile_id ?? ''}`;
}

/**
 * v1 cart eligibility (mirrors the server's validateCartSlots): no split-payment sessions
 * (per-seat total÷N — the cart charges full price) and no cyclus sessions unless the owner
 * enabled individual booking. Standalone whole-court slots ARE cartable (one whole-slot item).
 */
export function isCartableSlot(
  slot: Pick<PublicSlot, 'split_payment' | 'cyclus_id' | 'allow_single_booking' | 'trainer_id'>,
): boolean {
  if (!slot.trainer_id) return false;
  if (slot.split_payment) return false;
  if (slot.cyclus_id != null && !slot.allow_single_booking) return false;
  return true;
}

/** Pure add rule — returns the refusal the UI should explain, or the next item list. */
export function addSlotToItems(
  items: PublicSlot[],
  slot: PublicSlot,
): { items: PublicSlot[] } | { reason: CartAddRefusal } {
  if (items.some((i) => i.id === slot.id)) return { reason: 'already_in_cart' };
  if (!isCartableSlot(slot)) return { reason: 'not_cartable' };
  if (items.length > 0 && cartOrgKey(items[0]) !== cartOrgKey(slot)) return { reason: 'different_org' };
  if (items.length >= CART_MAX_ITEMS) return { reason: 'cart_full' };
  return { items: [...items, slot] };
}

/** Hydration guard: keep only well-formed, future items (a cart can sit in storage for days). */
export function sanitizeStoredItems(value: unknown, now = new Date()): PublicSlot[] {
  if (!Array.isArray(value)) return [];
  return value.filter((i): i is PublicSlot => {
    const item = i as Partial<PublicSlot> | null;
    return (
      !!item &&
      typeof item.id === 'string' &&
      typeof item.start_time === 'string' &&
      new Date(item.start_time).getTime() > now.getTime()
    );
  });
}

interface CartContextValue {
  items: PublicSlot[];
  count: number;
  addItem: (slot: PublicSlot) => CartAddResult;
  removeItem: (slotId: string) => void;
  /** Remove a set of ids at once — the { error, slotIds } prune path after a refused checkout. */
  removeItems: (slotIds: string[]) => void;
  clearCart: () => void;
  isInCart: (slotId: string) => boolean;
}

const CartContext = createContext<CartContextValue | null>(null);

function readStoredItems(): PublicSlot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return sanitizeStoredItems(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<PublicSlot[]>(readStoredItems);
  // Synchronous source of truth for mutations: setState updaters run lazily, so two
  // addItem calls in one tick would otherwise both validate against the pre-add list
  // (and the second would wrongly report ok).
  const itemsRef = useRef(items);

  useEffect(() => {
    try {
      if (items.length === 0) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // storage unavailable (private mode) — the cart still works for the session
    }
  }, [items]);

  const commit = useCallback((next: PublicSlot[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const addItem = useCallback(
    (slot: PublicSlot): CartAddResult => {
      const next = addSlotToItems(itemsRef.current, slot);
      if ('reason' in next) return { ok: false, reason: next.reason };
      commit(next.items);
      return { ok: true };
    },
    [commit],
  );

  const removeItem = useCallback(
    (slotId: string) => commit(itemsRef.current.filter((i) => i.id !== slotId)),
    [commit],
  );

  const removeItems = useCallback(
    (slotIds: string[]) => {
      const gone = new Set(slotIds);
      commit(itemsRef.current.filter((i) => !gone.has(i.id)));
    },
    [commit],
  );

  const clearCart = useCallback(() => commit([]), [commit]);

  const isInCart = useCallback((slotId: string) => items.some((i) => i.id === slotId), [items]);

  const value = useMemo<CartContextValue>(
    () => ({ items, count: items.length, addItem, removeItem, removeItems, clearCart, isInCart }),
    [items, addItem, removeItem, removeItems, clearCart, isInCart],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within a CartProvider');
  return ctx;
}

/**
 * Provider-optional variant for shared components that also render in cartless contexts
 * (tests, embeds): null means "no cart here" and the affordance simply doesn't render.
 */
export function useCartOptional(): CartContextValue | null {
  return useContext(CartContext);
}
