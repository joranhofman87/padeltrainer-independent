/** Pure helpers for routing mollie-webhook payment metadata. */

export type MolliePaymentMetadata = {
  invoice_id?: string;
  booking_id?: string;
  booking_ids?: string[];
};

export function parseMolliePaymentMetadata(
  metadata: MolliePaymentMetadata | null | undefined,
): { invoiceId: string | null; bookingIds: string[] } {
  const bookingIds: string[] = metadata?.booking_ids?.length
    ? metadata.booking_ids
    : metadata?.booking_id
      ? [metadata.booking_id]
      : [];
  const invoiceId =
    typeof metadata?.invoice_id === "string" && metadata.invoice_id.length > 0
      ? metadata.invoice_id
      : null;
  return { invoiceId, bookingIds };
}

/** invoice_id payments use the invoice paid branch even when booking_ids are also present. */
export function usesInvoicePaidBranch(invoiceId: string | null): boolean {
  return invoiceId !== null;
}

export function hasNoRoutableMetadata(invoiceId: string | null, bookingIds: string[]): boolean {
  return bookingIds.length === 0 && !invoiceId;
}
