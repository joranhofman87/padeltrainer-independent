export type CyclusGroupPaymentStatus = "no_players" | "all_paid" | "has_unpaid";

export type PaidFilterValue = "all" | "paid" | "unpaid" | "no_players";

export interface BookingPaymentFields {
  status: string;
  payment_status: string | null;
  paid_externally?: boolean | null;
}

const ACTIVE_STATUSES = new Set(["confirmed", "pending"]);

export function isActiveBooking(booking: Pick<BookingPaymentFields, "status">): boolean {
  return ACTIVE_STATUSES.has(booking.status);
}

export function isPaidBooking(booking: BookingPaymentFields): boolean {
  return booking.payment_status === "paid" || booking.paid_externally === true;
}

/**
 * Aggregate payment status for a cyclus group from its slot bookings.
 * Only active bookings (confirmed/pending) are considered; cancelled are ignored.
 */
export function computeCyclusGroupPaymentStatus(
  bookings: BookingPaymentFields[],
): CyclusGroupPaymentStatus {
  const active = bookings.filter(isActiveBooking);
  if (active.length === 0) return "no_players";
  if (active.every(isPaidBooking)) return "all_paid";
  return "has_unpaid";
}

export function matchesPaidFilter(
  status: CyclusGroupPaymentStatus,
  filter: PaidFilterValue,
): boolean {
  if (filter === "all") return true;
  if (filter === "paid") return status === "all_paid";
  if (filter === "unpaid") return status === "has_unpaid";
  if (filter === "no_players") return status === "no_players";
  return true;
}

export type PaymentStatusBadgeVariant = "default" | "secondary" | "outline" | "destructive";

export function paymentStatusBadgeVariant(
  status: CyclusGroupPaymentStatus,
): PaymentStatusBadgeVariant {
  switch (status) {
    case "all_paid":
      return "default";
    case "has_unpaid":
      return "destructive";
    case "no_players":
    default:
      return "outline";
  }
}
