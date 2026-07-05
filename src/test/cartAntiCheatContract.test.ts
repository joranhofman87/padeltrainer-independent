// @vitest-environment node
// Cart anti-cheat SOURCE CONTRACT (cart PR 5, audit §10/§16 adversarial set).
//
// The behavioral halves already run elsewhere: forged-price immunity = the server reprices
// from slot rows (_shared/cart-payment.test.ts pricing parity); cross-tenant/mixed-org and
// hidden-slot refusals = cart-payment.test.ts + guestCartBooking.pglite.test.ts. What no
// behavioral test can pin down is which CLIENT FIELDS the edge function reads at all —
// that's a property of the source. These assertions fail the build if someone wires a
// client-supplied money/identity field into create-guest-cart-payment.
//
// (Style precedent: invoiceObservabilitySources.test.ts — source-level contracts.)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const fnSource = readFileSync(
  join(process.cwd(), 'supabase', 'functions', 'create-guest-cart-payment', 'index.ts'),
  'utf8',
);
const coreSource = readFileSync(
  join(process.cwd(), 'supabase', 'functions', '_shared', 'cart-payment.ts'),
  'utf8',
);
const invoiceSource = readFileSync(
  join(process.cwd(), 'supabase', 'functions', 'auto-create-invoice', 'index.ts'),
  'utf8',
);

/** Every `body.<field>` / `body?.<field>` the function reads. */
function clientFieldsRead(source: string): Set<string> {
  const fields = new Set<string>();
  for (const m of source.matchAll(/\bbody\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) fields.add(m[1]);
  return fields;
}

describe('create-guest-cart-payment — client trust surface', () => {
  it('reads ONLY the slot list and contact fields from the client', () => {
    const allowed = new Set(['slotIds', 'firstName', 'lastName', 'fullName', 'email', 'phone', 'notes']);
    const read = clientFieldsRead(fnSource);
    expect([...read].filter((f) => !allowed.has(f))).toEqual([]);
    expect(read.has('slotIds')).toBe(true);
  });

  it('never reads a client-supplied money or identity field', () => {
    // amount/price/total/guest_player_id/booking_ids must NEVER come from the request body.
    expect(fnSource).not.toMatch(/body\??\.(amount|price|total|payment_amount|guest_?player_?id|booking_?ids)/i);
  });

  it('guest identity is server-resolved and the Mollie metadata uses the RPC-returned ids', () => {
    expect(fnSource).toContain('resolveOrCreateGuestPlayer(');
    // canonical sort of the RPC output (idempotency-key body stability)…
    expect(fnSource).toMatch(/\[\.\.\.\(\(idsData as string\[\]\) \?\? \[\]\)\]\.sort\(\)/);
    // …and metadata.booking_ids comes from that variable, nothing client-supplied
    expect(fnSource).toMatch(/booking_ids:\s*bookingIds/);
  });

  it('pricing comes from the server-read slot rows via the shared core', () => {
    expect(fnSource).toContain('priceCartItems(');
    expect(coreSource).toContain('computeSingleSlotPaymentAmount(');
    expect(coreSource).toContain('sumSlotExtraCosts(');
  });
});

describe('auto-create-invoice — heterogeneous cart contract', () => {
  // Verified in the design audit: the cyclus-bundle branch requires EVERY booking to share
  // one identical non-null cyclus_id, so any mixed cart (different cycli and/or standalone
  // slots) falls through to one date-stamped line per session. Pin the predicate + the
  // per-session fallback so a refactor can't silently bundle mixed carts. A full behavioral
  // test needs the line-item builder extracted to _shared — tracked as a follow-up.
  it('bundles ONLY when every booking shares one non-null cyclus_id', () => {
    expect(invoiceSource).toMatch(
      /allSameCyclus\s*=\s*sharedCyclusId\s*&&\s*bookings\.every\(\(b\)\s*=>\s*\(b\.availability_slots as any\)\.cyclus_id === sharedCyclusId\)/,
    );
  });

  it('keeps the per-session line-item fallback for mixed sets', () => {
    expect(invoiceSource).toMatch(/lineItems = bookings\.map\(/);
  });
});
