import { describe, it, expect } from 'vitest';
import { decidePublicInvoiceAccess } from '../../supabase/functions/_shared/publicInvoiceAccess.ts';

describe('decidePublicInvoiceAccess', () => {
  const base = { public_token_revoked_at: null as string | null };

  it('paid + revoked token -> paid (before revoke blocks)', () => {
    expect(
      decidePublicInvoiceAccess({
        ...base,
        status: 'paid',
        public_token_revoked_at: '2026-01-01T00:00:00Z',
      }),
    ).toBe('paid');
  });

  it('cancelled + revoked token -> cancelled', () => {
    expect(
      decidePublicInvoiceAccess({
        status: 'cancelled',
        public_token_revoked_at: '2026-01-01T00:00:00Z',
      }),
    ).toBe('cancelled');
  });

  it('unpaid revoked token -> not_found', () => {
    expect(
      decidePublicInvoiceAccess({
        status: 'sent',
        public_token_revoked_at: '2026-01-01T00:00:00Z',
      }),
    ).toBe('not_found');
  });

  it('draft unchanged', () => {
    expect(decidePublicInvoiceAccess({ status: 'draft', public_token_revoked_at: null })).toBe('draft');
  });

  it('sent unpaid -> full', () => {
    expect(decidePublicInvoiceAccess({ status: 'sent', public_token_revoked_at: null })).toBe('full');
  });

  it('download action -> download even when revoked', () => {
    expect(
      decidePublicInvoiceAccess(
        { status: 'paid', public_token_revoked_at: '2026-01-01T00:00:00Z' },
        { action: 'download' },
      ),
    ).toBe('download');
  });
});
