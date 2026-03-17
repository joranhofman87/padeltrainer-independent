

## Dynamic OG Tags for Registration Links

When you share a registration link on WhatsApp, it shows generic "PadelTrainer.ai" text because:
1. The pre-rendering edge function has no route for `/academies/:slug/register/:cycleId` (or clubs/generic register), so it falls through to a generic fallback
2. The client-side page (`BrandedCycleRegistration.tsx`) doesn't use the `<SEO>` component either

### Plan

**1. Add registration route handlers to `render-page` edge function**

Add three new route patterns before the fallback `else` block:
- `/academies/:slug/register/:cycleId`
- `/clubs/:slug/register/:cycleId`  
- `/register/:cycleId`

Create a `renderCycleRegistration()` function that:
- Fetches the cycle by ID from `cycles` table (name, start_date, end_date, owner_type, owner_id, location_id)
- Fetches the owner name (academy or club) from the appropriate profile table
- Fetches the location name/city if available
- Generates OG tags like: `"Register for [Cycle Name] | [Owner Name] | PadelTrainer.ai"` with description including dates and location

**2. Add `<SEO>` component to `BrandedCycleRegistration.tsx`**

For client-side rendering (non-bot visitors), add dynamic SEO meta tags using the existing `<SEO>` component with cycle name, owner name, and dates in the title/description.

**3. Add `<SEO>` component to `CycleRegistration.tsx`**

Same treatment for the generic (non-branded) registration page.

### Files to modify
- `supabase/functions/render-page/index.ts` — add route matching + `renderCycleRegistration()` function
- `src/pages/BrandedCycleRegistration.tsx` — add `<SEO>` component
- `src/pages/CycleRegistration.tsx` — add `<SEO>` component

### Result
WhatsApp previews will show something like:
> **Register for Padel Lessen Voorjaar 2026 | RL Padel Performance**
> Sign up for training from 1 Apr - 30 Jun 2026 at [Location], [City].

