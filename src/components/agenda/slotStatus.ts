// Canonical slot-status logic + class maps for the agenda slot cards.
//
// Extracted from CalendarSlotCard and DayViewSlotCard, which each carried a
// byte-identical copy of `SlotStatus` / `getSlotStatus` / `statusTextColors`
// and a near-identical `statusColors` map. The two card-class variants are
// preserved here EXACTLY as they were rendered per card (see
// `slotStatusCardClasses` below) — do not unify them without checking the
// rendered output of both cards.

import type { SlotWithBookings } from "@/lib/slotTypes";

export type SlotStatus = "free" | "partial" | "full" | "past" | "private";

export function getSlotStatus(slot: SlotWithBookings): SlotStatus {
  if (slot.is_past) return "past";
  if (!slot.is_public) return "private";
  if (slot.active_bookings >= 4) return "full";
  if (slot.active_bookings > 0) return "partial";
  return "free";
}

// Variant used by CalendarSlotCard (clickable month/week cells): has hover:*
// classes, and `past` dims with opacity-50.
const interactiveCardClasses: Record<SlotStatus, string> = {
  free: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-900/50",
  partial: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 hover:bg-orange-200 dark:hover:bg-orange-900/50",
  full: "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 hover:bg-blue-200 dark:hover:bg-blue-900/50",
  past: "bg-muted/30 border-muted opacity-50",
  private: "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700 hover:bg-purple-200 dark:hover:bg-purple-900/50",
};

// Variant used by DayViewSlotCard (static container): no hover classes, and
// `past` dims with opacity-60.
//
// NOTE: the opacity-50 (calendar) vs opacity-60 (day view) difference looks
// like accidental drift between the original copies. It is preserved verbatim
// so both cards render byte-identically to before the extraction; unifying the
// two values is a product/design call.
const staticCardClasses: Record<SlotStatus, string> = {
  free: "bg-green-100 dark:bg-green-900/30 border-green-300 dark:border-green-700",
  partial: "bg-orange-100 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700",
  full: "bg-blue-100 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700",
  past: "bg-muted/30 border-muted opacity-60",
  private: "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700",
};

export interface SlotStatusCardClassOptions {
  /** Interactive cards get hover:* classes and the opacity-50 past style. */
  interactive?: boolean;
}

/** Container (background/border) classes for a slot card in the given status. */
export function slotStatusCardClasses(
  status: SlotStatus,
  options?: SlotStatusCardClassOptions,
): string {
  return options?.interactive ? interactiveCardClasses[status] : staticCardClasses[status];
}

const textClasses: Record<SlotStatus, string> = {
  free: "text-green-700 dark:text-green-300",
  partial: "text-orange-700 dark:text-orange-300",
  full: "text-blue-700 dark:text-blue-300",
  past: "text-muted-foreground",
  private: "text-purple-700 dark:text-purple-300",
};

/** Text-color classes for a slot card in the given status (same in both cards). */
export function slotStatusTextClasses(status: SlotStatus): string {
  return textClasses[status];
}
