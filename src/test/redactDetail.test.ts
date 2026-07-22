// @vitest-environment node
// redactDetail — the failure-detail scrubber applied before a detail reaches Slack or the
// durable payment_audit_log. Codex #4: "sanitized" must mean redacted, not merely truncated.
import { describe, it, expect } from 'vitest';
import { redactDetail } from '../../supabase/functions/_shared/redact-detail.ts';

describe('redactDetail', () => {
  it('redacts an email address', () => {
    expect(redactDetail('failed to reach kim.lange@home.nl for booking')).not.toContain('kim.lange@home.nl');
    expect(redactDetail('failed to reach kim.lange@home.nl')).toContain('[redacted-email]');
  });

  it('redacts a JWT-like token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    const out = redactDetail(`auth failed with ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain('[redacted-jwt]');
  });

  it('redacts a Bearer token', () => {
    const out = redactDetail('Authorization: Bearer sbp_verysecrettokenvalue1234567890');
    expect(out).not.toContain('sbp_verysecrettokenvalue1234567890');
    expect(out).toContain('Bearer [redacted]');
  });

  it('strips a URL query string (which can carry tokens / PII)', () => {
    const out = redactDetail('POST https://api.mollie.com/v2/payments?apiKey=secret&email=a@b.com failed');
    expect(out).not.toContain('apiKey=secret');
    expect(out).not.toContain('a@b.com');
    expect(out).toContain('[redacted-query]');
  });

  it('redacts a Mollie-style payment/resource id', () => {
    const out = redactDetail('payment tr_NSYoSDqSqgSsegmsLiEUJ was rejected');
    expect(out).not.toContain('tr_NSYoSDqSqgSsegmsLiEUJ');
    expect(out).toContain('[redacted-id]');
  });

  it('redacts a generic long opaque token', () => {
    const out = redactDetail('key AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENG rotated');
    expect(out).toContain('[redacted-token]');
  });

  it('collapses whitespace and length-bounds', () => {
    const out = redactDetail('a\n\n  b\t c ' + 'x'.repeat(500), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).not.toMatch(/[\n\t]/);
    expect(out).toContain('a b c');
  });

  it('redacts a payment path token (/pay/<token>) even when short/hyphenated', () => {
    expect(redactDetail('open https://padeltrainer.ai/pay/aB3-xY9 to retry'))
      .toContain('/pay/[redacted-token]');
    expect(redactDetail('open https://padeltrainer.ai/pay/aB3-xY9')).not.toContain('aB3-xY9');
  });

  it('redacts a booking path token (/booking/<token>)', () => {
    expect(redactDetail('link https://padeltrainer.ai/booking/short1')).toContain('/booking/[redacted-token]');
    expect(redactDetail('link https://padeltrainer.ai/booking/short1')).not.toContain('short1');
  });

  it('redacts the branded /academies/<slug>/pay/<token> route', () => {
    const out = redactDetail('https://padeltrainer.ai/academies/rl-padel/pay/SECRETPAYTOKEN');
    expect(out).not.toContain('SECRETPAYTOKEN');
    expect(out).toContain('/pay/[redacted-token]');
  });

  it('PARITY: every sensitive route the frontend redactTrackingString redacts, the edge redactor also redacts', () => {
    // Guards against the two policies drifting. If the frontend adds a sensitive route, this
    // list should grow and both must cover it.
    const cases = [
      'https://padeltrainer.ai/pay/tok123',
      'https://padeltrainer.ai/booking/tok123',
      'https://padeltrainer.ai/academies/x/pay/tok123',
    ];
    for (const c of cases) {
      expect(redactDetail(c), `edge redactor must cover ${c}`).not.toContain('tok123');
    }
  });

  it('leaves ordinary error text readable', () => {
    expect(redactDetail('confirmation set covers multiple recipients'))
      .toBe('confirmation set covers multiple recipients');
    expect(redactDetail(null)).toBe('');
  });
});
