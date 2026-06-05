/**
 * Regression tests for paid invoice bookkeeping forwarding (RL Padel Performance incident).
 *
 * Covers pure helpers + source/config invariants. Runtime edge-function e2e is not executed here;
 * see MANUAL_QA_CHECKLIST at the bottom for production smoke steps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveForwardRecipients,
} from '../../supabase/functions/_shared/forward-invoice-emails.ts';
import {
  countSendOutcomes,
  evaluateForwardInvoiceWebhookResult,
  evaluateForwardSendCompletion,
  parseResendSendResult,
} from '../../supabase/functions/_shared/forward-invoice-response.ts';
import {
  hasNoRoutableMetadata,
  parseMolliePaymentMetadata,
  usesInvoicePaidBranch,
} from '../../supabase/functions/_shared/mollie-webhook-metadata.ts';
import {
  isServiceRoleRequest,
} from '../../supabase/functions/_shared/service-role-auth.ts';

const root = resolve(__dirname, '../..');

function readSource(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const RL_ACADEMY_EMAILS = [
  'joranhofman87+boekhoudcctest@gmail.com',
  '10130.3195@to-zenvoices.com',
];

const webhookCtx = { paymentId: 'tr_rl_test', invoiceId: 'inv-26000422' };

const envBackup = { ...process.env };

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regression-service-role-key';
  process.env.SUPABASE_URL = 'https://rlproject.supabase.co';
  // @ts-expect-error vitest shim for edge shared modules
  globalThis.Deno = {
    env: {
      get: (key: string) => process.env[key],
    },
  };
});

afterEach(() => {
  process.env = { ...envBackup };
});

// ---------------------------------------------------------------------------
// 1. Service-role auth
// ---------------------------------------------------------------------------
describe('bookkeeping regression: service-role auth', () => {
  const forwardSource = readSource('supabase/functions/forward-invoice/index.ts');
  const authSource = readSource('supabase/functions/_shared/forward-invoice-auth.ts');

  it('accepts Authorization Bearer service role (env key match)', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer regression-service-role-key' },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
    expect(authSource).toContain('isServiceRoleRequest');
    expect(forwardSource).toContain('authenticateForwardInvoice');
  });

  it('accepts apikey service role header alone', () => {
    const req = new Request('http://localhost', {
      headers: { apikey: 'regression-service-role-key' },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
  });

  it('accepts identical valid service_role JWT in Authorization and apikey', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = btoa(JSON.stringify({ role: 'service_role', ref: 'rlproject' }));
    const jwt = `${header}.${body}.sig`;
    const req = new Request('http://localhost', {
      headers: { Authorization: `Bearer ${jwt}`, apikey: jwt },
    });
    expect(isServiceRoleRequest(req)).toBe(true);
  });

  it('rejects unauthenticated/public calls via forward-invoice auth_denied', () => {
    expect(isServiceRoleRequest(new Request('http://localhost'))).toBe(false);
    expect(forwardSource).toContain('auth_denied');
    expect(authSource).toContain('jsonUnauthorized');
  });

  it('rejects invalid bearer without service role match', () => {
    const req = new Request('http://localhost', {
      headers: { Authorization: 'Bearer not-a-valid-token' },
    });
    expect(isServiceRoleRequest(req)).toBe(false);
  });

  it('user JWT still requires trainer/academy ownership in forward-invoice handler', () => {
    expect(forwardSource).toContain('if (!isServiceRole)');
    expect(forwardSource).toContain('is_academy_manager');
    expect(forwardSource).toContain('trainerProfile?.user_id === authenticatedUserId');
    expect(forwardSource).toContain('return jsonResponse({ error: "Unauthorized" }, 403)');
    expect(authSource).toContain('supabase.auth.getUser');
  });
});

// ---------------------------------------------------------------------------
// 2. Webhook forwarding path
// ---------------------------------------------------------------------------
describe('bookkeeping regression: mollie-webhook forwarding path', () => {
  const webhookSource = readSource('supabase/functions/mollie-webhook/index.ts');

  it('invoice-paid branch invokes forward-invoice after DB paid update', () => {
    const paidIdx = webhookSource.indexOf(
      'status: "paid", paid_at: new Date().toISOString(), mollie_payment_id: paymentId',
    );
    const forwardIdx = webhookSource.indexOf('invoke("forward-invoice"');
    expect(paidIdx).toBeGreaterThan(-1);
    expect(forwardIdx).toBeGreaterThan(paidIdx);
    expect(webhookSource).toContain('forward_invoice_invoke');
  });

  it('invoice_id metadata takes priority when booking_ids also exists', () => {
    const meta = parseMolliePaymentMetadata({
      invoice_id: 'inv-26000422',
      booking_ids: ['booking-1'],
    });
    expect(usesInvoicePaidBranch(meta.invoiceId)).toBe(true);
    expect(hasNoRoutableMetadata(meta.invoiceId, meta.bookingIds)).toBe(false);
    expect(webhookSource).toContain('usesInvoicePaidBranch');
    expect(webhookSource).not.toContain('invoiceIdFromMetadata && bookingIds.length === 0');
  });

  it('forwarding failure does not block invoice paid status (non-fatal)', () => {
    expect(webhookSource).toContain('non-fatal — paid status already saved');
    const paidIdx = webhookSource.indexOf(
      'status: "paid", paid_at: new Date().toISOString(), mollie_payment_id: paymentId',
    );
    const forwardIdx = webhookSource.indexOf('invoke("forward-invoice"');
    expect(forwardIdx).toBeGreaterThan(paidIdx);
    expect(webhookSource).toContain('return new Response("OK", { status: 200 })');
  });

  const warnCases: Array<{
    name: string;
    body: Record<string, unknown>;
    expectedLogStep: string;
  }> = [
    {
      name: 'success=false',
      body: { success: false, sent: 0, reason: 'no_recipients' },
      expectedLogStep: 'forward_failed',
    },
    {
      name: 'sent=0',
      body: { success: true, sent: 0, failed: 0 },
      expectedLogStep: 'forward_zero_sent',
    },
    {
      name: 'failed>0',
      body: { success: false, sent: 0, failed: 2, reason: 'resend_failed', pdf_attached: true },
      expectedLogStep: 'forward_send_failures',
    },
    {
      name: 'reason=partial_send',
      body: {
        success: false,
        sent: 1,
        failed: 1,
        reason: 'partial_send',
        pdf_attached: true,
        invoice_number: '26000422',
      },
      expectedLogStep: 'forward_partial_send',
    },
    {
      name: 'pdf_attached=false',
      body: { success: false, sent: 0, pdf_attached: false, reason: 'pdf_missing' },
      expectedLogStep: 'forward_failed',
    },
  ];

  it.each(warnCases)('webhook warns when forward-invoice returns $name', ({ body, expectedLogStep }) => {
    const eval_ = evaluateForwardInvoiceWebhookResult(body, null, webhookCtx);
    expect(eval_.shouldWarn).toBe(true);
    expect(eval_.logStep).toBe(expectedLogStep);
    expect(webhookSource).toContain('forwardEval.shouldWarn');
    expect(webhookSource).toContain('notifySlackError');
  });
});

// ---------------------------------------------------------------------------
// 3. Recipient resolution
// ---------------------------------------------------------------------------
describe('bookkeeping regression: recipient resolution', () => {
  it('RL academy invoice uses academy_profiles invoice_forward_emails', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'rl-academy-id',
      academyForwardEmails: RL_ACADEMY_EMAILS,
      trainerForwardEmails: ['trainer-only@example.com'],
    });
    expect(result.source).toBe('merged');
    expect(result.emails).toContain('joranhofman87+boekhoudcctest@gmail.com');
    expect(result.emails).toContain('10130.3195@to-zenvoices.com');
    expect(result.emails).toContain('trainer-only@example.com');
    expect(result.emails).toHaveLength(3);
  });

  it('academy-only invoice uses academy source without trainer emails', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'rl-academy-id',
      academyForwardEmails: RL_ACADEMY_EMAILS,
      trainerForwardEmails: null,
    });
    expect(result.source).toBe('academy');
    expect(result.emails).toEqual(RL_ACADEMY_EMAILS);
  });

  it('academy + trainer emails merge and dedupe', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'academy-1',
      academyForwardEmails: RL_ACADEMY_EMAILS,
      trainerForwardEmails: [RL_ACADEMY_EMAILS[0], 'extra@example.com'],
    });
    expect(result.source).toBe('merged');
    expect(result.emails).toHaveLength(3);
  });

  it('trainer-only invoice uses trainer emails (ignores academy list)', () => {
    const result = resolveForwardRecipients({
      academyProfileId: null,
      academyForwardEmails: RL_ACADEMY_EMAILS,
      trainerForwardEmails: ['trainer@example.com'],
    });
    expect(result.source).toBe('trainer');
    expect(result.emails).toEqual(['trainer@example.com']);
  });

  it('no recipients returns empty list for handler no_recipients response', () => {
    const result = resolveForwardRecipients({
      academyProfileId: 'academy-1',
      academyForwardEmails: [],
      trainerForwardEmails: null,
    });
    expect(result.source).toBe('none');
    expect(result.emails).toEqual([]);

    const source = readSource('supabase/functions/forward-invoice/index.ts');
    expect(source).toContain('reason: "no_recipients"');
    expect(source).toContain('success: false');
  });
});

// ---------------------------------------------------------------------------
// 4. PDF / Resend behavior
// ---------------------------------------------------------------------------
describe('bookkeeping regression: PDF and Resend behavior', () => {
  const forwardSource = readSource('supabase/functions/forward-invoice/index.ts');

  it('missing PDF returns pdf_missing and does not send email', () => {
    expect(forwardSource).toContain('reason: "pdf_missing"');
    expect(forwardSource).toContain('pdf_attached: false');
    expect(forwardSource).not.toContain('sending without attachment');
    const pdfMissingReturn = forwardSource.indexOf('reason: "pdf_missing"');
    const resendSend = forwardSource.indexOf('resend.emails.send');
    expect(pdfMissingReturn).toBeGreaterThan(-1);
    expect(resendSend).toBeGreaterThan(pdfMissingReturn);
  });

  it('invokes generate-invoice when PDF is missing in storage', () => {
    expect(forwardSource).toContain('pdf_missing_generating');
    expect(forwardSource).toContain('/functions/v1/generate-invoice');
  });

  it('Resend { error } increments failed count via parseResendSendResult', () => {
    const outcomes = [
      parseResendSendResult({ id: 're_1' }, null),
      parseResendSendResult(null, { message: 'rejected' }),
    ];
    expect(countSendOutcomes(outcomes.map((o) => ({ ok: o.ok })))).toEqual({ sent: 1, failed: 1 });
    expect(forwardSource).toContain('parseResendSendResult');
  });

  it('sent=1 failed=1 => success=false reason=partial_send', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 1, failed: 1, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({ success: false, reason: 'partial_send', shouldSetForwardedAt: false });
  });

  it('sent=0 failed=2 => success=false reason=resend_failed', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 0, failed: 2, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({ success: false, reason: 'resend_failed', shouldSetForwardedAt: false });
  });

  it('sent=2 failed=0 => success=true', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 2, failed: 0, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({ success: true, shouldSetForwardedAt: true });
  });
});

// ---------------------------------------------------------------------------
// 5. forwarded_at behavior
// ---------------------------------------------------------------------------
describe('bookkeeping regression: forwarded_at behavior', () => {
  const forwardSource = readSource('supabase/functions/forward-invoice/index.ts');

  it('sets forwarded_at only on full success (sent===total, failed===0, pdf attached)', () => {
    expect(forwardSource).toContain('evaluateForwardSendCompletion');
    expect(forwardSource).toContain('completion.shouldSetForwardedAt');
    expect(forwardSource).not.toMatch(/if \(sent > 0\)[\s\S]{0,120}forwarded_at/);

    expect(
      evaluateForwardSendCompletion({ sent: 2, failed: 0, totalRecipients: 2, pdfAttached: true }),
    ).toEqual({ success: true, shouldSetForwardedAt: true });
  });

  it('does not set forwarded_at on partial_send', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 1, failed: 1, totalRecipients: 2, pdfAttached: true }),
    ).toMatchObject({ shouldSetForwardedAt: false, reason: 'partial_send' });
  });

  it('does not set forwarded_at on pdf_missing path', () => {
    expect(
      evaluateForwardSendCompletion({ sent: 0, failed: 0, totalRecipients: 2, pdfAttached: false }),
    ).toMatchObject({ shouldSetForwardedAt: false });
    expect(forwardSource).toContain('reason: "pdf_missing"');
    const pdfMissingIdx = forwardSource.indexOf('reason: "pdf_missing"');
    const shouldSetIdx = forwardSource.indexOf('completion.shouldSetForwardedAt');
    expect(pdfMissingIdx).toBeLessThan(shouldSetIdx);
  });

  it('already forwarded skips by default', () => {
    expect(forwardSource).toContain('if (invoice.forwarded_at && !force)');
    expect(forwardSource).toContain('reason: "already_forwarded"');
    expect(forwardSource).toContain('skipped: true');
  });

  it('force:true bypasses already_forwarded skip', () => {
    expect(forwardSource).toContain('body?.force === true');
    const skipIdx = forwardSource.indexOf('if (invoice.forwarded_at && !force)');
    const forceIdx = forwardSource.indexOf('body?.force === true');
    expect(skipIdx).toBeGreaterThan(-1);
    expect(forceIdx).toBeGreaterThan(-1);
  });

  it('webhook does not warn on already_forwarded skip', () => {
    const eval_ = evaluateForwardInvoiceWebhookResult(
      { success: true, skipped: true, reason: 'already_forwarded', sent: 0 },
      null,
      webhookCtx,
    );
    expect(eval_.shouldWarn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Source/config regression
// ---------------------------------------------------------------------------
describe('bookkeeping regression: config', () => {
  it('supabase/config.toml disables JWT verification for forward-invoice', () => {
    const config = readSource('supabase/config.toml');
    expect(config).toMatch(/\[functions\.forward-invoice\][\s\S]*?verify_jwt\s*=\s*false/);
  });
});

// ---------------------------------------------------------------------------
// 7. Manual smoke / e2e checklist (documented — not executed in CI)
// ---------------------------------------------------------------------------
export const MANUAL_QA_CHECKLIST = [
  'Confirm rl-padel-performance academy_profiles.invoice_forward_emails has both bookkeeping addresses',
  'Create or use a test invoice with academy_profile_id set',
  'Pay invoice via public pay link (create-invoice-payment metadata invoice_id only)',
  'Verify invoice status=paid, paid_at set in DB',
  'Verify mollie-webhook logs: invoice_paid_branch, forward_invoice_invoke, forward_success',
  'Verify forward-invoice logs: auth_resolved service_role, recipients_resolved emailSource academy/merged, send_complete sent=2 failed=0',
  'Verify invoices.forwarded_at is set after payment',
  'Verify invoices.pdf_url or storage PDF exists',
  'Confirm both bookkeeping inboxes received PDF attachment',
  'Negative: revoke one Resend recipient temporarily — expect partial_send, forwarded_at null, Slack forward_partial_send',
  'Legacy: invoice with forwarded_at from old logic — curl force:true re-forward succeeds to both addresses',
] as const;

describe('bookkeeping regression: manual QA checklist', () => {
  it('documents production smoke steps for paid invoice forwarding', () => {
    expect(MANUAL_QA_CHECKLIST.length).toBeGreaterThanOrEqual(8);
    expect(MANUAL_QA_CHECKLIST.some((step) => step.includes('forwarded_at'))).toBe(true);
    expect(MANUAL_QA_CHECKLIST.some((step) => step.includes('bookkeeping'))).toBe(true);
    expect(MANUAL_QA_CHECKLIST.some((step) => step.includes('force:true'))).toBe(true);
  });
});
