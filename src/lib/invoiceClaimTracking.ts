/**
 * PostHog events for paid-invoice account claim funnel.
 * No PII — no email, names, tokens, or invoice ids.
 */
import { trackEvent } from '@/lib/tracking';
import { isPaidInvoiceClaimFlow, PAID_INVOICE_CLAIM_REDIRECT } from '@/lib/signupClaimFlow';

export const INVOICE_CLAIM_EVENT_CATEGORY = 'invoice_claim';

const ANALYTICS_SESSION_PREFIX = 'invoiceClaimAnalytics_';

export type InvoiceClaimEvent =
  | 'invoice_claim_started'
  | 'invoice_claim_signup_started'
  | 'invoice_claim_onboarding_completed'
  | 'invoice_claim_landed_on_invoices'
  | 'invoice_claim_linked_invoices_found'
  | 'invoice_claim_no_invoices_found';

export type InvoiceCountBucket = '0' | '1' | '2_plus';

const BASE_PROPERTIES = {
  event_category: INVOICE_CLAIM_EVENT_CATEGORY,
  flow: 'paid_invoice',
  redirect_target: 'player_invoices',
} as const;

function sessionDedupeKey(event: InvoiceClaimEvent): string {
  return `${ANALYTICS_SESSION_PREFIX}${event}`;
}

function markEventFired(event: InvoiceClaimEvent): void {
  try {
    sessionStorage.setItem(sessionDedupeKey(event), '1');
  } catch {
    // sessionStorage may be unavailable
  }
}

function hasEventFired(event: InvoiceClaimEvent): boolean {
  try {
    return sessionStorage.getItem(sessionDedupeKey(event)) === '1';
  } catch {
    return false;
  }
}

export function bucketInvoiceCount(count: number): InvoiceCountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  return '2_plus';
}

/** Capture a claim-funnel event once per browser session (unless force). */
export function trackInvoiceClaimEvent(
  event: InvoiceClaimEvent,
  extra?: Record<string, string | number | boolean | null | undefined>,
  options?: { force?: boolean },
): void {
  if (!options?.force && hasEventFired(event)) return;

  trackEvent(event, {
    ...BASE_PROPERTIES,
    ...extra,
  });
  markEventFired(event);
}

export function trackInvoiceClaimStarted(): void {
  trackInvoiceClaimEvent('invoice_claim_started', { entry: 'paid_public_invoice' });
}

export function trackInvoiceClaimSignupStarted(hasRedirect: boolean): void {
  if (!isPaidInvoiceClaimFlow()) return;
  trackInvoiceClaimEvent('invoice_claim_signup_started', {
    entry: 'signup_page',
    has_redirect: hasRedirect,
  });
}

export function trackInvoiceClaimOnboardingCompleted(ratingSystem: string): void {
  if (!isPaidInvoiceClaimFlow()) return;
  trackInvoiceClaimEvent('invoice_claim_onboarding_completed', { rating_system: ratingSystem });
}

export function trackInvoiceClaimLandedOnInvoices(): void {
  if (!isPaidInvoiceClaimFlow()) return;
  trackInvoiceClaimEvent('invoice_claim_landed_on_invoices');
}

export function trackInvoiceClaimOutcome(invoiceCount: number): void {
  if (!isPaidInvoiceClaimFlow()) return;

  const bucket = bucketInvoiceCount(invoiceCount);
  if (invoiceCount > 0) {
    trackInvoiceClaimEvent('invoice_claim_linked_invoices_found', {
      invoice_count_bucket: bucket,
    });
  } else {
    trackInvoiceClaimEvent('invoice_claim_no_invoices_found', {
      invoice_count_bucket: bucket,
    });
  }
}

/** Whether redirect param targets the claim invoices page (safe enum for analytics). */
export function claimFlowHasInvoicesRedirect(redirect: string | null): boolean {
  return redirect === PAID_INVOICE_CLAIM_REDIRECT;
}
