import { describe, expect, it } from 'vitest';
import { sanitizeAnalyticsPagePath, isSensitiveAnalyticsPath } from './analyticsPagePath';

describe('sanitizeAnalyticsPagePath', () => {
  it('redacts public pay token paths', () => {
    expect(sanitizeAnalyticsPagePath('/pay/secret-token-abc', '?foo=1')).toBe('/pay/:token');
  });

  it('redacts academy branded pay paths', () => {
    expect(sanitizeAnalyticsPagePath('/academies/my-academy/pay/secret-token')).toBe(
      '/academies/my-academy/pay/:token',
    );
  });

  it('redacts guest booking token paths', () => {
    expect(sanitizeAnalyticsPagePath('/booking/secret-token-abc', '?status=success')).toBe('/booking/:token');
  });

  it('keeps normal app paths with allowlisted search', () => {
    expect(sanitizeAnalyticsPagePath('/app/signup/player', '?source=paid_invoice')).toBe(
      '/app/signup/player?source=paid_invoice',
    );
  });

  it('strips personal query params, keeping only allowlisted ones', () => {
    expect(
      sanitizeAnalyticsPagePath('/app/dashboard', '?email=a@example.com&utm_source=news&token=secret'),
    ).toBe('/app/dashboard?utm_source=news');
  });
});

describe('isSensitiveAnalyticsPath', () => {
  it('flags token pages and PII query strings, not ordinary app routes', () => {
    expect(isSensitiveAnalyticsPath('/pay/abc')).toBe(true);
    expect(isSensitiveAnalyticsPath('/booking/abc')).toBe(true);
    expect(isSensitiveAnalyticsPath('/academies/x/pay/abc')).toBe(true);
    expect(isSensitiveAnalyticsPath('/app/dashboard', '?email=a@example.com')).toBe(true);
    expect(isSensitiveAnalyticsPath('/app/dashboard', '?utm_source=news')).toBe(false);
  });
});
