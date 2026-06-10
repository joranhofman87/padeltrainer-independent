import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('forward-invoice auth', () => {
  const forwardSource = readSource('supabase/functions/forward-invoice/index.ts');
  const authSource = readSource('supabase/functions/_shared/forward-invoice-auth.ts');
  const sharedAuthSource = readSource('supabase/functions/_shared/auth.ts');
  const config = readSource('supabase/config.toml');

  it('disables gateway JWT verification (in-code auth like other functions)', () => {
    expect(config).toMatch(/\[functions\.forward-invoice\][\s\S]*?verify_jwt\s*=\s*false/);
  });

  it('logs request_received before auth in handler', () => {
    const handlerStart = forwardSource.indexOf('const handler = async');
    const receivedIdx = forwardSource.indexOf('logStep("request_received"', handlerStart);
    const authIdx = forwardSource.indexOf('authenticateForwardInvoice(req)', handlerStart);
    expect(receivedIdx).toBeGreaterThan(handlerStart);
    expect(authIdx).toBeGreaterThan(receivedIdx);
  });

  it('uses shared authenticateForwardInvoice with service-role-auth', () => {
    expect(forwardSource).toContain('authenticateForwardInvoice');
    expect(authSource).toContain('isServiceRoleRequest');
    expect(authSource).toContain('auth_debug');
    expect(sharedAuthSource).toContain('isServiceRoleRequest');
  });

  it('allows service role to bypass trainer/academy ownership check', () => {
    expect(forwardSource).toContain('if (!isServiceRole)');
    expect(forwardSource).not.toMatch(/if \(!isServiceRole\)[\s\S]{0,200}return jsonResponse\(\{ error: "Unauthorized" \}, 401\)/);
  });

  it('rejects unauthenticated calls via auth_denied log', () => {
    expect(forwardSource).toContain('auth_denied');
    expect(forwardSource).toContain('auth.response');
  });

  it('logs auth_debug with safe fields before auth decision', () => {
    expect(authSource).toContain('buildServiceRoleAuthDebug');
    expect(authSource).toContain('auth_debug');
  });
});

describe('mollie-webhook forward-invoice invoke', () => {
  const webhookSource = readSource('supabase/functions/mollie-webhook/index.ts');

  it('invokes forward-invoice after invoice paid update', () => {
    const paidUpdateIdx = webhookSource.indexOf(
      'status: "paid", paid_at: new Date().toISOString(), mollie_payment_id: paymentId',
    );
    const forwardIdx = webhookSource.indexOf('invoke("forward-invoice"');
    expect(forwardIdx).toBeGreaterThan(paidUpdateIdx);
  });

  it('routes invoice_id metadata to invoice paid branch even with booking_ids', () => {
    expect(webhookSource).toContain('usesInvoicePaidBranch');
    expect(webhookSource).not.toContain('invoiceIdFromMetadata && bookingIds.length === 0');
  });

  it('passes service role Authorization and apikey to forward-invoice', () => {
    expect(webhookSource).toContain('Authorization: `Bearer ${supabaseServiceKey}`');
    expect(webhookSource).toContain('apikey: supabaseServiceKey');
  });

  it('logs forward_invoice_invoke before calling forward-invoice', () => {
    expect(webhookSource).toContain('forward_invoice_invoke');
  });
});
