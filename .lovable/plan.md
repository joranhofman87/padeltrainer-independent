

# Updated Migration Plan: Stripe to Mollie Partner

## What Changes with Mollie Partner

Becoming a Mollie Partner gives you access to:
- **Client ID & Client Secret** for OAuth Connect flow
- **Organization API** to manage connected accounts (trainers/clubs)
- **Routing** for split payments to connected organizations

### Requirements to Become a Mollie Partner

1. Apply at [mollie.com/partners](https://www.mollie.com/partners)
2. Once approved, you'll receive:
   - Partner Client ID
   - Partner Client Secret
   - Your Platform Profile ID

### Secrets You'll Need

| Secret | Source | Purpose |
|--------|--------|---------|
| `MOLLIE_API_KEY` | Your Mollie Dashboard | Platform-level API calls |
| `MOLLIE_PROFILE_ID` | Your Mollie Dashboard | Identify your platform |
| `MOLLIE_CLIENT_ID` | After Partner approval | OAuth Connect for trainers |
| `MOLLIE_CLIENT_SECRET` | After Partner approval | OAuth Connect for trainers |

---

## Implementation Timeline

### Phase 0: Partner Application (External)
- Apply for Mollie Partner status
- Wait for approval (typically 1-2 weeks)
- Receive OAuth credentials

### Phase 1: Database Migration (Day 1-2)

Rename tables and add Mollie-specific columns:

```sql
-- Rename trainer accounts
ALTER TABLE trainer_stripe_accounts RENAME TO trainer_mollie_accounts;
ALTER TABLE trainer_mollie_accounts 
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- Rename club accounts  
ALTER TABLE club_stripe_accounts RENAME TO club_mollie_accounts;
ALTER TABLE club_mollie_accounts
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- Add OAuth token storage (Mollie requires storing tokens)
ALTER TABLE trainer_mollie_accounts
  ADD COLUMN access_token TEXT,
  ADD COLUMN refresh_token TEXT,
  ADD COLUMN token_expires_at TIMESTAMPTZ;

ALTER TABLE club_mollie_accounts
  ADD COLUMN access_token TEXT,
  ADD COLUMN refresh_token TEXT,
  ADD COLUMN token_expires_at TIMESTAMPTZ;

-- Update bookings table
ALTER TABLE bookings
  RENAME COLUMN stripe_session_id TO mollie_payment_id;
ALTER TABLE bookings  
  RENAME COLUMN stripe_payment_intent_id TO mollie_transaction_id;
```

### Phase 2: Mollie Connect Edge Functions (Day 3-5)

Create new edge functions for OAuth-based onboarding:

| New Function | Purpose |
|--------------|---------|
| `mollie-connect-trainer` | Generate OAuth URL for trainer onboarding |
| `mollie-connect-club` | Generate OAuth URL for club onboarding |
| `mollie-callback` | Handle OAuth callback, store tokens |
| `check-mollie-connect-status` | Verify trainer/club connection status |

### Phase 3: Payment Edge Functions (Day 6-8)

| New Function | Replaces | Purpose |
|--------------|----------|---------|
| `create-mollie-payment` | `create-checkout-session` | Create payment with split routing |
| `mollie-webhook` | Stripe webhook handling | Handle payment status updates |
| `verify-mollie-payment` | `verify-payment` | Confirm payment success |

### Phase 4: Subscription Edge Functions (Day 9-12)

| New Function | Replaces | Purpose |
|--------------|----------|---------|
| `create-mollie-subscription` | `create-trainer-checkout` | First payment + recurring setup |
| `create-club-mollie-subscription` | `create-club-checkout` | Club subscription |
| `check-mollie-subscription` | `check-trainer-subscription` | Verify subscription status |
| `cancel-mollie-subscription` | `customer-portal` | Cancel recurring billing |

**Note:** Mollie has no hosted Customer Portal, so we'll build custom subscription management UI.

### Phase 5: Frontend Updates (Day 13-14)

| File | Changes |
|------|---------|
| `src/lib/payments.ts` | New Mollie payment helpers |
| `src/lib/subscription.ts` | Update tier mappings |
| `src/pages/TrainerEarnings.tsx` | Mollie Connect button |
| `src/pages/BookLesson.tsx` | Create Mollie payment |
| `src/pages/BookingSuccess.tsx` | Verify Mollie payment |
| `src/pages/TrainerSubscription.tsx` | Custom billing portal |
| `src/pages/club/ClubSubscription.tsx` | Custom billing portal |

### Phase 6: Testing (Day 15-16)

Test with Mollie test mode using test API key.

---

## Action Items Before Starting

1. **Apply for Mollie Partner** - Visit mollie.com/partners
2. **Once approved**, add these secrets:
   - `MOLLIE_API_KEY` (your platform API key)
   - `MOLLIE_PROFILE_ID` (your platform profile)
   - `MOLLIE_CLIENT_ID` (Partner OAuth)
   - `MOLLIE_CLIENT_SECRET` (Partner OAuth)

3. **Start implementation** once credentials are available

---

## Summary

| Phase | Days | Status |
|-------|------|--------|
| 0. Partner Application | External | ✅ Complete |
| 1. Database Migration | 1-2 | ✅ Complete |
| 2. Mollie Connect | 3-5 | ✅ Complete |
| 3. Payment Functions | 6-8 | ✅ Complete |
| 4. Subscription Functions | 9-12 | ✅ Complete |
| 5. Frontend Updates | 13-14 | 🔄 Next |
| 6. Testing | 15-16 | Final phase |

**Next Step:** Implement Phase 5 - Frontend updates to use new Mollie functions (TrainerEarnings, BookLesson, BookingSuccess, TrainerSubscription, ClubSubscription pages).

