import { describe, expect, it } from 'vitest';
import { sanitizeAnalyticsPagePath } from './analyticsPagePath';

describe('sanitizeAnalyticsPagePath', () => {
  it('redacts public pay token paths', () => {
    expect(sanitizeAnalyticsPagePath('/pay/secret-token-abc', '?foo=1')).toBe('/pay/:token');
  });

  it('redacts academy branded pay paths', () => {
    expect(sanitizeAnalyticsPagePath('/academies/my-academy/pay/secret-token')).toBe(
      '/academies/my-academy/pay/:token',
    );
  });

  it('keeps normal app paths with search', () => {
    expect(sanitizeAnalyticsPagePath('/app/signup/player', '?source=paid_invoice')).toBe(
      '/app/signup/player?source=paid_invoice',
    );
  });
});
