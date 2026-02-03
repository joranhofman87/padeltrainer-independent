# Legacy Code Cleanup - COMPLETED

## Summary of Changes Made

All critical and high-priority cleanup tasks have been implemented.

---

## ✅ Completed Tasks

### 1. Fixed Missing Edge Functions (CRITICAL)
- **`useAuth.tsx`**: Changed from `check-trainer-subscription` to `check-mollie-subscription` with `type: "trainer"`
- **Created `create-academy-mollie-subscription`**: New edge function for academy subscription checkout

### 2. Restored Club Subscription Support (CRITICAL)
- **`check-mollie-subscription`**: Added `type === "club"` case for club subscriptions
- **`cancel-mollie-subscription`**: Added `type === "club"` case for club subscriptions

### 3. Cleaned Up config.toml
- Removed all 14+ orphaned references to deleted Stripe functions
- Only active Mollie functions remain

### 4. Removed Stripe Product IDs
- **`src/lib/subscription.ts`**: Removed hardcoded Stripe `priceId` and `productId` values
- **`getTierFromProductId`**: Deprecated function (returns 'trial' - tier now comes from database)
- Subscription tier is now database-driven via `subscription_tier` field

### 5. Removed Unused Club Payment Translations
- **`en/club.json`**: Removed `settings.mollieConnect*` keys (23 keys removed)
- **`nl/club.json`**: Removed same keys in Dutch

### 6. Converted Legacy Routes to Redirects
- **`DomainRouter.tsx`**: Changed legacy routes from duplicating components to using `<Navigate>` redirects
- Routes now redirect to their canonical paths under `/trainer/*` or `/player/*`

---

## Remaining Items (Lower Priority)

These items were identified but not addressed in this cleanup:

### Technical Debt
1. **TrainerDashboard Complexity** (1156 lines) - Could be refactored into smaller components
2. **ManageSchedule.tsx / ManageAvailability.tsx** - May be unused, consider removal after audit
3. **Database foreign key names** - Still named `*_stripe_accounts_*` (cosmetic only)

### Manual Action Required
- **STRIPE_SECRET_KEY**: Still present in secrets (marked "cannot be deleted" - must be removed manually via workspace settings)

---

## Files Modified

| File | Changes |
|------|---------|
| `src/hooks/useAuth.tsx` | Use `check-mollie-subscription` with `type: "trainer"` |
| `supabase/functions/check-mollie-subscription/index.ts` | Added club support |
| `supabase/functions/cancel-mollie-subscription/index.ts` | Added club support |
| `supabase/functions/create-academy-mollie-subscription/index.ts` | NEW - Academy checkout |
| `supabase/config.toml` | Removed orphaned function configs |
| `src/lib/subscription.ts` | Removed Stripe IDs, updated tier detection |
| `src/i18n/locales/en/club.json` | Removed unused mollieConnect keys |
| `src/i18n/locales/nl/club.json` | Removed unused mollieConnect keys |
| `src/components/DomainRouter.tsx` | Legacy routes → redirects |

