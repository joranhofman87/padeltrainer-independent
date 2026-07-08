import { test, expect, request as pwRequest } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/**
 * FULL money-path E2E for the PUBLIC (logged-out) single-slot booking, against a MOCK Mollie
 * (scripts/db/mock-mollie.mjs) so the create-payment → webhook → mark-paid loop runs with no real
 * gateway. Prereq: `npm run e2e:local:paid` (seeds, starts the mock, serves the edge functions with
 * MOLLIE_API_BASE pointed at the mock).
 *
 * Scenario: an anonymous visitor books a standalone public training and pays. Only a paid webhook
 * commits the seat. The seeded slot is a €20 court with 4 seats and allow_single_booking, so the
 * per-seat guest price is 20 ÷ 4 = €5.00. We assert the server-authoritative amount equals that
 * (never trusting the client), that the charge equals the recorded amount, and that the booking
 * flips to paid + confirmed only after the webhook.
 */
const SB = 'http://127.0.0.1:54321';
const ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SVC =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

test('public guest booking → Mollie (mock) → webhook → seat + amount PAID', async () => {
  const svc = createClient(SB, SVC, { auth: { persistSession: false } });
  const ctx = await pwRequest.newContext();

  // The seeded standalone public slot (no cyclus_id) on the hero academy.
  const { data: academy } = await svc.from('academy_profiles').select('id').eq('slug', 'test-padel-academy').single();
  const { data: slot } = await svc
    .from('availability_slots')
    .select('id, price_per_session, max_participants, allow_single_booking')
    .eq('academy_profile_id', academy!.id)
    .is('cyclus_id', null)
    .eq('is_public', true)
    .single();
  expect(slot, 'no seeded standalone public slot found').toBeTruthy();

  // Per-seat price recomputed the SAME way the edge function will (court ÷ capacity when single
  // booking is allowed) — the spec re-derives the pricing rule, so a drift in it fails here.
  const maxP = slot!.max_participants || 1;
  const expectedAmount =
    slot!.allow_single_booking && maxP > 1 ? Number(slot!.price_per_session) / maxP : Number(slot!.price_per_session);
  expect(expectedAmount).toBe(5);

  // 1) Anonymous guest books + pays → a hold + a (mock) Mollie payment.
  const create = await ctx.post(`${SB}/functions/v1/create-guest-slot-payment`, {
    headers: { Authorization: `Bearer ${ANON}`, apikey: ANON, 'Content-Type': 'application/json' },
    data: { slotId: slot!.id, email: 'e2e.public@local.test', phone: '+31612345678', fullName: 'E2E Public Guest' },
  });
  const cbody = await create.json();
  expect(cbody.checkoutUrl, `create-guest-slot-payment: ${JSON.stringify(cbody)}`).toBeTruthy();
  expect(cbody.paymentId).toBeTruthy();

  // 2) The seat exists only as an UNPAID hold until the webhook lands.
  const { data: held } = await svc
    .from('bookings')
    .select('id, status, payment_status, payment_amount')
    .eq('mollie_payment_id', cbody.paymentId)
    .single();
  expect(held, 'no hold row for the created payment').toBeTruthy();
  expect(held!.payment_status).not.toBe('paid');
  expect(Number(held!.payment_amount)).toBe(expectedAmount); // charge == recorded amount

  // 3) Mollie calls the webhook; it re-fetches the payment (mock says PAID) and commits the hold.
  const hook = await ctx.post(`${SB}/functions/v1/mollie-webhook`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `id=${cbody.paymentId}`,
  });
  expect(hook.status()).toBe(200);
  await ctx.dispose();

  // 4) The seat is now paid + confirmed at the exact per-seat amount.
  const { data: paid } = await svc
    .from('bookings')
    .select('status, payment_status, payment_amount')
    .eq('mollie_payment_id', cbody.paymentId)
    .single();
  expect(paid!.payment_status).toBe('paid');
  expect(paid!.status).toBe('confirmed');
  expect(Number(paid!.payment_amount)).toBe(expectedAmount);
});
