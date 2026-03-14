
# Migrate Platform Subscriptions from Mollie to Stripe

## Status: ✅ COMPLETED

Migration completed on 2026-03-14.

## What was done

### Phase 1: Stripe Products & Prices ✅
Created all missing Stripe products and prices:
- **Starter**: prod_U96I8IfrCKG4LU (€9/mo: price_1TAo5cPxAlHS6UZHBS3lZ5lo, €75.60/yr: price_1TAo67PxAlHS6UZHgmn9Tq4x)
- **Professional**: prod_TnaKMqklQL0csZ (€29/mo: price_1Spz9VPxAlHS6UZH9wmgdECd, €278/yr: price_1Spz9uPxAlHS6UZHMaZfUTBY)
- **Academy**: prod_TnaKlteqteiFWb (€79/mo: price_1SpzA8PxAlHS6UZHKsoY94qK, €758/yr: price_1SpzAdPxAlHS6UZHKjhjq8Ey)
- **Club**: prod_TpSG6xKQWRccLA + prod_U96IiK6uDt4WHZ (€19/mo: price_1TAo6KPxAlHS6UZHg228uEB9, €2388/yr: price_1SrnLWPxAlHS6UZHnPt93ego)

### Phase 2: Database Changes ✅
- Added `stripe_customer_id` to `trainer_profiles`, `club_profiles`, `academy_profiles`
- Added `stripe_price_id_monthly` and `stripe_price_id_yearly` to `subscription_plans`
- Populated all Stripe price IDs in the subscription_plans table

### Phase 3: Edge Functions ✅
Created 5 new Stripe-based edge functions:
1. **`create-stripe-checkout`** — Unified checkout for trainers, clubs, academies
2. **`check-stripe-subscription`** — Checks subscription status via Stripe API
3. **`cancel-stripe-subscription`** — Cancels at period end via Stripe
4. **`stripe-subscription-webhook`** — Handles checkout.session.completed, invoice.paid/failed, subscription.deleted
5. **`customer-portal`** — Stripe Customer Portal for self-service management

### Phase 4: Frontend Updates ✅
Updated all frontend files to call Stripe functions:
- `src/hooks/useAuth.tsx` → `check-stripe-subscription`
- `src/pages/TrainerSubscription.tsx` → `create-stripe-checkout` + `cancel-stripe-subscription`
- `src/lib/clubSubscription.ts` → `create-stripe-checkout` + `check-stripe-subscription` + `cancel-stripe-subscription`
- `src/lib/academySubscription.ts` → same

## What stays unchanged
- **Mollie Connect** for player payments (lesson bookings)
- **Trial logic** — same durations
- **Admin overrides** — manual `subscription_status = 'active'`
- Old Mollie subscription functions kept for backward compatibility

## TODO (post-migration)
- [ ] Set up Stripe webhook endpoint URL in Stripe Dashboard pointing to `stripe-subscription-webhook`
- [ ] Configure Stripe Customer Portal settings in Stripe Dashboard
- [ ] Add STRIPE_WEBHOOK_SECRET for signature verification
- [ ] Monitor and deprecate old Mollie subscription functions after transition period
- [ ] Update `reconcile-subscriptions` cron job or retire it
