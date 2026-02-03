
# Complete Migration Plan: Stripe to Mollie

## Executive Summary

This plan outlines a comprehensive migration from Stripe to Mollie for all payment processing in the PadelTrainer platform. The migration covers three distinct payment use cases:

1. **Player-to-Trainer/Club Payments** (lesson bookings with marketplace split)
2. **Trainer Subscriptions** (platform subscriptions for trainers)
3. **Club Subscriptions** (platform subscriptions for clubs)

**Estimated effort**: 12-16 days
**Risk level**: High (payment system is business-critical)

---

## Current Stripe Integration Scope

### Edge Functions to Migrate (15 functions)

| Function | Purpose | Mollie Equivalent |
|----------|---------|-------------------|
| `create-checkout-session` | Lesson payment with split | Mollie Payment API with routing |
| `verify-payment` | Confirm payment success | Mollie Payment status check |
| `connect-trainer` | Trainer Stripe Connect onboarding | Mollie Connect OAuth flow |
| `check-connect-status` | Check trainer payment account | Mollie Organizations API |
| `connect-club` | Club Stripe Connect onboarding | Mollie Connect OAuth flow |
| `check-club-connect-status` | Check club payment account | Mollie Organizations API |
| `create-trainer-checkout` | Trainer subscription checkout | Mollie Subscriptions API |
| `check-trainer-subscription` | Verify trainer subscription | Mollie Subscriptions API |
| `create-club-checkout` | Club subscription checkout | Mollie Subscriptions API |
| `check-club-subscription` | Verify club subscription | Mollie Subscriptions API |
| `customer-portal` | Manage trainer billing | Custom portal (Mollie has no hosted portal) |
| `club-customer-portal` | Manage club billing | Custom portal (Mollie has no hosted portal) |
| `generate-invoice` | PDF invoice generation | Keep as-is (not Stripe-dependent) |

### Database Tables Affected

| Table | Changes Required |
|-------|------------------|
| `trainer_stripe_accounts` | Rename to `trainer_mollie_accounts`, change `stripe_account_id` to `mollie_organization_id` |
| `club_stripe_accounts` | Rename to `club_mollie_accounts`, change `stripe_account_id` to `mollie_organization_id` |
| `subscription_plans` | Change `stripe_*` columns to `mollie_*` (price/product IDs) |
| `bookings` | Change `stripe_session_id` to `mollie_payment_id`, `stripe_payment_intent_id` to `mollie_transaction_id` |
| `club_profiles` | Change `stripe_customer_id` to `mollie_customer_id` |

### Frontend Files Affected

| File | Changes |
|------|---------|
| `src/lib/clubPayments.ts` | Rename functions, update types |
| `src/lib/clubTrainerPayments.ts` | Update Mollie references |
| `src/lib/subscription.ts` | Update tier mappings to Mollie products |
| `src/lib/clubSubscription.ts` | Update to Mollie subscription IDs |
| `src/pages/TrainerEarnings.tsx` | Update Connect flow, balance display |
| `src/pages/BookLesson.tsx` | Update payment flow |
| `src/pages/BookingSuccess.tsx` | Update verification |
| `src/pages/club/ClubSettings.tsx` | Update Connect flow |
| `src/pages/TrainerSubscription.tsx` | Update subscription flow |
| `src/pages/club/ClubSubscription.tsx` | Update subscription flow |
| `src/components/admin/PlanEditDialog.tsx` | Update price ID fields |

---

## Key Technical Differences: Stripe vs Mollie

| Feature | Stripe | Mollie |
|---------|--------|--------|
| **SDK** | Official Deno ESM module | No official Deno SDK (use REST API) |
| **Marketplace onboarding** | Hosted Express onboarding | OAuth 2.0 flow (more manual) |
| **Split payments** | `application_fee` on direct charges | `routing` array in payment request |
| **Subscriptions** | Built-in recurring billing | Mollie Subscriptions API |
| **Customer portal** | Hosted billing portal | Must build custom UI |
| **Payment methods** | iDEAL, Bancontact, Card | iDEAL, Bancontact, Card (same coverage) |
| **Webhooks** | Required for async updates | Required for async updates |
| **Testing** | Test mode with sk_test_ keys | Test mode with test_ API key |

---

## Phase 1: Mollie Connect for Trainers/Clubs (Days 1-5)

### 1.1 Database Migration

```sql
-- Rename trainer accounts table
ALTER TABLE trainer_stripe_accounts 
  RENAME TO trainer_mollie_accounts;

ALTER TABLE trainer_mollie_accounts
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- Rename club accounts table
ALTER TABLE club_stripe_accounts 
  RENAME TO club_mollie_accounts;

ALTER TABLE club_mollie_accounts
  RENAME COLUMN stripe_account_id TO mollie_organization_id;

-- Add OAuth tokens storage (Mollie requires storing refresh tokens)
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

### 1.2 New Edge Function: `mollie-connect-trainer`

OAuth 2.0 flow for trainer onboarding:

```typescript
// supabase/functions/mollie-connect-trainer/index.ts
import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const MOLLIE_CLIENT_ID = Deno.env.get("MOLLIE_CLIENT_ID");
const MOLLIE_CLIENT_SECRET = Deno.env.get("MOLLIE_CLIENT_SECRET");

serve(async (req) => {
  // Generate OAuth authorization URL
  const state = crypto.randomUUID();
  const redirectUri = `${origin}/api/mollie-callback`;
  
  const authUrl = new URL("https://my.mollie.com/oauth2/authorize");
  authUrl.searchParams.set("client_id", MOLLIE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", "payments.read payments.write organizations.read");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("approval_prompt", "auto");
  
  // Store state in database for verification
  // ...
  
  return new Response(JSON.stringify({ url: authUrl.toString() }), { ... });
});
```

### 1.3 New Edge Function: `mollie-callback`

Handle OAuth callback and store tokens:

```typescript
serve(async (req) => {
  const { code, state } = await req.json();
  
  // Exchange code for tokens
  const tokenResponse = await fetch("https://api.mollie.com/oauth2/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: MOLLIE_CLIENT_ID,
      client_secret: MOLLIE_CLIENT_SECRET,
    }),
  });
  
  const tokens = await tokenResponse.json();
  // Store tokens in trainer_mollie_accounts
  // ...
});
```

### 1.4 New Edge Function: `check-mollie-connect-status`

Replace Stripe Connect status check:

```typescript
serve(async (req) => {
  // Get stored access token
  const { data: mollieAccount } = await supabaseClient
    .from('trainer_mollie_accounts')
    .select('*')
    .eq('trainer_id', trainerProfile.id)
    .single();
  
  if (!mollieAccount?.access_token) {
    return new Response(JSON.stringify({ connected: false }));
  }
  
  // Verify token is still valid, refresh if needed
  // Get organization info from Mollie
  const orgResponse = await fetch("https://api.mollie.com/v2/organizations/me", {
    headers: { Authorization: `Bearer ${mollieAccount.access_token}` }
  });
  
  // Return connection status
  // ...
});
```

---

## Phase 2: Lesson Payments with Split (Days 6-8)

### 2.1 New Edge Function: `create-mollie-payment`

Replace `create-checkout-session`:

```typescript
serve(async (req) => {
  const { bookingId, lessonTitle, price, trainerId, slotId } = await req.json();
  
  // Determine if club or trainer payment
  const connectedOrgId = await getConnectedOrganizationId(trainerId, slotId);
  const platformFee = calculatePlatformFee(price, tier);
  
  // Create payment with split
  const payment = await fetch("https://api.mollie.com/v2/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MOLLIE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: { currency: "EUR", value: price.toFixed(2) },
      description: lessonTitle,
      redirectUrl: `${origin}/booking-success?booking_id=${bookingId}`,
      webhookUrl: `${SUPABASE_URL}/functions/v1/mollie-webhook`,
      method: ["ideal", "bancontact", "creditcard"],
      metadata: { booking_id: bookingId, trainer_id: trainerId },
      routing: [
        {
          amount: {
            currency: "EUR",
            value: (price - platformFee).toFixed(2)
          },
          destination: {
            type: "organization",
            organizationId: connectedOrgId
          }
        }
      ]
    }),
  });
  
  const paymentData = await payment.json();
  
  // Update booking with payment ID
  await supabaseClient
    .from('bookings')
    .update({ mollie_payment_id: paymentData.id })
    .eq('id', bookingId);
  
  return new Response(JSON.stringify({ 
    url: paymentData._links.checkout.href 
  }));
});
```

### 2.2 New Edge Function: `mollie-webhook`

Handle payment status updates:

```typescript
serve(async (req) => {
  const { id: paymentId } = await req.json();
  
  // Fetch payment status from Mollie
  const payment = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` }
  });
  const paymentData = await payment.json();
  
  if (paymentData.status === "paid") {
    const bookingId = paymentData.metadata.booking_id;
    
    await supabaseClient
      .from('bookings')
      .update({
        payment_status: 'paid',
        status: 'confirmed',
        mollie_transaction_id: paymentData.id,
        payment_amount: parseFloat(paymentData.amount.value),
        paid_at: new Date().toISOString(),
      })
      .eq('id', bookingId);
    
    // Send confirmation emails...
  }
});
```

### 2.3 Update `verify-payment` Edge Function

Simplified verification (webhook handles most work):

```typescript
serve(async (req) => {
  const { bookingId } = await req.json();
  
  // Get booking with payment ID
  const { data: booking } = await supabaseClient
    .from('bookings')
    .select('mollie_payment_id, payment_status')
    .eq('id', bookingId)
    .single();
  
  if (booking?.payment_status === 'paid') {
    return new Response(JSON.stringify({ paid: true }));
  }
  
  // Double-check with Mollie API
  const payment = await fetch(
    `https://api.mollie.com/v2/payments/${booking.mollie_payment_id}`,
    { headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` } }
  );
  const paymentData = await payment.json();
  
  return new Response(JSON.stringify({ 
    paid: paymentData.status === "paid" 
  }));
});
```

---

## Phase 3: Subscriptions (Days 9-12)

### 3.1 Database: Update subscription_plans

```sql
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_price_id_monthly TO mollie_plan_id_monthly;
  
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_price_id_yearly TO mollie_plan_id_yearly;
  
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_product_id_monthly TO mollie_product_id_monthly;
  
ALTER TABLE subscription_plans
  RENAME COLUMN stripe_product_id_yearly TO mollie_product_id_yearly;

-- Add Mollie customer IDs to profiles
ALTER TABLE trainer_profiles
  ADD COLUMN mollie_customer_id TEXT;
  
ALTER TABLE club_profiles
  RENAME COLUMN stripe_customer_id TO mollie_customer_id;
```

### 3.2 New Edge Function: `create-mollie-subscription`

```typescript
serve(async (req) => {
  const { planId, interval } = await req.json();
  
  // Get or create Mollie customer
  let customerId = trainerProfile.mollie_customer_id;
  
  if (!customerId) {
    const customer = await fetch("https://api.mollie.com/v2/customers", {
      method: "POST",
      headers: { 
        Authorization: `Bearer ${MOLLIE_API_KEY}`,
        "Content-Type": "application/json" 
      },
      body: JSON.stringify({
        name: profile.full_name,
        email: profile.email,
        metadata: { user_id: user.id }
      }),
    });
    customerId = (await customer.json()).id;
    
    // Store customer ID
    await supabaseClient
      .from('trainer_profiles')
      .update({ mollie_customer_id: customerId })
      .eq('id', trainerProfile.id);
  }
  
  // Create first payment for mandate
  const payment = await fetch("https://api.mollie.com/v2/payments", {
    method: "POST",
    headers: { 
      Authorization: `Bearer ${MOLLIE_API_KEY}`,
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({
      amount: plan.monthly_price,
      customerId,
      sequenceType: "first",
      description: `${plan.name} Subscription`,
      redirectUrl: `${origin}/subscription?success=true`,
      webhookUrl: `${SUPABASE_URL}/functions/v1/mollie-subscription-webhook`,
      metadata: { plan_id: planId, interval }
    }),
  });
  
  return new Response(JSON.stringify({ 
    url: (await payment.json())._links.checkout.href 
  }));
});
```

### 3.3 New Edge Function: `mollie-subscription-webhook`

Handle subscription creation after first payment:

```typescript
serve(async (req) => {
  const { id: paymentId } = await req.json();
  
  const payment = await fetchMolliePayment(paymentId);
  
  if (payment.status === "paid" && payment.sequenceType === "first") {
    // Create recurring subscription
    const subscription = await fetch(
      `https://api.mollie.com/v2/customers/${payment.customerId}/subscriptions`,
      {
        method: "POST",
        headers: { 
          Authorization: `Bearer ${MOLLIE_API_KEY}`,
          "Content-Type": "application/json" 
        },
        body: JSON.stringify({
          amount: payment.amount,
          interval: payment.metadata.interval === "yearly" ? "12 months" : "1 month",
          description: `Trainer Subscription`,
          webhookUrl: `${SUPABASE_URL}/functions/v1/mollie-subscription-webhook`,
        }),
      }
    );
    
    // Update trainer profile with subscription status
    // ...
  }
});
```

### 3.4 Custom Subscription Portal

Since Mollie has no hosted billing portal, build a custom page:

```typescript
// src/pages/TrainerSubscriptionManage.tsx

export default function TrainerSubscriptionManage() {
  // Fetch subscription from Mollie via edge function
  // Display current plan, next billing date
  // Options: Cancel, Change Plan
  
  const handleCancel = async () => {
    await supabase.functions.invoke('cancel-mollie-subscription');
    // ...
  };
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>Manage Subscription</CardTitle>
      </CardHeader>
      <CardContent>
        <div>Current Plan: {subscription.plan}</div>
        <div>Next Billing: {subscription.nextBillingDate}</div>
        <Button variant="destructive" onClick={handleCancel}>
          Cancel Subscription
        </Button>
      </CardContent>
    </Card>
  );
}
```

---

## Phase 4: Frontend Updates (Days 13-14)

### 4.1 Update Payment Libraries

```typescript
// src/lib/molliePayments.ts (renamed from clubPayments.ts)
export interface MollieConnectStatus {
  connected: boolean;
  organizationId?: string;
  organizationName?: string;
  // ...
}

export async function connectMollie(trainerId: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('mollie-connect-trainer', {
    body: { trainerId },
  });
  return data.url;
}

export async function checkMollieConnectStatus(trainerId: string): Promise<MollieConnectStatus> {
  const { data, error } = await supabase.functions.invoke('check-mollie-connect-status', {
    body: { trainerId },
  });
  return data;
}
```

### 4.2 Update TrainerEarnings Page

- Replace Stripe Connect button with Mollie Connect button
- Update balance display (Mollie API for payouts)
- Update status indicators

### 4.3 Update BookLesson Page

```typescript
// Change from:
const { data: checkoutData } = await supabase.functions.invoke('create-checkout-session', ...);

// To:
const { data: checkoutData } = await supabase.functions.invoke('create-mollie-payment', ...);
```

### 4.4 Update BookingSuccess Page

```typescript
// Change from:
const { data } = await supabase.functions.invoke('verify-payment', {
  body: { sessionId, bookingId, connectedAccountId },
});

// To:
const { data } = await supabase.functions.invoke('verify-mollie-payment', {
  body: { bookingId },
});
```

---

## Phase 5: Testing & Deployment (Days 15-16)

### 5.1 Test Mode Configuration

1. Create Mollie test account
2. Get test API keys (`test_xxxxx`)
3. Add to secrets: `MOLLIE_API_KEY`, `MOLLIE_CLIENT_ID`, `MOLLIE_CLIENT_SECRET`

### 5.2 Test Scenarios

| Scenario | Test Steps |
|----------|------------|
| Trainer onboarding | Complete OAuth flow, verify organization stored |
| iDEAL payment | Book lesson, pay with iDEAL test bank |
| Split routing | Verify platform fee deducted, trainer receives amount |
| Subscription create | Subscribe, verify first payment + recurring |
| Subscription cancel | Cancel via custom portal, verify status |
| Webhook reliability | Simulate delayed webhooks, verify idempotency |

### 5.3 Migration Checklist

- [ ] All edge functions deployed and tested
- [ ] Database migration applied
- [ ] Frontend updated and tested
- [ ] Mollie production API keys configured
- [ ] Webhook URLs verified
- [ ] Old Stripe functions deprecated (not deleted yet)
- [ ] Monitoring for payment failures set up

---

## New Secrets Required

| Secret Name | Purpose |
|-------------|---------|
| `MOLLIE_API_KEY` | API authentication (live key) |
| `MOLLIE_CLIENT_ID` | OAuth Connect client ID |
| `MOLLIE_CLIENT_SECRET` | OAuth Connect client secret |
| `MOLLIE_PARTNER_ID` | For marketplace/platform features |

---

## Rollback Plan

If issues arise after deployment:

1. Keep Stripe edge functions as backup (renamed with `_deprecated` suffix)
2. Maintain Stripe API key in secrets
3. Database columns can coexist (both `mollie_*` and `stripe_*` during transition)
4. Feature flag to switch payment provider if needed

---

## Summary

| Phase | Days | Deliverables |
|-------|------|--------------|
| 1. Mollie Connect | 1-5 | Trainer/Club onboarding via OAuth |
| 2. Lesson Payments | 6-8 | Payment creation, webhooks, verification |
| 3. Subscriptions | 9-12 | Recurring billing, custom portal |
| 4. Frontend | 13-14 | All UI components updated |
| 5. Testing | 15-16 | End-to-end testing, deployment |

**Total: 16 days**

This migration preserves all existing functionality while switching the payment processor. The main additional work is building a custom subscription management portal since Mollie doesn't offer a hosted solution like Stripe's Customer Portal.
