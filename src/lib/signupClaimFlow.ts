/** Paid-invoice claim signup flow (frontend only). */

export const SIGNUP_SOURCE_PAID_INVOICE = 'paid_invoice';
export const SIGNUP_CLAIM_SOURCE_STORAGE_KEY = 'signupClaimSource';
export const SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY = 'redirectAfterOnboarding';
export const PAID_INVOICE_CLAIM_REDIRECT = '/app/player/invoices';
export const PAID_INVOICE_CLAIM_TOAST_SESSION_KEY = 'paidInvoiceClaimToastShown';

const PLAYER_SIGNUP_PATH = '/app/signup/player';

/** Build player signup URL for post-payment claim flow. */
export function buildPaidInvoiceClaimSignupPath(): string {
  const params = new URLSearchParams({
    source: SIGNUP_SOURCE_PAID_INVOICE,
    redirect: PAID_INVOICE_CLAIM_REDIRECT,
  });
  return `${PLAYER_SIGNUP_PATH}?${params.toString()}`;
}

export type SignupQueryParams = {
  source: string | null;
  redirect: string | null;
};

export function parseSignupQueryParams(searchParams: URLSearchParams): SignupQueryParams {
  return {
    source: searchParams.get('source'),
    redirect: searchParams.get('redirect'),
  };
}

/** Only allow same-origin app paths; blocks open redirects. */
export function sanitizeAppRedirect(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const value = raw.trim();
  if (!value.startsWith('/app/')) return null;
  if (value.includes('://') || value.startsWith('//')) return null;
  return value;
}

export function buildSignupRolePath(
  base: string,
  options?: { redirect?: string | null; source?: string | null },
): string {
  const params = new URLSearchParams();
  const redirect = sanitizeAppRedirect(options?.redirect ?? null);
  const source = options?.source?.trim() || null;

  if (source) params.set('source', source);
  if (redirect) params.set('redirect', redirect);

  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** Persist claim context from URL into localStorage for signup → onboarding → invoices. */
export function persistSignupClaimFromSearchParams(searchParams: URLSearchParams): void {
  const { source, redirect } = parseSignupQueryParams(searchParams);

  if (source === SIGNUP_SOURCE_PAID_INVOICE) {
    localStorage.setItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY, SIGNUP_SOURCE_PAID_INVOICE);
  }

  const safeRedirect = sanitizeAppRedirect(redirect);
  if (safeRedirect) {
    localStorage.setItem(SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY, safeRedirect);
  }
}

export function getSignupClaimSource(): string | null {
  return localStorage.getItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY);
}

export function isPaidInvoiceClaimFlow(): boolean {
  return getSignupClaimSource() === SIGNUP_SOURCE_PAID_INVOICE;
}

export function clearSignupClaimSource(): void {
  localStorage.removeItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY);
}

export function markPaidInvoiceClaimToastShown(): void {
  sessionStorage.setItem(PAID_INVOICE_CLAIM_TOAST_SESSION_KEY, '1');
}

export function shouldShowPaidInvoiceClaimToast(): boolean {
  if (!isPaidInvoiceClaimFlow()) return false;
  return sessionStorage.getItem(PAID_INVOICE_CLAIM_TOAST_SESSION_KEY) !== '1';
}

export function consumePaidInvoiceClaimRedirect(): string | null {
  const raw = localStorage.getItem(SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY);
  return sanitizeAppRedirect(raw);
}
