

# Pass Invoice Context to Player Signup for Account Linking

## Current State
- The database trigger `link_guest_invoices_on_signup` already exists — it matches new signups by email to guest player records and links their invoices automatically.
- **But**: the "Create account" button on the post-payment screen links to `/app/signup/player` with zero context (no email, no name, no redirect).
- The player signup form already reads `useSearchParams()` but doesn't pre-fill from URL params.
- So there's no guarantee the player uses the same email, and they lose their invoice context after signup.

## Changes

### 1. Pass player info via URL params from PostPaymentCTA
**File: `src/pages/PublicInvoicePay.tsx`**

- Pass the invoice data (player name + guest email) into `PostPaymentCTA` as props
- To get the guest email, add `guest_player_id` to the `get-public-invoice` response, then look up the email client-side — **no**, better to just return the guest email from the edge function directly (it's their own invoice page).
- Build the signup link: `/app/signup/player?email={email}&name={name}&redirect=/app/player`

### 2. Return guest email from `get-public-invoice`
**File: `supabase/functions/get-public-invoice/index.ts`**

- The invoice already has `guest_player_id`. Join to `guest_players` table to get the email.
- Add `playerEmail` to the response (only when guest — for registered players the email is already on their profile).

### 3. Pre-fill PlayerSignup form from URL params
**File: `src/pages/PlayerSignup.tsx`**

- Read `email` and `name` from `searchParams`
- Pre-fill `setEmail` and `setFullName` on mount
- This ensures the player signs up with the same email → trigger matches → invoices linked automatically

### 4. Set redirect so player lands on their dashboard after signup
- The existing `redirectAfterOnboarding` localStorage mechanism handles this. Pass `?redirect=/app/player` in the signup URL.

## Files
- `supabase/functions/get-public-invoice/index.ts` — Add guest player email to response
- `src/pages/PublicInvoicePay.tsx` — Pass email + name to PostPaymentCTA, build parameterized signup URL
- `src/pages/PlayerSignup.tsx` — Pre-fill form fields from URL params

