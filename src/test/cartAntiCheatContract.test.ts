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
    // whatsappOptIn (PR 9) is a pure consent BOOLEAN: it gates a notification_contacts write
    // and touches nothing about pricing, slot selection or identity. The tenant that consent is
    // scoped to is read from the SLOT server-side, never from the body — which is the property
    // this suite exists to protect, and why the boolean is safe to accept.
    //
    // creationRequestId (U2) is an OPAQUE IDEMPOTENCY TOKEN, and the trust it carries is worth
    // being precise about, because "a client-supplied id" is exactly the shape this suite exists
    // to be suspicious of. It names an ATTEMPT, never a Player, a price or a slot:
    //   * it cannot select an existing Player. Replaying an id returns the Player that id created
    //     and only if the owner scope, the origin AND the sha256 of (name, email, phone) all still
    //     agree; any other payload is refused as PLAYER_CREATE_IDEMPOTENCY_CONFLICT. So reaching
    //     somebody else's Player requires already knowing their exact name, address and phone —
    //     which is precisely what the email-and-name lookup this replaced handed over for free.
    //   * it grants no authorization. The scope comes from the server-read SLOT, and the command
    //     re-decides who may create there.
    //   * guessing is a uuid4 search, and a hit that does not match the fingerprint is a refusal.
    const allowed = new Set([
      'slotIds', 'firstName', 'lastName', 'fullName', 'email', 'phone', 'notes', 'whatsappOptIn',
      'creationRequestId',
    ]);
    const read = clientFieldsRead(fnSource);
    expect([...read].filter((f) => !allowed.has(f))).toEqual([]);
    expect(read.has('slotIds')).toBe(true);
  });

  it('never reads a client-supplied money or identity field', () => {
    // amount/price/total/guest_player_id/booking_ids must NEVER come from the request body.
    expect(fnSource).not.toMatch(/body\??\.(amount|price|total|payment_amount|guest_?player_?id|booking_?ids)/i);
  });

  it('never takes the CONSENT TENANT from the client either', () => {
    // PR 9 accepts a whatsappOptIn boolean, but the academy/trainer that consent is scoped to
    // must keep coming off the server-read slot rows — a client-named tenant would let anyone
    // mint a consent row inside someone else's academy.
    expect(fnSource).not.toMatch(/body\??\.(academy_?profile_?id|academyProfileId|trainer_?id|trainerId)/i);
    expect(fnSource).toMatch(/academyProfileId,?\n?\s*trainerId|academyProfileId: academyProfileId|academyProfileId,/);
  });

  it('the client id is validated as a uuid before it reaches the command', () => {
    // An unvalidated token would reach Postgres as a uuid cast and answer a malformed request with
    // a 500 instead of a refusal — and it is the one client field the create is keyed on.
    expect(fnSource).toMatch(/UUID_RE\.test\(creationRequestId\)/);
    expect(fnSource).toMatch(/invalid_creation_request_id/);
  });

  it('guest identity is server-resolved and the Mollie metadata uses the RPC-returned ids', () => {
    expect(fnSource).toContain('resolvePlayerForCheckout(');
    // ...and "server-resolved" now means CREATED through the one command, answering with the
    // canonical person only — the legacy booking column is derived by the service adapter inside
    // this process (U2, owner correction 2026-08-09).
    expect(readFileSync(
      join(process.cwd(), 'supabase', 'functions', '_shared', 'guest-players.ts'), 'utf8',
    )).toContain('player_create_command');
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
