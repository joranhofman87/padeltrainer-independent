/**
 * Guest booking cart ("winkelwagen") — the non-component half of the cart: pure rules,
 * pricing display helpers, the context object and its hooks. Split out of
 * CartContext.tsx so that file exports ONLY the provider component
 * (react-refresh/only-export-components is a zero-tolerance gate for new files).
 *
 * Trust model: everything here is DISPLAY/UX-side. create-guest-cart-payment re-reads
 * every slot server-side and reprices; the server re-enforces every rule this module
 * applies (single org, no split, no locked cyclus sessions, N_MAX). These rules exist
 * purely so guests aren't led into a checkout the server would refuse.
 */
import { createContext, useContext } from 'react';
import type { PublicSlot } from '@/lib/publicAvailability';
import { perSeatSessionPrice } from '@/lib/pricing';

/** Mirror of CART_MAX_ITEMS in supabase/functions/_shared/cart-payment.ts. */
export const CART_MAX_ITEMS = 20;

export type CartAddRefusal = 'already_in_cart' | 'not_cartable' | 'different_org' | 'cart_full';
export type CartAddResult = { ok: true } | { ok: false; reason: CartAddRefusal };

/**
 * The PAYMENT RECIPIENT bucket a slot pays into — mirrors resolveSlotRecipient's routing:
 * an academy-stamped slot is charged to the ACADEMY's Mollie account (whichever of its
 * trainers gives the session), a slot without an academy to the trainer's own account.
 * All cart items must share one key so the one Mollie charge routes to one org
 * (charge-org == confirm-org). Different trainers within ONE academy may therefore mix;
 * unrelated trainers/academies (different Mollie/invoicing) may not.
 */
export function cartOrgKey(slot: Pick<PublicSlot, 'trainer_id' | 'academy_profile_id'>): string {
  return slot.academy_profile_id ? `academy:${slot.academy_profile_id}` : `trainer:${slot.trainer_id ?? ''}`;
}

/**
 * v1 cart eligibility (mirrors the server's validateCartSlots): no split-payment sessions
 * (per-seat total÷N — the cart charges full price) and no cyclus sessions unless the owner
 * enabled individual booking. Standalone whole-court slots ARE cartable (one whole-slot item).
 */
export function isCartableSlot(
  slot: Pick<PublicSlot, 'split_payment' | 'cyclus_id' | 'allow_single_booking' | 'whole_slot_booking' | 'trainer_id'>,
): boolean {
  if (!slot.trainer_id) return false;
  if (slot.split_payment) return false; // split stays first — the whole-slot unlock never touches per-seat split sessions
  if (slot.cyclus_id != null && !slot.allow_single_booking && !slot.whole_slot_booking) return false;
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

/**
 * Indicative per-item price — the SAME helper the slot row and booking dialog display
 * (perSeatSessionPrice: the per-seat share + extras), so the cart never shows a different
 * number than the page the guest just tapped, and none of them diverge from the server
 * charge. The server reprices authoritatively at checkout.
 */
export function cartItemIndicativePrice(item: PublicSlot): number | null {
  return perSeatSessionPrice(item);
}

/** Indicative cart total (null-priced items count as 0 — the server total decides). */
export function cartIndicativeTotal(items: PublicSlot[]): number {
  return items.reduce((sum, i) => sum + (cartItemIndicativePrice(i) ?? 0), 0);
}

export interface CartContextValue {
  items: PublicSlot[];
  count: number;
  addItem: (slot: PublicSlot) => CartAddResult;
  removeItem: (slotId: string) => void;
  /** Remove a set of ids at once — the { error, slotIds } prune path after a refused checkout. */
  removeItems: (slotIds: string[]) => void;
  clearCart: () => void;
  isInCart: (slotId: string) => boolean;
}

export const CartContext = createContext<CartContextValue | null>(null);

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
