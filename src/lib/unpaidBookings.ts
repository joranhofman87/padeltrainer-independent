/** Sort unpaid booking rows by embedded slot start time (ascending). */
export function sortBookingsBySlotStartTime<T extends { availability_slots: { start_time: string } }>(
  rows: T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      new Date(a.availability_slots.start_time).getTime() -
      new Date(b.availability_slots.start_time).getTime(),
  );
}
