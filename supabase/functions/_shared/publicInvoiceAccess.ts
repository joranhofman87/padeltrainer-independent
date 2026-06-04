/** Shared access rules for get-public-invoice (imported by edge function). */

export type PublicInvoiceAccessRow = {
  status: string;
  public_token_revoked_at: string | null;
};

export type PublicInvoiceAccessDecision =
  | "draft"
  | "download"
  | "login_required"
  | "paid"
  | "cancelled"
  | "not_found"
  | "full";

/** Order matches get-public-invoice handler. */
export function decidePublicInvoiceAccess(
  invoice: PublicInvoiceAccessRow,
  options?: { action?: string },
): PublicInvoiceAccessDecision {
  if (invoice.status === "draft") return "draft";

  if (options?.action === "download") {
    if (invoice.status === "paid" || invoice.status === "cancelled") {
      return "login_required";
    }
    return "download";
  }

  if (invoice.status === "paid") return "paid";
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.public_token_revoked_at) return "not_found";
  return "full";
}
