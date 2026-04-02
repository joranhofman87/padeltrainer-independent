

# Founding 100 Trainers — Updated Plan

## Change from previous plan

**Remove the signup form section entirely** from the campaign page. Instead, all CTAs ("Claim Your Spot →", "Become a Founding Trainer") link directly to the existing trainer signup page at `/app/signup/trainer`.

To preserve campaign attribution, append a query parameter: `/app/signup/trainer?ref=founding100`. This lets you track signups originating from this campaign.

## Updated page structure

1. **Hero** — badge, headline, subheadline, progress bar, CTA button → links to `/app/signup/trainer?ref=founding100`
2. **What You Get** — 3 value cards
3. **How It Works** — 4 steps (step 1 now says "Sign up on our platform" instead of "fill in the form below")
4. **Value Breakdown** — comparison table
5. **Who Is This For** — 4 bullet points
6. **FAQ Accordion** — 6 items
7. **Final CTA section** (replaces the signup form) — headline "Ready to Become a Founding Trainer?", subtext with remaining spots, single button → `/app/signup/trainer?ref=founding100`

No `id="signup"` form. No new database table. The hero CTA and bottom CTA both navigate to the existing trainer signup.

## Everything else unchanged

Route, i18n, announcement banner, structured data, render-page update — all remain as previously planned.

## Files

| File | Action |
|------|--------|
| `src/pages/marketing/FoundingTrainers.tsx` | **New** — campaign page without embedded form; CTAs link to `/app/signup/trainer?ref=founding100` |
| `src/components/DomainRouter.tsx` | Add route |
| `src/components/marketing/MarketingLayout.tsx` | Dismissible announcement banner |
| `src/i18n/locales/{en,nl,de,es,fr}/marketing.json` | Add `foundingTrainers.*` keys |
| `supabase/functions/render-page/index.ts` | Add path for bot pre-rendering |

