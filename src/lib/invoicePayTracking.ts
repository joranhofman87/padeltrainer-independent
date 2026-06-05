/**
 * PostHog events for public invoice pay page (/pay/:token).
 * No PII — no email, names, tokens, invoice ids, numbers, or amounts.
 */
import { trackEvent } from '@/lib/tracking';
import type { PublicInvoicePaymentRecipient } from '@/lib/publicInvoiceMollieMessage';

export const INVOICE_PAY_EVENT_CATEGORY = 'invoice_pay';

export type InvoicePayRecipientType = 'academy' | 'trainer' | 'unknown';
export type InvoicePayStatus = 'sent' | 'paid' | 'cancelled' | 'draft' | 'unknown';

const BASE_PROPERTIES = {
  event_category: INVOICE_PAY_EVENT_CATEGORY,
} as const;

export function normalizeInvoicePayRecipientType(
  recipient: PublicInvoicePaymentRecipient | null | undefined,
): InvoicePayRecipientType {
  if (recipient === 'academy') return 'academy';
  if (recipient === 'trainer') return 'trainer';
  return 'unknown';
}

export function normalizeInvoicePayStatus(status: string | null | undefined): InvoicePayStatus {
  if (status === 'sent' || status === 'paid' || status === 'cancelled' || status === 'draft') {
    return status;
  }
  return 'unknown';
}

export function trackInvoicePayPageLoaded(props: {
  has_mollie_account: boolean;
  payment_unavailable_reason?: string | null;
  recipient_type: InvoicePayRecipientType;
  status: InvoicePayStatus;
}): void {
  trackEvent('invoice_pay_page_loaded', {
    ...BASE_PROPERTIES,
    has_mollie_account: props.has_mollie_account,
    payment_unavailable_reason: props.payment_unavailable_reason ?? null,
    recipient_type: props.recipient_type,
    status: props.status,
  });
}

export function trackInvoicePayPageLoadFailed(errorCode: string): void {
  trackEvent('invoice_pay_page_load_failed', {
    ...BASE_PROPERTIES,
    error_code: errorCode,
  });
}

export function trackInvoicePaymentStarted(props: {
  has_mollie_account: boolean;
  payment_unavailable_reason?: string | null;
  recipient_type: InvoicePayRecipientType;
  status: InvoicePayStatus;
}): void {
  trackEvent('invoice_payment_started', {
    ...BASE_PROPERTIES,
    has_mollie_account: props.has_mollie_account,
    payment_unavailable_reason: props.payment_unavailable_reason ?? null,
    recipient_type: props.recipient_type,
    status: props.status,
  });
}

export function trackInvoicePaymentRedirect(props: {
  recipient_type: InvoicePayRecipientType;
  status: InvoicePayStatus;
}): void {
  trackEvent('invoice_payment_redirect', {
    ...BASE_PROPERTIES,
    recipient_type: props.recipient_type,
    status: props.status,
  });
}

export function trackInvoicePaymentFailed(errorCode: string): void {
  trackEvent('invoice_payment_failed', {
    ...BASE_PROPERTIES,
    error_code: errorCode,
  });
}
