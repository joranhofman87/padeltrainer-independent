import { describe, it, expect } from 'vitest';
import {
  countSendOutcomes,
  evaluateForwardInvoiceWebhookResult,
  evaluateForwardSendCompletion,
  parseResendSendResult,
} from '../../supabase/functions/_shared/forward-invoice-response.ts';

const ctx = { paymentId: 'tr_test', invoiceId: 'inv-1' };

describe('parseResendSendResult', () => {
  it('treats Resend error as failure', () => {
    expect(parseResendSendResult(null, { message: 'bounce' })).toEqual({
      ok: false,
      error: 'bounce',
    });
  });

  it('treats missing id as failure', () => {
    expect(parseResendSendResult({}, null)).toEqual({
      ok: false,
      error: 'no_resend_id',
    });
  });

  it('counts success when Resend returns id', () => {
    expect(parseResendSendResult({ id: 're_123' }, null)).toEqual({
      ok: true,
      resendId: 're_123',
    });
  });
});

describe('countSendOutcomes', () => {
  it('counts sent and failed correctly', () => {
    expect(countSendOutcomes([{ ok: true }, { ok: false }, { ok: true }])).toEqual({
      sent: 2,
      failed: 1,
    });
  });
});

describe('evaluateForwardSendCompletion', () => {
  it('sent=1 failed=1 => success=false, reason partial_send, no forwarded_at', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 1, failed: 1, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({
      success: false,
      reason: 'partial_send',
      shouldSetForwardedAt: false,
    });
  });

  it('sent=2 failed=0 with PDF => full success and forwarded_at', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 2, failed: 0, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({
      success: true,
      shouldSetForwardedAt: true,
    });
  });

  it('sent=0 failed=2 => resend_failed, no forwarded_at', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 0, failed: 2, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({
      success: false,
      reason: 'resend_failed',
      shouldSetForwardedAt: false,
    });
  });

  it('does not set forwarded_at without PDF', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 2, failed: 0, totalRecipients: 2, pdfAttached: false }),
    ).toEqual({
      success: false,
      shouldSetForwardedAt: false,
    });
  });
});

describe('evaluateForwardInvoiceWebhookResult', () => {
  it('warns on invoke error', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(null, new Error('network'), ctx);
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.slackMessage).toContain('invoke failed');
  });

  it('does not warn when already forwarded (skipped)', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: true, skipped: true, reason: 'already_forwarded', sent: 0 },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(false);
    expect(eval_.logStep).toBe('forward_skipped');
  });

  it('warns when success is false', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: false, sent: 0, reason: 'no_recipients' },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
  });

  it('warns when sent is 0 and no send failures counted', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: false, sent: 0, failed: 0, reason: 'no_recipients' },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.logStep).toBe('forward_failed');
  });

  it('warns on forward_zero_sent when success true but sent 0', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: true, sent: 0, failed: 0 },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.logStep).toBe('forward_zero_sent');
  });

  it('warns when pdf_attached is false', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: false, sent: 0, pdf_attached: false, reason: 'pdf_missing' },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
  });

  it('does not warn on successful forward with pdf', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: true, sent: 2, failed: 0, pdf_attached: true, email_source: 'academy' },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(false);
    expect(eval_.logStep).toBe('forward_success');
  });

  it('warns on failed > 0', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      {
        success: false,
        sent: 1,
        failed: 1,
        reason: 'partial_send',
        pdf_attached: true,
        email_source: 'academy',
        invoice_number: '26000421',
      },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.logStep).toBe('forward_partial_send');
    expect(eval_.context).toMatchObject({
      sent: 1,
      failed: 1,
      reason: 'partial_send',
      email_source: 'academy',
      invoice_number: '26000421',
    });
  });

  it('warns on partial_send reason', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      {
        success: false,
        sent: 1,
        failed: 1,
        reason: 'partial_send',
        pdf_attached: true,
      },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.slackMessage).toContain('partial delivery');
  });

  it('warns on resend_failed with failed > 0', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      {
        success: false,
        sent: 0,
        failed: 2,
        reason: 'resend_failed',
        pdf_attached: true,
        email_source: 'merged',
      },
      null,
      ctx,
    );
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.logStep).toBe('forward_send_failures');
  });
});
