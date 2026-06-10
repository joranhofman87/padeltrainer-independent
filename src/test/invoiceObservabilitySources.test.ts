import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('invoice-health-check observability', () => {
  const source = readSource('supabase/functions/invoice-health-check/index.ts');

  it('includes Phase A anomaly checks', () => {
    expect(source).toContain('mollie_payment_stuck');
    expect(source).toContain('paid_missing_paid_at');
    expect(source).toContain('sent_missing_public_token');
    expect(source).toContain('sent_missing_sent_at');
    expect(source).toContain('bookings_paid_invoice_unpaid');
    expect(source).toContain('.lt("updated_at", thirtyMinutesAgo())');
    expect(source).toContain('.lt("updated_at", twentyFourHoursAgo())');
  });
});

describe('mollie-webhook invoice branch alerts', () => {
  const source = readSource('supabase/functions/mollie-webhook/index.ts');

  it('sends payment_received Slack on invoice paid success', () => {
    expect(source).toContain('event: "payment_received"');
    expect(source).toContain('type: "invoice"');
  });

  it('sends Slack when invoice DB update fails', () => {
    expect(source).toContain('Invoice paid webhook: DB update failed');
  });

  it('sends Slack when linked bookings sync fails', () => {
    expect(source).toContain('Invoice paid webhook: linked bookings sync failed');
  });

  it('evaluates forward-invoice response for Slack warnings', () => {
    expect(source).toContain('evaluateForwardInvoiceWebhookResult');
    expect(source).toContain('forwardEval.shouldWarn');
  });
});

describe('send-invoice-email observability', () => {
  const source = readSource('supabase/functions/send-invoice-email/index.ts');

  it('uses structured logStep without logging recipient email', () => {
    expect(source).toContain('[SEND-INVOICE-EMAIL]');
    expect(source).toContain('logStep("started"');
    expect(source).toContain('logStep("sent"');
    expect(source).toContain('logStep("failed"');
    expect(source).toContain('logStep("no_recipient"');
    expect(source).toContain('logStep("status_update_failed"');
    expect(source).not.toMatch(/logStep\([^)]*recipientEmail/);
    expect(source).not.toContain('to ${recipientEmail}');
  });

  it('sends Slack on send and status update failures', () => {
    expect(source).toContain('notifySlackEdgeError');
    expect(source).toContain('Resend send failed');
    expect(source).toContain('sent_at/status update failed');
  });
});

describe('generate-invoice observability', () => {
  const source = readSource('supabase/functions/generate-invoice/index.ts');

  it('uses structured logs and Slack on storage failures', () => {
    expect(source).toContain('[GENERATE-INVOICE]');
    expect(source).toContain('logStep("started"');
    expect(source).toContain('logStep("success"');
    expect(source).toContain('logStep("failed"');
    expect(source).toContain('logStep("auth_denied"');
    expect(source).toContain('logStep("storage_upload_failed"');
    expect(source).toContain('notifySlackEdgeError');
    expect(source).toContain('Invoice PDF storage upload failed');
  });
});
