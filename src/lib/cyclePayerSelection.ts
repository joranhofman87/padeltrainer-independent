import { calculateSlotBookingPricing, normalizeSessionPrice } from "@/lib/bookingPricing";

/** Selected guest player IDs in slot order (may include empty strings). */
export function getSelectedGuestPlayerIds(selectedPlayers: string[]): string[] {
  return selectedPlayers.filter(Boolean);
}

export function getDefaultPayerId(selectedPlayerIds: string[]): string | null {
  return selectedPlayerIds[0] ?? null;
}

/**
 * Keep payer valid when selection changes; default to first selected player.
 */
export function normalizePayerId(
  selectedPlayers: string[],
  currentPayerId: string | null | undefined,
): string | null {
  const selected = getSelectedGuestPlayerIds(selectedPlayers);
  if (selected.length <= 1) {
    return selected[0] ?? null;
  }
  if (currentPayerId && selected.includes(currentPayerId)) {
    return currentPayerId;
  }
  return selected[0];
}

export function shouldShowPayerSelector(
  splitPayment: boolean,
  selectedPlayerIds: string[],
): boolean {
  return !splitPayment && selectedPlayerIds.length > 1;
}

export type BuildCyclePaymentAmountsInput = {
  selectedPlayerIds: string[];
  payerGuestPlayerId: string | null;
  sessionPrice: number | null | undefined;
  splitPayment: boolean;
  /** G5 frozen split divisor: the slot's max_participants. See {@link calculateSlotBookingPricing}. */
  slotCapacity?: number | null;
};

/**
 * Per-guest payment_amount for new cycle/slot bookings (one session price per slot).
 * Non-split: full price on payer only; split: equal shares across selected players.
 */
export function buildCyclePlayerPaymentAmounts(
  input: BuildCyclePaymentAmountsInput,
): Map<string, number> {
  const selected = [...input.selectedPlayerIds];
  const sessionPrice = normalizeSessionPrice(input.sessionPrice);
  const result = new Map<string, number>();

  if (selected.length === 0) {
    return result;
  }

  if (input.splitPayment) {
    const pricing = calculateSlotBookingPricing({
      sessionPrice,
      splitPayment: true,
      existingActiveBookingCount: 0,
      newPlayerCount: selected.length,
      slotCapacity: input.slotCapacity,
    });
    selected.forEach((id, index) => {
      result.set(id, pricing.newPlayerAmounts[index] ?? 0);
    });
    return result;
  }

  const payerId =
    input.payerGuestPlayerId && selected.includes(input.payerGuestPlayerId)
      ? input.payerGuestPlayerId
      : getDefaultPayerId(selected);

  if (!payerId) {
    return result;
  }

  for (const id of selected) {
    result.set(id, id === payerId ? sessionPrice : 0);
  }
  return result;
}

export type BookingWithPayment = {
  id: string;
  guest_player_id?: string | null;
  payment_amount?: number | null;
};

/** Booking IDs eligible for auto-create-invoice (payment_amount > 0). */
export function getChargeableBookingIds(bookings: BookingWithPayment[]): string[] {
  return bookings
    .filter((b) => (b.payment_amount ?? 0) > 0)
    .map((b) => b.id);
}

/** Group chargeable bookings by guest for per-player invoices (split payment). */
export function groupChargeableBookingsByGuest(
  bookings: BookingWithPayment[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const booking of bookings) {
    const guestId = booking.guest_player_id;
    if (!guestId || (booking.payment_amount ?? 0) <= 0) continue;
    const existing = map.get(guestId) ?? [];
    existing.push(booking.id);
    map.set(guestId, existing);
  }
  return map;
}
