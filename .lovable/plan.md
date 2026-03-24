

# Show "Go to account" for existing players instead of "Create account"

## Problem
The `PostPaymentCTA` component always shows "Create account" regardless of whether the invoice belongs to a registered player (`player_id` is set) or a guest. The `get-public-invoice` response already returns `playerId` — it's just not used.

## Changes

### `src/pages/PublicInvoicePay.tsx`
- Pass `playerId` into `PostPaymentCTA` (it's already in `data.invoice.playerId`)
- If `playerId` exists: show a "Go to my account" button linking to `/app/player` (with `LogIn` icon)
- If no `playerId`: show the existing "Create account" button with signup URL (current behavior)

### Translation keys (`en/common.json`, `nl/common.json`, + `es`, `de`, `fr`)
- Add `invoice.goToMyAccount` — "Go to my account" / "Ga naar mijn account"

### Files
- `src/pages/PublicInvoicePay.tsx` — Conditional CTA based on `playerId`
- `src/i18n/locales/{en,nl,es,de,fr}/common.json` — Add translation key

