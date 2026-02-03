

# Pricing Update with Monthly/Annual Toggle

## Overview

This plan updates the subscription pricing structure and adds a monthly/annual toggle to the pricing page with 20% savings displayed for annual plans.

## New Pricing Structure

| Tier | Current Monthly | New Monthly | New Yearly (20% off) | Yearly Savings |
|------|-----------------|-------------|----------------------|----------------|
| Starter | €10 | €10 | €96 (was €120) | €24/year |
| Professional | €29 | €39 | €374 (was €468) | €94/year |
| Academy | €99 | €99 | €950 (was €1188) | €238/year |

**Note:** Starter is already €10 in the database. Professional needs to change from €29 → €39. Academy is already €99.

---

## Database Changes

Update the `subscription_plans` table with new prices:

```text
UPDATE subscription_plans SET 
  monthly_price = 10, 
  yearly_price = 96 
WHERE tier = 'starter' AND plan_type = 'trainer';

UPDATE subscription_plans SET 
  monthly_price = 39, 
  yearly_price = 374 
WHERE tier = 'professional' AND plan_type = 'trainer';

UPDATE subscription_plans SET 
  monthly_price = 99, 
  yearly_price = 950 
WHERE tier = 'academy' AND plan_type = 'trainer';
```

---

## Frontend Changes

### 1. Add Monthly/Annual Toggle to Pricing Page

**File: `src/pages/marketing/Pricing.tsx`**

Add a billing cycle toggle in the trainer pricing section header:

```text
// Add state for billing cycle
const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');

// Add toggle UI after trainer section title
<div className="flex justify-center mb-8">
  <div className="inline-flex items-center gap-4 p-1 bg-muted rounded-lg">
    <Button
      variant={billingCycle === 'monthly' ? 'default' : 'ghost'}
      size="sm"
      onClick={() => setBillingCycle('monthly')}
    >
      {t('pricing.trainers.monthly')}
    </Button>
    <Button
      variant={billingCycle === 'yearly' ? 'default' : 'ghost'}
      size="sm"
      onClick={() => setBillingCycle('yearly')}
      className="gap-2"
    >
      {t('pricing.trainers.yearly')}
      <Badge variant="secondary" className="bg-green-100 text-green-700">
        {t('pricing.trainers.save20')}
      </Badge>
    </Button>
  </div>
</div>
```

Update the price display in cards to show dynamic pricing based on toggle:

```text
<span className="text-4xl font-bold">
  €{billingCycle === 'yearly' ? plan.yearly_price : plan.monthly_price}
</span>
<span className="text-muted-foreground">
  /{billingCycle === 'yearly' ? t('pricing.trainers.year') : t('pricing.trainers.month')}
</span>

{/* Show savings when yearly is selected */}
{billingCycle === 'yearly' && plan.monthly_price > 0 && (
  <p className="text-sm text-green-600 font-medium mt-1">
    {t('pricing.trainers.saveAmount', { 
      amount: Math.round(plan.monthly_price * 12 - plan.yearly_price) 
    })}
  </p>
)}
```

### 2. Update lib/subscription.ts Constants

**File: `src/lib/subscription.ts`**

Update the hardcoded pricing constants:

```text
export const SUBSCRIPTION_TIERS = {
  professional: {
    name: 'Professional',
    // ... keep Mollie IDs
    monthlyPrice: 39,
    yearlyPrice: 374,
  },
  academy: {
    name: 'Academy',
    // ... keep Mollie IDs
    monthlyPrice: 99,
    yearlyPrice: 950,
  },
} as const;

export const TRIAL_TIER = {
  name: 'Starter',
  maxLessons: 3,
  monthlyPrice: 10,
  yearlyPrice: 96,
};
```

### 3. Update Trainer Subscription Page

**File: `src/pages/TrainerSubscription.tsx`**

The toggle already exists here. Update the price display to show yearly savings more prominently:

- Add savings badge next to yearly price
- Show "Save €X/year" when yearly is selected

### 4. Update Admin Pricing Page

**File: `src/pages/admin/AdminPricing.tsx`**

Ensure admin can update both monthly and yearly prices. The table already shows both columns.

---

## Translation Updates

### English (`src/i18n/locales/en/marketing.json`)

Add new translation keys for the billing toggle:

```json
"trainers": {
  "monthly": "Monthly",
  "yearly": "Yearly", 
  "month": "month",
  "year": "year",
  "save20": "Save 20%",
  "saveAmount": "Save €{{amount}}/year",
  "plans": {
    "starter": {
      "price": "€10"
    },
    "professional": {
      "price": "€39",
      "yearlyPrice": "€374/year (save 20%)"
    },
    "academy": {
      "price": "€99",
      "yearlyPrice": "€950/year (save 20%)"
    }
  }
}
```

### Dutch (`src/i18n/locales/nl/marketing.json`)

```json
"trainers": {
  "monthly": "Maandelijks",
  "yearly": "Jaarlijks",
  "month": "maand",
  "year": "jaar",
  "save20": "Bespaar 20%",
  "saveAmount": "Bespaar €{{amount}}/jaar",
  "plans": {
    "starter": {
      "price": "€10"
    },
    "professional": {
      "price": "€39",
      "yearlyPrice": "€374/jaar (bespaar 20%)"
    },
    "academy": {
      "price": "€99",
      "yearlyPrice": "€950/jaar (bespaar 20%)"
    }
  }
}
```

---

## Files to Modify

| File | Change |
|------|--------|
| **Database** | Update monthly/yearly prices for all trainer tiers |
| `src/pages/marketing/Pricing.tsx` | Add billing toggle, dynamic price display, savings badges |
| `src/pages/TrainerSubscription.tsx` | Enhance savings display |
| `src/lib/subscription.ts` | Update price constants |
| `src/i18n/locales/en/marketing.json` | Add toggle translations, update prices |
| `src/i18n/locales/nl/marketing.json` | Add toggle translations, update prices |

---

## Implementation Order

1. **Database update** - Set new monthly/yearly prices
2. **Add billing toggle** - Monthly/yearly switch on pricing page
3. **Update price display** - Dynamic pricing based on toggle
4. **Add savings indicators** - Show "Save €X/year" badges
5. **Update constants** - lib/subscription.ts price updates
6. **Update translations** - New keys for toggle UI
7. **Test** - Verify pricing displays correctly in both languages

---

## Visual Design

The pricing page will have:
- A centered toggle with "Monthly" and "Yearly" buttons
- "Save 20%" badge on the yearly button
- When yearly is selected, each plan card shows the annual price with "Save €X/year" in green text
- Professional plan highlighted as "Most Popular"

