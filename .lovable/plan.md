# Secure Financial Data: Strip Sensitive Columns from Public Views

## Problem

When `is_public = true`, the current SELECT policies on `trainer_profiles`, `academy_profiles`, and `club_profiles` expose the **entire row** — including banking details (IBAN, BIC), tax numbers (KVK, BTW), payment provider IDs (mollie_customer_id, stripe_customer_id), and internal config (platform_fee_override, invoice settings).

Anyone can query these directly via the API, bypassing the frontend.

## Affected Tables & Sensitive Fields

### trainer_profiles
- `mollie_customer_id`, `stripe_customer_id`
- `subscription_id`, `subscription_status`, `subscription_tier`, `subscription_ends_at`, `trial_ends_at`
- `platform_fee_override`
- `use_manual_invoicing`

### academy_profiles
- `iban`, `bic`, `kvk_number`, `btw_number`
- `business_address`, `business_name`
- `mollie_customer_id`, `stripe_customer_id`
- `subscription_id`, `subscription_status`, `subscription_tier`, `subscription_ends_at`, `trial_ends_at`
- `platform_fee_override`
- `invoice_prefix`, `invoice_next_number`, `invoice_forward_emails`, `invoice_logo_url`, `invoice_banner_color`
- `default_vat_rate`, `payment_terms_days`
- `last_processed_payment_id`

### club_profiles
- `mollie_customer_id`, `stripe_customer_id`
- `subscription_id`, `subscription_status`, `subscription_tier`, `subscription_ends_at`, `trial_ends_at`
- `last_processed_payment_id`

## Solution

The `_safe` views (`trainer_profiles_safe`, `academy_profiles_safe`, `club_profiles_safe`) already exist but the **base table SELECT policies still allow full row access to anyone**. The fix:

1. **Tighten base table SELECT policies** — remove overly permissive public SELECT; only owners/managers/admins get full row access
2. **Verify `_safe` views exclude all sensitive columns** listed above; update if needed
3. **Update frontend code** — public-facing queries (profile pages, search, booking flow) must use `_safe` views
4. **Keep owner access** — dashboards and settings pages keep querying base tables since owners need full column access

## Migration

### Step 1: Replace public SELECT policies on base tables

```sql
-- trainer_profiles: drop public SELECT, add owner+admin only
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON trainer_profiles;
CREATE POLICY "Owners and admins can view trainer profiles"
  ON trainer_profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin(auth.uid()) OR public.is_active_academy_trainer(auth.uid(), id));

-- academy_profiles: drop public SELECT, add manager+admin only  
DROP POLICY IF EXISTS "Public academy profiles are viewable by everyone" ON academy_profiles;
CREATE POLICY "Managers and admins can view academy profiles"
  ON academy_profiles FOR SELECT TO authenticated
  USING (public.is_academy_manager(auth.uid(), id) OR public.is_admin(auth.uid()));

-- club_profiles: same pattern
DROP POLICY IF EXISTS "Public club profiles are viewable" ON club_profiles;
CREATE POLICY "Managers and admins can view club profiles"
  ON club_profiles FOR SELECT TO authenticated
  USING (public.is_club_manager(auth.uid(), id) OR public.is_admin(auth.uid()));
```

### Step 2: Ensure _safe views have SELECT policies for public access

The safe views (with `security_invoker=on`) only expose non-sensitive columns. These get the permissive public SELECT policy so anyone can browse profiles.

### Step 3: Verify _safe view column lists

Check each `_safe` view and confirm it **excludes** all financial/internal fields listed above. Update if any sensitive columns leak through.

## Frontend Changes

| Context | Current query | Change to |
|---------|--------------|-----------|
| Trainer public profile page | `trainer_profiles` | `trainer_profiles_safe` |
| Academy public profile page | `academy_profiles` | `academy_profiles_safe` |
| Club public profile page | `club_profiles` | `club_profiles_safe` |
| Search / listing pages | Base tables | Safe views |
| Booking flow (trainer info) | Base tables | Safe views |
| Trainer dashboard / settings | `trainer_profiles` | Keep as-is (owner needs full access) |
| Academy dashboard / settings | `academy_profiles` | Keep as-is (manager needs full access) |

## File summary

| File | Change |
|------|--------|
| Migration SQL | Drop public SELECT on base tables, add owner/manager-only SELECT |
| Migration SQL | Verify and update `_safe` views to exclude all financial columns |
| `src/pages/TrainerProfile.tsx` | Query `trainer_profiles_safe` for public view |
| `src/pages/AcademyProfile.tsx` | Query `academy_profiles_safe` for public view |
| `src/pages/ClubProfile.tsx` | Query `club_profiles_safe` for public view |
| Search/listing components | Switch to safe views |
| Booking flow components | Switch to safe views for trainer info |
| Edge functions (public-api) | Already selects specific columns — verify no sensitive fields |
