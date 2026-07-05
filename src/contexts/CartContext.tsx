/**
 * Guest booking cart ("winkelwagen") — the provider component ONLY. All rules, pricing
 * helpers, the context object and the useCart/useCartOptional hooks live in
 * ./cartStore.ts (this file must export nothing but components —
 * react-refresh/only-export-components is a zero-tolerance gate for new files).
 *
 * Persistence: localStorage under a versioned key, so a Mollie round-trip / accidental
 * refresh keeps the selection. Stale (past-start) items are dropped on hydrate.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  addSlotToItems,
  CartContext,
  sanitizeStoredItems,
  type CartAddResult,
  type CartContextValue,
} from '@/contexts/cartStore';
import type { PublicSlot } from '@/lib/publicAvailability';

const STORAGE_KEY = 'bookingCart:v1';

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
