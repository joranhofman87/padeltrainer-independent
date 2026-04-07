

# Fix: Registration Page Should Use Safe View

## Root Cause

A recent security migration (April 6) correctly removed the public SELECT policy from `academy_profiles` to hide sensitive financial columns (IBAN, Mollie IDs, Stripe IDs). A safe view `academy_profiles_safe` was created that exposes only public columns — but `BrandedCycleRegistration.tsx` still queries the base table directly, which now returns empty for anonymous visitors → "Registration Not Found."

## Fix

**One file change** in `src/pages/BrandedCycleRegistration.tsx`:

Change the academy query (around line 81) from:
```typescript
supabase.from('academy_profiles').select('id, name, slug, logo_url, banner_url, welcome_message')
```
to:
```typescript
supabase.from('academy_profiles_safe' as any).select('id, name, slug, logo_url, banner_url, welcome_message')
```

The `academy_profiles_safe` view already contains all the columns the registration page needs (`id`, `name`, `slug`, `logo_url`, `banner_url`, `welcome_message`) and bypasses RLS (no `security_invoker`), so it works for anonymous visitors.

Similarly, check if `club_profiles` is also affected — the club query on line 86 should use `club_profiles_safe` instead.

## File summary

| File | Change |
|------|--------|
| `src/pages/BrandedCycleRegistration.tsx` | Query `academy_profiles_safe` and `club_profiles_safe` views instead of base tables |

