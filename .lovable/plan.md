

# Comprehensive Legacy & Obsolete Code Analysis

After a thorough review of the codebase, I've identified multiple categories of legacy code, broken functionality, and unnecessary complexity.

---

## Critical Issues (Breaking Functionality)

### 1. Missing Edge Functions Called by Frontend

The following edge functions are invoked by frontend code but **do not exist**:

| Edge Function | Called From | Impact |
|---------------|-------------|--------|
| `check-trainer-subscription` | `src/hooks/useAuth.tsx:77` | **CRITICAL**: Trainer subscription checking fails for all trainers |
| `create-academy-mollie-subscription` | `src/lib/academySubscription.ts:55` | Academy checkout will fail |

**Action Required**: 
- Create `check-trainer-subscription` function or update `useAuth.tsx` to use `check-mollie-subscription` with `type: "trainer"`
- Create `create-academy-mollie-subscription` function (copy pattern from `create-mollie-subscription`)

### 2. Club Subscription Calling Non-Existent Type

The edge functions `check-mollie-subscription` and `cancel-mollie-subscription` were updated to only accept `"trainer"` or `"academy"` types, but `clubSubscription.ts` still calls them with `type: "club"`:

| File | Line | Issue |
|------|------|-------|
| `src/lib/clubSubscription.ts:27` | `type: "club"` | Function will throw "Invalid type" error |
| `src/lib/clubSubscription.ts:76` | `type: "club"` | Function will throw "Invalid type" error |

**Action Required**: Add `type === "club"` case back to the edge functions OR update clubs to use a different subscription pattern.

---

## High Priority Cleanup

### 3. Orphaned Edge Function References in config.toml

The `supabase/config.toml` contains references to edge functions that **no longer exist** (deleted during Stripe→Mollie migration):

```text
Lines 4-54 contain references to deleted Stripe functions:
- [functions.create-checkout-session]
- [functions.verify-payment]
- [functions.connect-trainer]
- [functions.check-connect-status]
- [functions.create-trainer-checkout]
- [functions.check-trainer-subscription]
- [functions.customer-portal]
- [functions.create-club-checkout]
- [functions.check-club-subscription]
- [functions.club-customer-portal]
- [functions.connect-club]
- [functions.check-club-connect-status]
- [functions.mollie-connect-club] (line 101)
- [functions.create-club-mollie-subscription] (line 122)
```

**Action Required**: Clean up `supabase/config.toml` to remove references to non-existent functions.

### 4. Stripe productId/priceId Constants Still in Use

Even after the Mollie migration, the code still contains **hardcoded Stripe product IDs** that are being used:

| File | Lines | Issue |
|------|-------|-------|
| `src/lib/subscription.ts:21-38` | `priceIdMonthly: 'price_1Spz9V...'`, `productIdMonthly: 'prod_TnaK...'` | Stripe IDs hardcoded |
| `src/lib/subscription.ts:54-67` | `getTierFromProductId()` | Compares against Stripe product IDs |
| `src/hooks/useAuth.tsx:99` | `getTierFromProductId(data.product_id)` | Uses Stripe-based tier detection |

The `getTierFromProductId` function is called to determine subscription tiers but relies on Stripe product IDs that Mollie doesn't use.

**Action Required**: 
- Update tier detection to use `subscription_tier` from the database (already stored)
- Remove Stripe IDs from `SUBSCRIPTION_TIERS` or replace with Mollie equivalents from the `pricing_plans` table

### 5. STRIPE_SECRET_KEY Still Present

The secret `STRIPE_SECRET_KEY` is still configured (marked as "cannot be deleted"). While not used, it should be removed for security hygiene.

**Action Required**: Remove via workspace admin settings (cannot be done via code).

---

## Medium Priority Cleanup

### 6. Club Payment UI Translations Still Present

Even though club Mollie Connect was removed, the translation files still contain club payment UI strings:

| File | Lines | Content |
|------|-------|---------|
| `src/i18n/locales/en/club.json` | 263-285 | `mollieConnect`, `paymentsEnabled`, `payoutsEnabled`, etc. |
| `src/i18n/locales/nl/club.json` | 263-285 | Same keys in Dutch |

**Action Required**: Remove unused `settings.mollieConnect*` translation keys from club locale files.

### 7. Legacy Route Duplication

The `DomainRouter.tsx` defines routes twice - once in the trainer layout and once as "legacy routes":

```typescript
// Lines 205-217: Legacy routes that duplicate trainer routes
<Route path="/lessons" element={<ManageLessons />} />
<Route path="/availability" element={<TrainerCalendar />} />
<Route path="/schedule" element={<TrainerCalendar />} />
<Route path="/trainer-bookings" element={<TrainerBookings />} />
<Route path="/earnings" element={<TrainerEarnings />} />
<Route path="/subscription" element={<TrainerSubscription />} />
<Route path="/analytics" element={<TrainerAnalytics />} />
```

These duplicate routes that already exist under `/trainer/*`. This also exists in lines 313-325.

**Action Required**: Convert legacy routes to `<Navigate>` redirects instead of duplicating components.

### 8. Unused Pages (ManageSchedule, ManageAvailability)

Two large pages exist but may be unused:

| Page | Lines | Status |
|------|-------|--------|
| `src/pages/ManageSchedule.tsx` | 741 lines | Has working hours + bulk slots - overlaps with TrainerCalendar |
| `src/pages/ManageAvailability.tsx` | 521 lines | Individual slot management - not referenced in navigation |

**Action Required**: 
- Audit if these pages are still accessed (they're only accessible via legacy `/schedule` and `/availability` routes which point to `TrainerCalendar`)
- Consider removing if unused

---

## Lower Priority (Technical Debt)

### 9. Stripe Type References in Supabase Types

The auto-generated `src/integrations/supabase/types.ts` contains references to `stripe_accounts` foreign keys:

```typescript
foreignKeyName: "academy_stripe_accounts_academy_profile_id_fkey"
foreignKeyName: "club_stripe_accounts_club_profile_id_fkey"
foreignKeyName: "trainer_stripe_accounts_trainer_id_fkey"
```

These reflect the database foreign key constraints that weren't renamed during migration.

**Action Required**: Database migration to rename foreign key constraints (optional - cosmetic only).

### 10. TrainerDashboard Complexity

At 1156 lines, `TrainerDashboard.tsx` is significantly larger than other dashboards (Club: ~156, Academy: ~186). It includes:
- Full calendar grid
- Setup checklist component
- Trial banner component
- Multiple dialog states

**Action Required**: Extract components:
- `TrainerSetupChecklist` component
- `TrainerTrialBanner` component
- Move calendar logic to use existing `TrainerCalendarGrid`

---

## Summary: Cleanup Actions

### Immediate (Fix breaking functionality)
1. **Update `useAuth.tsx`** to use `check-mollie-subscription` with `type: "trainer"` instead of `check-trainer-subscription`
2. **Add `type === "club"` support back** to `check-mollie-subscription` and `cancel-mollie-subscription` (for club subscriptions - not payments)
3. **Create `create-academy-mollie-subscription`** edge function for academy checkout

### High Priority (Remove obsolete code)
4. Clean up `supabase/config.toml` - remove 14+ non-existent function references
5. Remove/update Stripe productId constants in `subscription.ts`
6. Update `getTierFromProductId` to use database tier values

### Medium Priority (Reduce complexity)
7. Remove unused club payment translations
8. Convert legacy routes to redirects
9. Audit ManageSchedule/ManageAvailability pages for removal

### Lower Priority (Technical debt)
10. Extract TrainerDashboard components
11. Rename database foreign key constraints

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/hooks/useAuth.tsx` | Change `check-trainer-subscription` to `check-mollie-subscription` with `type: "trainer"` |
| `supabase/functions/check-mollie-subscription/index.ts` | Add `type === "club"` case |
| `supabase/functions/cancel-mollie-subscription/index.ts` | Add `type === "club"` case |
| `src/lib/subscription.ts` | Remove Stripe IDs, update tier detection |
| `supabase/config.toml` | Remove orphaned function configs |
| `src/i18n/locales/en/club.json` | Remove unused mollieConnect keys |
| `src/i18n/locales/nl/club.json` | Remove unused mollieConnect keys |

## New Files to Create

| File | Purpose |
|------|---------|
| `supabase/functions/create-academy-mollie-subscription/index.ts` | Academy subscription checkout |

