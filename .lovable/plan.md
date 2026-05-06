
## Current state

- Invoices to guests do **not** auto-create an auth account. Guests live in `guest_players`. The DB function `link_guest_invoices_on_signup` only links them to a profile *if* they later sign up with the matching email.
- On the public pay page (`PublicInvoicePay.tsx`), the "Log in om je gegevens aan te passen" link sends users to `/app/auth?redirect=...`. After login they would be auth'd but still wouldn't own the invoice (no `playerId` match), so the edit dialog still wouldn't open. Result: a dead end with extra friction.
- Editing only writes to `invoices` (player_business_name / address / btw_number), not to a user profile, so there's no real reason to require auth.

## Goal

Match your stated flow with as little friction as possible: open link → optionally edit details → pay. Account creation becomes an optional step **after** payment.

## Plan

### 1. Allow editing billing details via the public token (no login)

- Add an Edge Function `update-public-invoice-details` (POST, JWT not required) that:
  - Takes `{ publicToken, playerBusinessName, playerAddress, playerBtwNumber }`.
  - Validates token against `invoices.public_token`.
  - Rejects if invoice status is `paid` / `cancelled`.
  - Rate-limited (use existing pattern; e.g. 10 updates / token / hour).
  - Sanitizes/length-limits inputs.
  - Updates the row using the service role.
- Frontend `EditDetailsDialog` no longer needs auth; it calls this function instead of writing directly to `invoices`.

### 2. Redesign the public invoice page as a guided 2-step flow

Keep the same single page (`/academies/{slug}/pay/{token}`) but add a clear stepper at the top so a first-time user always knows what's next:

```text
[ 1 Review & edit details ] ─── [ 2 Pay invoice ]
```

- Step 1 ("Review & edit your details"):
  - Show the To/From/lines block as today.
  - Replace the small grey "Log in om je gegevens aan te passen" link with a primary-styled secondary button: **"Edit billing details"** (always visible, opens the dialog directly).
  - If details are already complete (business name + address present), show a subtle ✓ "Details look good" instead.
- Step 2 ("Pay invoice"):
  - The big "Betaal €X" button stays as today.
  - Add a one-line helper above it: "Looks good? Pay securely below."
- Stepper is purely visual — there's no forced gating; users who just want to pay can scroll straight to the Pay button.

### 3. Post-payment: optional account creation

After Mollie returns success (existing `isSuccessRedirect` and `isPaid` screens), keep the existing `PostPaymentCTA` but reframe the copy as optional:

- Heading: "Payment received ✓"
- Sub: "Want to keep all your invoices in one place? Create a free account (optional)." with the existing Sign up button.
- Skip link: "No thanks, I'm done."

This keeps the funnel friction-free for one-off payers while still nudging account creation when it's most welcome.

### 4. Remove the misleading login link

Delete the "Log in to update your details" anchor in `PlayerDetails`. Anyone with the link can now edit. Owners (logged-in players visiting their own invoice) continue to see the same edit button — no behavior change for them.

### 5. Translations

Add NL + EN strings for:
- Stepper labels (`reviewDetails`, `payInvoice`)
- Detail completeness states (`detailsLookGood`, `editBillingDetails`)
- Optional account CTA (`optionalAccountTitle`, `optionalAccountDescription`, `noThanks`)

## Out of scope

- No password-reset flow (we never created an account, so it's not needed).
- No changes to invoice status, Mollie webhooks, or PDF generation.
- No changes to logged-in player flows other than removing the dead-end login link.

## Technical notes

- New edge function `update-public-invoice-details` registered in `supabase/config.toml` with `verify_jwt = false`.
- Inputs validated with Zod (string length caps, optional fields, BTW format soft-check).
- Reuse existing rate-limit table/pattern used by other public token endpoints.
- Page stepper implemented with semantic tokens (`text-foreground`, `bg-muted`, `text-primary`); no hardcoded colors.
- All new UI strings go through `t()` with NL + EN.
