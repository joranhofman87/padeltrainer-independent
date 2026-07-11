import { normalizeSessionPrice } from "@/lib/bookingPricing";
import {
  buildCyclePlayerPaymentAmounts,
  getSelectedGuestPlayerIds,
  normalizePayerId,
} from "@/lib/cyclePayerSelection";

export type BulkCycleBookingInsert = {
  slot_id: string;
  guest_player_id: string;
  status: "confirmed";
  payment_status: string;
  payment_amount: number;
  original_amount: number;
  discount_amount: number;
  paid_at?: string;
  paid_externally?: boolean;
};

export type BuildBulkCycleBookingsInput = {
  slotIds: string[];
  selectedPlayers: string[];
  payerGuestPlayerId: string | null;
  sessionPrice: number | null | undefined;
  splitPayment: boolean;
  markAsPaid: boolean;
  /** G5 frozen split divisor: the slot's max_participants (court capacity). */
  slotCapacity?: number | null;
};

/**
 * Build booking rows for bulk cyclus creation with correct payment_amount per player.
 */
export function buildBulkCycleBookings(
  input: BuildBulkCycleBookingsInput,
): BulkCycleBookingInsert[] {
  const guestIds = getSelectedGuestPlayerIds(input.selectedPlayers);
  if (guestIds.length === 0 || input.slotIds.length === 0) {
    return [];
  }

  const sessionPrice = normalizeSessionPrice(input.sessionPrice);
  const payerId = normalizePayerId(input.selectedPlayers, input.payerGuestPlayerId);
  const amounts = buildCyclePlayerPaymentAmounts({
    selectedPlayerIds: guestIds,
    payerGuestPlayerId: payerId,
    sessionPrice,
    splitPayment: input.splitPayment,
    slotCapacity: input.slotCapacity,
  });

  const rows: BulkCycleBookingInsert[] = [];

  for (const slotId of input.slotIds) {
    for (const guestPlayerId of guestIds) {
      const paymentAmount = amounts.get(guestPlayerId) ?? 0;
      rows.push({
        slot_id: slotId,
        guest_player_id: guestPlayerId,
        status: "confirmed",
        payment_status: input.markAsPaid ? "paid" : "pending",
        payment_amount: paymentAmount,
        original_amount: sessionPrice,
        discount_amount: 0,
        ...(input.markAsPaid
          ? { paid_at: new Date().toISOString(), paid_externally: true }
          : {}),
      });
    }
  }

  return rows;
}
