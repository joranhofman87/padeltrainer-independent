import { describe, expect, it, beforeEach } from 'vitest';
import { mockSignupLocalStorage } from '@/test/signupPageFreeze';
import {
  buildPaidInvoiceClaimSignupPath,
  buildSignupRolePath,
  persistSignupClaimFromSearchParams,
  sanitizeAppRedirect,
  SIGNUP_CLAIM_SOURCE_STORAGE_KEY,
  SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY,
  SIGNUP_SOURCE_PAID_INVOICE,
} from './signupClaimFlow';

describe('sanitizeAppRedirect', () => {
  it('allows internal app paths', () => {
    expect(sanitizeAppRedirect('/app/player/invoices')).toBe('/app/player/invoices');
  });

  it('rejects external URLs', () => {
    expect(sanitizeAppRedirect('https://evil.com')).toBeNull();
    expect(sanitizeAppRedirect('//evil.com')).toBeNull();
  });
});

describe('buildPaidInvoiceClaimSignupPath', () => {
  it('includes source and redirect', () => {
    expect(buildPaidInvoiceClaimSignupPath()).toBe(
      '/app/signup/player?source=paid_invoice&redirect=%2Fapp%2Fplayer%2Finvoices',
    );
  });
});

describe('buildSignupRolePath', () => {
  it('preserves source and redirect', () => {
    expect(
      buildSignupRolePath('/app/signup/trainer', {
        source: SIGNUP_SOURCE_PAID_INVOICE,
        redirect: '/app/player/invoices',
      }),
    ).toBe('/app/signup/trainer?source=paid_invoice&redirect=%2Fapp%2Fplayer%2Finvoices');
  });

  it('omits non-app redirects', () => {
    expect(buildSignupRolePath('/app/signup/player', { redirect: '/invite/abc' })).toBe(
      '/app/signup/player',
    );
  });
});

describe('persistSignupClaimFromSearchParams', () => {
  beforeEach(() => {
    mockSignupLocalStorage();
    localStorage.clear();
  });

  it('stores claim source and safe redirect', () => {
    persistSignupClaimFromSearchParams(
      new URLSearchParams('source=paid_invoice&redirect=%2Fapp%2Fplayer%2Finvoices'),
    );
    expect(localStorage.getItem(SIGNUP_CLAIM_SOURCE_STORAGE_KEY)).toBe(SIGNUP_SOURCE_PAID_INVOICE);
    expect(localStorage.getItem(SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY)).toBe('/app/player/invoices');
  });

  it('does not store unsafe redirect', () => {
    persistSignupClaimFromSearchParams(
      new URLSearchParams('source=paid_invoice&redirect=https%3A%2F%2Fevil.com'),
    );
    expect(localStorage.getItem(SIGNUP_REDIRECT_AFTER_ONBOARDING_KEY)).toBeNull();
  });
});
