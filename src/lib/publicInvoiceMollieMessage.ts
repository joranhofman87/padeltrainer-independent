/** User-facing copy when online invoice payment is unavailable. */
export type PublicInvoicePaymentRecipient = 'academy' | 'trainer' | null;

export function getOnlinePaymentUnavailableMessageKey(
  recipient: PublicInvoicePaymentRecipient,
): 'invoice.onlinePaymentUnavailableAcademy' | 'invoice.onlinePaymentUnavailableTrainer' {
  return recipient === 'trainer'
    ? 'invoice.onlinePaymentUnavailableTrainer'
    : 'invoice.onlinePaymentUnavailableAcademy';
}
