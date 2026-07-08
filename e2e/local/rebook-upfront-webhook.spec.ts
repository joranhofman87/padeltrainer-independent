import { test, expect, request as pwRequest } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/**
 * FULL money-path E2E against a MOCK Mollie (scripts/db/mock-mollie.mjs), so the create-payment →
 * webhook → mark-paid loop runs deterministically with no real gateway. Prereq: `npm run e2e:local:paid`
 * seeds, starts the mock, and serves the edge functions with MOLLIE_API_BASE pointed at the mock.
 *
 * Steps: logged-out captain triggers the upfront group pay → an invoice + a (mock) Mollie payment
 * are created → we POST the webhook as Mollie would → the webhook re-fetches the payment (mock says
 * PAID) → the invoice + the captain's booking flip to paid at the full court price.
 */
const SB = 'http://127.0.0.1:54321';
const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const CAPTAIN_TOKEN = 'seed-claim-up-a0-s0-p1';

test('upfront pay → Mollie (mock) → webhook → invoice + booking PAID', async () => {
  const svc = createClient(SB, SVC, { auth: { persistSession: false } });
  const ctx = await pwRequest.newContext();

  // 1) Captain (logged-out) triggers the group upfront pay → invoice + mock Mollie payment.
  const create = await ctx.post(`${SB}/functions/v1/create-group-rebook-invoice`, {
    headers: { Authorization: `Bearer ${ANON}`, apikey: ANON, 'Content-Type': 'application/json' },
    data: { token: CAPTAIN_TOKEN },
  });
  const cbody = await create.json();
  expect(cbody.ok, `create-group-rebook-invoice: ${JSON.stringify(cbody)}`).toBe(true);
  expect(cbody.checkoutUrl, `no checkout — payment not created: ${JSON.stringify(cbody)}`).toBeTruthy();

  // 2) The invoice carries the Mollie payment id the webhook keys on.
  const { data: inv1 } = await svc.from('invoices').select('mollie_payment_id, total').eq('id', cbody.invoiceId).single();
  expect(inv1!.mollie_payment_id).toBeTruthy();
  expect(Number(inv1!.total)).toBe(40); // full court price, no split

  // 3) Simulate Mollie calling the webhook (it can't reach localhost; the webhook re-fetches the
  //    payment from the mock, which reports PAID).
  const hook = await ctx.post(`${SB}/functions/v1/mollie-webhook`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `id=${inv1!.mollie_payment_id}`,
  });
  expect(hook.status()).toBe(200);
  await ctx.dispose();

  // 4) The invoice flips to paid, and the captain's bookings on the upfront cycle are marked paid.
  const { data: inv2 } = await svc.from('invoices').select('status').eq('id', cbody.invoiceId).single();
  expect(inv2!.status).toBe('paid');
  const { data: cyc } = await svc.from('cycles').select('id').ilike('name', '%direct betalen%').limit(1).single();
  const { data: slots } = await svc.from('availability_slots').select('id').eq('cyclus_id', cyc!.id);
  const { data: bks } = await svc.from('bookings').select('payment_status').in('slot_id', (slots ?? []).map((s) => s.id));
  expect((bks ?? []).length).toBeGreaterThan(0);
  expect((bks ?? []).some((b) => b.payment_status === 'paid')).toBe(true);
});
