/** Public invoice pay page contact email (not bookkeeping forward list). */

export type PublicInvoiceAcademyContact = {
  invoiceReplyToEmail?: string | null;
  contactEmail?: string | null;
};

/** Prefer invoice reply-to; fall back to general academy contact. */
export function resolvePublicInvoiceContactEmail(
  academy: PublicInvoiceAcademyContact | null | undefined,
): string | null {
  if (!academy) return null;
  const replyTo = academy.invoiceReplyToEmail?.trim();
  if (replyTo) return replyTo;
  const contact = academy.contactEmail?.trim();
  return contact || null;
}
