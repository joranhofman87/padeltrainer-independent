

## Add Birth Date to Player Profile and Registration Form

### Summary
Add a `birth_date` column to the `profiles` table and `intake_requests` table, display it in the player profile edit page, and add it as a required field in the cycle registration form. This enables age-based matching in proposal generation.

### Database Changes (2 migrations)

**Migration 1: Add `birth_date` to `profiles`**
```sql
ALTER TABLE public.profiles ADD COLUMN birth_date date;
```

**Migration 2: Add `birth_date` to `intake_requests`**
```sql
ALTER TABLE public.intake_requests ADD COLUMN birth_date date;
```

### Code Changes

**1. `src/pages/EditProfile.tsx`**
- Add `birth_date: ''` to `formData` state (line 61-70)
- Populate it from profile in the data-loading effect
- Add a date input field in the player section of the form (near the rating fields)
- Include `birth_date` in the profile update call (line 381-389) and the edge function call (line 357-367)

**2. `src/components/cycles/CycleApplicationForm.tsx`**
- Add `birth_date: z.string().min(1, t('application.form.birthDateRequired'))` to the zod schema (line ~142)
- Add `birth_date: ''` to default values (line ~174)
- Pre-populate from the player's profile if available (via a new prop `playerBirthDate`)
- Add a date picker field in the form UI (after the phone field, before rating)
- Include `birth_date` in the submit payload for both guest (line 201-217) and logged-in flows (line 224-240)

**3. `src/lib/cycles.ts`**
- Add `birth_date?: string` to `IntakeRequestInput` interface (line 171-188)
- Add `birth_date` to `IntakeRequest` interface (line 91-113)
- Include `birth_date` in the `insertData` object in `submitIntakeRequest` (line 624-641)

**4. `supabase/functions/submit-guest-intake/index.ts`**
- Destructure `birthDate` from request body (line 49-65)
- Include `birth_date: birthDate || null` in the intake insert (line 167-184)
- Also update the profile with `birth_date` if provided (line 135-146)

**5. `supabase/functions/generate-proposals/index.ts`**
- Add `birth_date` to the `IntakeRequest` interface (line 42-56) — available for future age-based scoring

**6. Translation files** (all 5 locales: `en`, `nl`, `de`, `es`, `fr`)
- Add to `cycles.json` under `application.form`:
  - `birthDate`: "Date of birth" / "Geboortedatum" / "Geburtsdatum" / "Fecha de nacimiento" / "Date de naissance"
  - `birthDateRequired`: "Please enter your date of birth" (translated)
- Add to `player.json` (or relevant profile translation):
  - `birthDate`: "Date of birth" (translated)

**7. Props propagation**
- Where `CycleApplicationForm` is rendered (in `CycleRegistration.tsx` and `BrandedCycleRegistration.tsx`), pass the player's `birth_date` from their profile so it pre-fills.

### Files to edit
- `src/pages/EditProfile.tsx` — add birth_date field to player profile form
- `src/components/cycles/CycleApplicationForm.tsx` — add required birth_date field
- `src/lib/cycles.ts` — update interfaces and insert logic
- `supabase/functions/submit-guest-intake/index.ts` — handle birth_date
- `supabase/functions/generate-proposals/index.ts` — add to interface for future use
- `src/pages/CycleRegistration.tsx` — pass playerBirthDate prop
- `src/pages/BrandedCycleRegistration.tsx` — pass playerBirthDate prop
- `src/i18n/locales/en/cycles.json`
- `src/i18n/locales/nl/cycles.json`
- `src/i18n/locales/de/cycles.json`
- `src/i18n/locales/es/cycles.json`
- `src/i18n/locales/fr/cycles.json`
- `src/i18n/locales/en/player.json` (+ nl, de, es, fr equivalents)

