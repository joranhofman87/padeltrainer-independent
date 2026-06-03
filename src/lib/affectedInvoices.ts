import { supabase } from "@/lib/supabaseClient";
import { logger } from "@/lib/logger";

export type InvoiceStatusBucket = "draft" | "sentOrPending" | "paid" | "cancelled" | "other";

export type AffectedInvoiceRow = {
  id: string;
  status: string;
  invoice_number?: string | null;
};

export type AffectedInvoicesClassification = {
  draftInvoiceIds: string[];
  sentOrPendingInvoiceIds: string[];
  paidInvoiceIds: string[];
  cancelledInvoiceIds: string[];
};

export type AffectedInvoicesSummary = {
  draftCount: number;
  sentOrPendingCount: number;
  paidCount: number;
  cancelledCount: number;
  requiresConfirmation: boolean;
  hasPaidUnchanged: boolean;
};

const SENT_OR_PENDING_STATUSES = new Set(["sent", "pending", "overdue"]);

/** Classify a single invoice status into update buckets. */
export function classifyInvoiceStatus(status: string): InvoiceStatusBucket {
  const normalized = (status || "").toLowerCase();
  if (normalized === "draft") return "draft";
  if (normalized === "paid") return "paid";
  if (normalized === "cancelled") return "cancelled";
  if (SENT_OR_PENDING_STATUSES.has(normalized)) return "sentOrPending";
  return "other";
}

/** Group invoice rows by update policy bucket. */
export function classifyAffectedInvoices(
  invoices: AffectedInvoiceRow[],
): AffectedInvoicesClassification {
  const result: AffectedInvoicesClassification = {
    draftInvoiceIds: [],
    sentOrPendingInvoiceIds: [],
    paidInvoiceIds: [],
    cancelledInvoiceIds: [],
  };

  for (const inv of invoices) {
    const bucket = classifyInvoiceStatus(inv.status);
    switch (bucket) {
      case "draft":
        result.draftInvoiceIds.push(inv.id);
        break;
      case "sentOrPending":
      case "other":
        result.sentOrPendingInvoiceIds.push(inv.id);
        break;
      case "paid":
        result.paidInvoiceIds.push(inv.id);
        break;
      case "cancelled":
        result.cancelledInvoiceIds.push(inv.id);
        break;
    }
  }

  return result;
}

export function buildAffectedInvoicesSummary(
  classification: AffectedInvoicesClassification,
): AffectedInvoicesSummary {
  const sentOrPendingCount =
    classification.sentOrPendingInvoiceIds.length;
  const draftCount = classification.draftInvoiceIds.length;
  const paidCount = classification.paidInvoiceIds.length;

  return {
    draftCount,
    sentOrPendingCount,
    paidCount,
    cancelledCount: classification.cancelledInvoiceIds.length,
    requiresConfirmation: sentOrPendingCount > 0,
    hasPaidUnchanged: paidCount > 0,
  };
}

async function fetchBookingIdsForSlots(slotIds: string[]): Promise<string[]> {
  if (slotIds.length === 0) return [];

  const { data, error } = await supabase
    .from("bookings")
    .select("id")
    .in("slot_id", slotIds)
    .in("status", ["confirmed", "pending"]);

  if (error) {
    logger.warn("Failed to fetch bookings for affected invoices", {
      component: "affectedInvoices",
      error: error.message,
    });
    return [];
  }

  return (data || []).map((b) => b.id);
}

async function fetchInvoicesOverlappingBookings(
  bookingIds: string[],
): Promise<AffectedInvoiceRow[]> {
  if (bookingIds.length === 0) return [];

  const { data, error } = await supabase
    .from("invoices")
    .select("id, status, invoice_number")
    .overlaps("booking_ids", bookingIds);

  if (error) {
    logger.warn("Failed to fetch affected invoices", {
      component: "affectedInvoices",
      error: error.message,
    });
    return [];
  }

  return (data || []) as AffectedInvoiceRow[];
}

/** Find invoices affected by bookings on the given slots. */
export async function fetchAffectedInvoicesBySlotIds(
  slotIds: string[],
): Promise<AffectedInvoicesClassification> {
  const bookingIds = await fetchBookingIdsForSlots(slotIds);
  return fetchAffectedInvoicesByBookingIds(bookingIds);
}

/** Find invoices that overlap any of the given booking IDs. */
export async function fetchAffectedInvoicesByBookingIds(
  bookingIds: string[],
): Promise<AffectedInvoicesClassification> {
  const rows = await fetchInvoicesOverlappingBookings(bookingIds);
  return classifyAffectedInvoices(rows);
}
