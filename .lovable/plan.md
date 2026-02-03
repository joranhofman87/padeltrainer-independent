

# Tiered Flat Fee Implementation

## Overview

This plan changes the platform fee from a **percentage-based model** to a **tiered flat fee** based on subscription level:

| Tier | Current Fee | New Fee |
|------|-------------|---------|
| Starter (Trial) | 5% (hardcoded) | €1.00 per payment |
| Professional | 3% (database) | €0.75 per payment |
| Academy | 2% (database) | €0.50 per payment |

Additionally, admins will be able to **override the fee per trainer or academy** for special arrangements.

---

## Examples

| Lesson Price | Old Fee (5%) | Starter (€1) | Professional (€0.75) | Academy (€0.50) |
|--------------|--------------|--------------|----------------------|-----------------|
| €20 | €1.00 | €1.00 | €0.75 | €0.50 |
| €40 | €2.00 | €1.00 | €0.75 | €0.50 |
| €80 | €4.00 | €1.00 | €0.75 | €0.50 |
| €100 | €5.00 | €1.00 | €0.75 | €0.50 |

---

## Database Changes

### 1. Add Flat Fee Column to subscription_plans

Replace the percentage-based fee with a flat fee amount:

```text
ALTER TABLE subscription_plans 
ADD COLUMN platform_fee_flat NUMERIC(6,2) DEFAULT 1.00;

-- Set values for existing plans
UPDATE subscription_plans SET platform_fee_flat = 1.00 WHERE tier = 'starter';
UPDATE subscription_plans SET platform_fee_flat = 0.75 WHERE tier = 'professional';
UPDATE subscription_plans SET platform_fee_flat = 0.50 WHERE tier = 'academy';
```

### 2. Add Override Column to trainer_profiles

Allow per-trainer fee customization:

```text
ALTER TABLE trainer_profiles 
ADD COLUMN platform_fee_override NUMERIC(6,2) DEFAULT NULL;

COMMENT ON COLUMN trainer_profiles.platform_fee_override IS 
  'Custom platform fee for this trainer. If NULL, uses tier default.';
```

### 3. Add Override Column to academy_profiles

Allow per-academy fee customization:

```text
ALTER TABLE academy_profiles 
ADD COLUMN platform_fee_override NUMERIC(6,2) DEFAULT NULL;

COMMENT ON COLUMN academy_profiles.platform_fee_override IS 
  'Custom platform fee for this academy. If NULL, uses tier default.';
```

---

## Edge Function Changes

### create-mollie-payment/index.ts

**Current code (lines 88-89):**
```javascript
// Calculate platform fee (5%)
const platformFee = Math.round(amount * 0.05 * 100) / 100;
```

**New logic:**
```javascript
// 1. Check for trainer-specific override
const { data: trainerProfile } = await supabase
  .from("trainer_profiles")
  .select("platform_fee_override, subscription_status")
  .eq("user_id", trainerId)
  .single();

// 2. Get tier-based default fee
let platformFee = 1.00; // Default to starter fee

if (trainerProfile?.platform_fee_override !== null) {
  // Use trainer's custom override
  platformFee = trainerProfile.platform_fee_override;
} else {
  // Look up fee from subscription_plans based on status
  const tier = trainerProfile?.subscription_status === "active" 
    ? "professional" // Active subscribers are Professional or higher
    : "starter";
    
  const { data: plan } = await supabase
    .from("subscription_plans")
    .select("platform_fee_flat")
    .eq("tier", tier)
    .eq("plan_type", "trainer")
    .single();
    
  if (plan?.platform_fee_flat) {
    platformFee = plan.platform_fee_flat;
  }
}

// Ensure fee doesn't exceed payment amount
platformFee = Math.min(platformFee, amount);

logStep("Platform fee calculated", { 
  platformFee, 
  hasOverride: trainerProfile?.platform_fee_override !== null 
});
```

---

## Frontend Changes

### 1. Update Pricing Page Display

**File: `src/pages/marketing/Pricing.tsx`**

Change from percentage badge to flat fee display:

```text
Current (line 212):
<Badge variant="outline">{plan.platform_fee_percent}% {t('pricing.trainers.platformFee')}</Badge>

New:
<Badge variant="outline">€{plan.platform_fee_flat?.toFixed(2) || '1.00'} {t('pricing.trainers.platformFee')}</Badge>
```

### 2. Update usePricingPlans Interface

**File: `src/hooks/usePricingPlans.ts`**

Add the new field to the interface:

```text
export interface SubscriptionPlan {
  // ... existing fields
  platform_fee_percent: number;  // Keep for backwards compatibility
  platform_fee_flat: number;     // Add new flat fee field
}
```

### 3. Update Admin Plan Edit Dialog

**File: `src/components/admin/PlanEditDialog.tsx`**

Change the fee input from percentage to flat amount:

```text
Current (lines 214-230):
<Label htmlFor="platform_fee">Platform Fee (%)</Label>
<Input type="number" max="100" step="0.1" .../>

New:
<Label htmlFor="platform_fee_flat">Platform Fee (€)</Label>
<Input type="number" min="0" step="0.01" placeholder="e.g. 1.00" .../>
```

### 4. Update Admin Trainer Edit Dialog

**File: `src/components/admin/TrainerEditDialog.tsx`**

Add a fee override field in the Settings tab:

```text
<div className="grid gap-2">
  <Label htmlFor="platformFeeOverride">Platform Fee Override (€)</Label>
  <Input
    id="platformFeeOverride"
    type="number"
    min="0"
    step="0.01"
    value={platformFeeOverride}
    onChange={(e) => setPlatformFeeOverride(e.target.value)}
    placeholder="Leave empty for tier default"
  />
  <p className="text-xs text-muted-foreground">
    Set a custom fee for this trainer. Leave empty to use tier default.
  </p>
</div>
```

### 5. Update Admin Academy Edit Dialog

**File: `src/components/admin/AcademyEditDialog.tsx`**

Add the same fee override field for academies.

---

## Translation Updates

### English (`src/i18n/locales/en/marketing.json`)

```text
"platformFee": "per booking"
"feeTooltip": "A flat fee is deducted from each booking payment. Higher tiers pay less."
```

Update FAQ:
```text
"platformFee": {
  "q": "How does the platform fee work?",
  "a": "A flat fee is deducted from each lesson payment based on your subscription tier. Starter pays €1.00 per booking, Professional pays €0.75, and Academy pays €0.50."
}
```

### Dutch (`src/i18n/locales/nl/marketing.json`)

```text
"platformFee": "per boeking"
"feeTooltip": "Een vast bedrag wordt afgetrokken van elke betaling. Hogere abonnementen betalen minder."
```

---

## Code Files to Modify

| File | Change |
|------|--------|
| **Database** | Add `platform_fee_flat` column, add override columns |
| `supabase/functions/create-mollie-payment/index.ts` | Implement tier-based fee lookup with override support |
| `src/hooks/usePricingPlans.ts` | Add `platform_fee_flat` to interface |
| `src/pages/marketing/Pricing.tsx` | Display €X.XX instead of X% |
| `src/components/admin/PlanEditDialog.tsx` | Change % input to € flat input |
| `src/components/admin/TrainerEditDialog.tsx` | Add fee override field |
| `src/components/admin/AcademyEditDialog.tsx` | Add fee override field |
| `src/lib/subscription.ts` | Update constants to flat fees |
| `src/i18n/locales/en/marketing.json` | Update fee text |
| `src/i18n/locales/nl/marketing.json` | Update fee text |

---

## Implementation Order

1. **Database migration** - Add new columns
2. **Update edge function** - Implement fee calculation logic
3. **Update TypeScript interfaces** - Add new fields
4. **Update admin dialogs** - Enable fee management
5. **Update pricing page** - Show flat fees
6. **Update translations** - New fee messaging
7. **Test end-to-end** - Verify fee calculation in Mollie payments

---

## Technical Notes

- The `platform_fee_percent` column will be kept for backwards compatibility but deprecated
- If a trainer has an override set, it takes priority over the tier default
- The minimum fee of €0.00 (free) can be set for special partnerships
- The fee is capped at the payment amount to prevent negative trainer payouts

