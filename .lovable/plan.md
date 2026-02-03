

# Mollie Connect: Shift from Clubs to Academies

## Problem Summary

The current implementation has Mollie Connect for:
- **Trainers** ✅ (should keep)
- **Clubs** ❌ (should NOT collect payments)

The correct model should be:
- **Trainers** - Can collect payments via their own Mollie account
- **Academies** - Can collect payments on behalf of their trainers
- **Clubs** - Do NOT collect payments themselves

When a trainer is part of an academy, payments should route through the academy's Mollie account (with the academy paying trainers separately via salary/contracts).

---

## Current State Analysis

### Existing Club Mollie Infrastructure (to be REMOVED/REPURPOSED)
| Component | File | Action |
|-----------|------|--------|
| `club_mollie_accounts` table | Database | Already exists, could rename to academy or deprecate |
| `mollie-connect-club` | Edge Function | DELETE or repurpose for academy |
| `ClubSettings.tsx` | Mollie Connect UI | REMOVE payment setup section |
| `clubPayments.ts` | Client lib | REMOVE or repurpose |
| `check-mollie-connect-status` | Edge Function | Currently handles `club` type - CHANGE to `academy` |
| `mollie-callback` | Edge Function | Handles `club_` state prefix - CHANGE to `academy_` |

### Academy Mollie Infrastructure (to be CREATED)
| Component | File | Status |
|-----------|------|--------|
| `academy_mollie_accounts` table | Database | ✅ Already exists! |
| `mollie-connect-academy` | Edge Function | ❌ Need to CREATE |
| `AcademySettings.tsx` | Mollie Connect UI | ❌ Need to ADD payment section |
| `academyPayments.ts` | Client lib | ❌ Need to CREATE |
| Payment routing for academy trainers | `create-mollie-payment` | ❌ Need to UPDATE |

### Trainer Payment Logic Changes Needed
When a trainer creates a booking/lesson, the payment should:
1. Check if trainer is part of an active academy (`academy_trainers` table)
2. If YES → Route payment to academy's Mollie account
3. If NO → Route payment to trainer's own Mollie account (existing behavior)

---

## Implementation Plan

### Phase 1: Create Academy Mollie Connect Infrastructure

**1.1 Create `src/lib/academyPayments.ts`**
- Mirror pattern from `clubPayments.ts` but for academies
- Functions: `connectAcademyMollie()`, `checkAcademyConnectStatus()`, `getAcademyMollieAccount()`
- Add `getAcademyMollieAccountForTrainer()` - checks if trainer belongs to an academy and returns academy's Mollie account

**1.2 Create `supabase/functions/mollie-connect-academy/index.ts`**
- Copy from `mollie-connect-club` but adapted for academies
- Verify user is academy manager via `academy_managers` table
- Use `academy_mollie_accounts` table
- State prefix: `academy_{academyProfileId}_{state}`

**1.3 Update `supabase/functions/check-mollie-connect-status/index.ts`**
- Add `entityType === 'academy'` case
- Verify access via `academy_managers` table
- Query `academy_mollie_accounts` table

**1.4 Update `supabase/functions/mollie-callback/index.ts`**
- Add `entityType === 'academy'` case (alongside trainer)
- Update `academy_mollie_accounts` table on successful OAuth

---

### Phase 2: Update Payment Routing for Academy Trainers

**2.1 Update `supabase/functions/create-mollie-payment/index.ts`**

Current flow:
```
1. Check trainer_mollie_accounts for trainer
2. Route payment to trainer's account (if exists)
```

New flow:
```
1. Check if trainer is part of an active academy (academy_trainers)
2. If YES:
   a. Get academy's Mollie account (academy_mollie_accounts)
   b. Route payment to academy's account
   c. Use academy's platform fee tier
3. If NO:
   a. Check trainer_mollie_accounts (existing logic)
   b. Route to trainer's account
```

The `payment_percentage` field in `academy_trainers` is for internal academy-trainer splits, NOT for platform routing. The academy handles paying trainers separately.

---

### Phase 3: Update Academy Settings UI

**3.1 Update `src/pages/academy/AcademySettings.tsx`**
- Add Payment Setup Card (copy pattern from ClubSettings.tsx)
- Connect Academy Mollie button
- Status display (charges enabled, payouts enabled)
- Balance display
- Link to Mollie dashboard

---

### Phase 4: Remove Club Mollie Connect

**4.1 Update `src/pages/club/ClubSettings.tsx`**
- REMOVE the entire "Payment Setup" card section
- Keep only managers section and delete account

**4.2 DELETE `supabase/functions/mollie-connect-club/`**
- This edge function will no longer be needed

**4.3 DELETE or deprecate `src/lib/clubPayments.ts`**
- The `getClubMollieAccountForTrainer` function is no longer needed
- Remove the file entirely

**4.4 Update `supabase/functions/check-mollie-connect-status/index.ts`**
- REMOVE `entityType === 'club'` case

**4.5 Update `supabase/functions/mollie-callback/index.ts`**
- REMOVE `entityType === 'club'` case

---

### Phase 5: Add i18n Translations

**5.1 Update `src/i18n/locales/en/academy.json`**
```json
"settings": {
  "mollieConnect": "Payment Setup",
  "mollieConnectDescription": "Connect your payment account to receive payments from lesson bookings.",
  "notConnected": "Not Connected",
  "notConnectedDescription": "Connect your payment account to receive payments when players book lessons with your trainers.",
  "connectMollie": "Connect Payment Account",
  "paymentsEnabled": "Payments Enabled",
  "paymentsNotEnabled": "Payments Not Yet Enabled",
  "payoutsEnabled": "Payouts Enabled",
  "payoutsNotEnabled": "Payouts Not Yet Enabled",
  "setupIncomplete": "Setup Incomplete",
  "setupIncompleteDescription": "Please complete your payment account setup to start receiving payments.",
  "completeSetup": "Complete Setup",
  "refreshStatus": "Refresh Status",
  "statusRefreshed": "Status Refreshed",
  "statusRefreshedDescription": "Connection status has been updated.",
  "availableBalance": "Available",
  "pendingBalance": "Pending",
  "mollieDashboard": "Payment Dashboard",
  "checkingStatus": "Checking status...",
  "mollieConnectSuccess": "Payment Account Connected",
  "mollieConnectSuccessDescription": "Your payment account has been connected successfully."
}
```

**5.2 Update `src/i18n/locales/nl/academy.json`** (Dutch translations)

---

## Files Summary

### New Files to Create
1. `src/lib/academyPayments.ts` - Academy payment utilities
2. `supabase/functions/mollie-connect-academy/index.ts` - OAuth connect for academies

### Files to Modify
1. `supabase/functions/check-mollie-connect-status/index.ts` - Add academy, remove club
2. `supabase/functions/mollie-callback/index.ts` - Add academy, remove club
3. `supabase/functions/create-mollie-payment/index.ts` - Add academy trainer routing logic
4. `src/pages/academy/AcademySettings.tsx` - Add Payment Setup UI
5. `src/pages/club/ClubSettings.tsx` - Remove Payment Setup UI
6. `src/i18n/locales/en/academy.json` - Add payment translations
7. `src/i18n/locales/nl/academy.json` - Add payment translations

### Files to Delete
1. `supabase/functions/mollie-connect-club/` - No longer needed
2. `src/lib/clubPayments.ts` - No longer needed

---

## Payment Flow Diagram

```text
Player books lesson with Trainer
           │
           ▼
┌────────────────────────────────┐
│ create-mollie-payment function │
└─────────────┬──────────────────┘
              │
              ▼
┌───────────────────────────────────┐
│ Is trainer part of active academy? │
│ (check academy_trainers table)     │
└─────────────┬─────────────────────┘
         │           │
        YES         NO
         │           │
         ▼           ▼
┌────────────────┐  ┌────────────────────┐
│ Get academy's  │  │ Get trainer's      │
│ Mollie account │  │ Mollie account     │
└────────┬───────┘  └──────────┬─────────┘
         │                     │
         ▼                     ▼
┌────────────────────────────────────────┐
│ Route payment with split:              │
│ - Recipient gets (amount - platformFee)│
│ - Platform keeps platformFee           │
└────────────────────────────────────────┘
```

---

## Expected Outcome

| Scenario | Payment Routing |
|----------|-----------------|
| Independent trainer with Mollie connected | → Trainer's Mollie account |
| Independent trainer without Mollie | → Platform (no split) |
| Academy trainer, academy has Mollie | → Academy's Mollie account |
| Academy trainer, academy no Mollie | → Platform (no split) |
| Club trainer | No payment collection at club level |

