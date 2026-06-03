/** Slot fields used to resolve invoice source from linked bookings. */
export type InvoiceSourceSlot = {
  id: string;
  cyclus_id: string | null;
  cyclus_name: string | null;
  start_time: string;
  end_time?: string | null;
};

export type InvoiceSourceBookingRow = {
  id: string;
  slot_id: string;
  availability_slots: InvoiceSourceSlot | InvoiceSourceSlot[] | null;
};

export type InvoiceSourceResolved =
  | { kind: 'none' }
  | { kind: 'cycle'; cyclusId: string; label: string }
  | { kind: 'session'; slotId: string; startTime: string; label: string }
  | { kind: 'multiple'; sessionCount: number };

export const TRAINING_CYCLE_FALLBACK_LABEL = 'Training cycle';

function normalizeSlot(
  raw: InvoiceSourceBookingRow['availability_slots'],
): InvoiceSourceSlot | null {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw;
}

function slotsFromBookings(bookings: InvoiceSourceBookingRow[]): InvoiceSourceSlot[] {
  const slots: InvoiceSourceSlot[] = [];
  for (const booking of bookings) {
    const slot = normalizeSlot(booking.availability_slots);
    if (slot?.id) slots.push(slot);
  }
  return slots;
}

/**
 * Resolves read-only invoice source from booking → slot data.
 * Priority: shared cyclus → single session → multiple sessions.
 */
export function resolveInvoiceSourceFromBookings(
  bookings: InvoiceSourceBookingRow[],
): InvoiceSourceResolved {
  if (!bookings.length) return { kind: 'none' };

  const slots = slotsFromBookings(bookings);
  if (!slots.length) return { kind: 'none' };

  const cyclusIds = new Set(
    slots.map((s) => s.cyclus_id).filter((id): id is string => !!id),
  );

  if (cyclusIds.size === 1) {
    const cyclusId = [...cyclusIds][0]!;
    const label =
      slots.find((s) => s.cyclus_name?.trim())?.cyclus_name?.trim() ||
      TRAINING_CYCLE_FALLBACK_LABEL;
    return { kind: 'cycle', cyclusId, label };
  }

  const slotIds = new Set(slots.map((s) => s.id));
  if (slotIds.size === 1) {
    const slot = slots[0]!;
    const label = slot.cyclus_name?.trim() || TRAINING_CYCLE_FALLBACK_LABEL;
    return {
      kind: 'session',
      slotId: slot.id,
      startTime: slot.start_time,
      label,
    };
  }

  return { kind: 'multiple', sessionCount: slotIds.size };
}
