import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('forward-invoice implementation', () => {
  const source = readSource('supabase/functions/forward-invoice/index.ts');

  it('uses academy-first email resolution via shared helper', () => {
    expect(source).toContain('resolveForwardRecipients');
    expect(source).toContain('recipients_resolved');
    expect(source).toContain('emailSource');
  });

  it('returns success false for no recipients', () => {
    expect(source).toContain('reason: "no_recipients"');
    expect(source).toContain('success: false');
    expect(source).not.toContain('No forwarding emails configured');
  });

  it('uses parseResendSendResult for Resend errors', () => {
    expect(source).toContain('parseResendSendResult');
    expect(source).not.toContain('Promise.allSettled');
  });

  it('sets forwarded_at only on full delivery (all recipients, no failures, PDF)', () => {
    expect(source).toContain('evaluateForwardSendCompletion');
    expect(source).toContain('completion.shouldSetForwardedAt');
    expect(source).toContain('forwarded_at');
    expect(source).not.toMatch(/if \(sent > 0\)[\s\S]{0,80}forwarded_at/);
  });

  it('returns partial_send when some recipients fail', () => {
    expect(source).toContain('evaluateForwardSendCompletion');
    expect(source).toContain('completion.reason');
    expect(source).toContain('completion.success');
  });

  it('fails when PDF is missing instead of sending without attachment', () => {
    expect(source).toContain('reason: "pdf_missing"');
    expect(source).toContain('pdf_attached: false');
    expect(source).not.toContain('sending without attachment');
  });

  it('logs request_received and auth_resolved at start', () => {
    expect(source).toContain('request_received');
    expect(source).toContain('auth_resolved');
    expect(source).toContain('authenticateForwardInvoice');
  });

  it('skips when already forwarded unless force', () => {
    expect(source).toContain('already_forwarded');
    expect(source).toContain('body?.force === true');
    expect(source).toContain('skipped: true');
  });

  it('force=true bypasses the forwarded_at claim (M-02 atomic claim)', () => {
    // The atomic forwarded_at claim is gated by `if (!force)`, so a force resend
    // skips the dedup claim and re-forwards.
    expect(source).toContain('if (!force)');
    expect(source).toContain('.is("forwarded_at", null)');
    expect(source).not.toContain('if (invoice.forwarded_at && !force)');
  });
});

describe('mollie-webhook forward handling', () => {
  const source = readSource('supabase/functions/mollie-webhook/index.ts');

  it('evaluates forward-invoice response body', () => {
    expect(source).toContain('evaluateForwardInvoiceWebhookResult');
    expect(source).toContain('forwardEval.shouldWarn');
  });

  it('does not block paid status when forwarding fails', () => {
    const paidUpdateIdx = source.indexOf(
      'status: "paid", paid_at: new Date().toISOString(), mollie_payment_id: paymentId',
    );
    const forwardIdx = source.indexOf('invoke("forward-invoice"');
    expect(paidUpdateIdx).toBeGreaterThan(-1);
    expect(forwardIdx).toBeGreaterThan(paidUpdateIdx);
    expect(source).toContain('non-fatal — paid status already saved');
  });
});
