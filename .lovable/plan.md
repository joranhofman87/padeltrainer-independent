## Decisions locked in
- **Strict access** to org billing: only managers with `role='owner'` (or admins) can read/write billing columns. Multiple owners are already supported — any number of `manager` rows can carry `role='owner'`.
- **Keep visible** to anyone who can already see a profile: `phone`, `birth_date`, `email`. Lockdown only covers true billing/PII: `billing_address`, `billing_btw_number`, `billing_business_name`, `stripe_customer_id` on `profiles`.

## What ships

### 1. Migration

Column-level `REVOKE SELECT` from `authenticated` + `anon`:
- `trainer_profiles`: `iban, bic, btw_number, kvk_number, mollie_customer_id, stripe_customer_id, platform_fee_override`
- `academy_profiles`: same seven columns
- `club_profiles`: `mollie_customer_id, stripe_customer_id` (the only sensitive ones it has)
- `profiles`: `billing_address, billing_btw_number, billing_business_name, stripe_customer_id`

Four `SECURITY DEFINER` safe views (owned by `postgres`, granted to `authenticated`) following the existing `trainer_profiles_safe` pattern documented in `mem://security/financial-data-isolation-safe-views`:

```sql
CREATE OR REPLACE VIEW public.trainer_profiles_owner AS
  SELECT * FROM public.trainer_profiles
  WHERE auth.uid() = user_id OR public.is_admin(auth.uid());

CREATE OR REPLACE VIEW public.academy_profiles_owner AS
  SELECT * FROM public.academy_profiles
  WHERE public.is_academy_owner(auth.uid(), id) OR public.is_admin(auth.uid());

CREATE OR REPLACE VIEW public.club_profiles_owner AS
  SELECT * FROM public.club_profiles
  WHERE public.is_club_owner(auth.uid(), id) OR public.is_admin(auth.uid());

CREATE OR REPLACE VIEW public.profiles_owner AS
  SELECT * FROM public.profiles
  WHERE auth.uid() = user_id OR public.is_admin(auth.uid());
```

`SELECT, UPDATE` granted on each view to `authenticated`. UPDATE flows through the view as owner (postgres), so the existing UPDATE column permissions on the base table are not affected — owners keep full edit rights.

`is_*_owner()` already check `role='owner'`, so multi-owner is supported out of the box.

### 2. Code swaps

| File | Change |
|---|---|
| `src/lib/auth.ts` | `getProfile` and `getTrainerProfile` repointed to `profiles_owner` / `trainer_profiles_owner` (caller is always self) |
| `src/lib/academy.ts` (`getAcademyBySlug` preview, `getAcademyById`) | Narrow `select('*')` to explicit non-billing column list (called by non-owner managers too) |
| `src/lib/club.ts` (`getClubById`) | Same — narrow to non-billing columns |
| `src/pages/TrainerEarnings.tsx`, `src/pages/trainer/TrainerInvoices.tsx` | Read from `trainer_profiles_owner` (owner-only billing context) |
| `src/components/admin/TrainerEditDialog.tsx`, `AcademyEditDialog.tsx` | Read `platform_fee_override` via `_owner` view (admin passes the WHERE) |

Edge functions and `MollieDisconnectSection` are unaffected — service role bypasses everything; the disconnect dialog only does UPDATEs which keep working.

### 3. Memory update

Update `mem://security/financial-data-isolation-safe-views` to record the four new owner views and which surfaces consume them.

## UX impact

| Surface | Change |
|---|---|
| Owner trainer Settings, Invoices, Earnings | None visible. Reads via owner view. |
| Owner academy/club Settings, Invoices | None visible. |
| Co-owner (additional `role='owner'` manager) | Full billing access — strict rule already allows multiple owners. |
| Co-manager (`role='manager'`) of an academy/club | **Loses** billing visibility. Sees roster, schedule, ops as before. Promote them to owner if they need invoicing. |
| Academy/club manager viewing rosters of their trainers | **Loses** trainer's personal IBAN/BTW/KvK/Mollie/Stripe customer IDs. Sees name, bio, rate, phone, email, birth date, public fields. |
| Trainer viewing booked player profile | Phone, email, birth date stay visible. **Loses** billing address / business name / BTW. |
| Admin pages | None visible (admins pass the view WHERE). |
| Public pages, edge functions, Mollie/Stripe webhooks | None — server-side service role unaffected. |

## Risk register

- **`select('*')` failures** post-REVOKE — already audited and listed above; all five call sites get fixed in the same change.
- **Co-manager regression** — explicitly intended; documented above so support can promote co-managers when asked.
- **Linter noise** — these views will add to the existing "Security Definer View" linter findings, which the security memory already accepts as the documented safe-view pattern.
