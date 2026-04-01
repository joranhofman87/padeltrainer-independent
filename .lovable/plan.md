

# City Landing Pages for SEO — `/padel/[city]`

## Approach

Rather than enriching the existing `/trainers/[city]` page (which is trainer-focused), create a new dedicated city landing page at `/padel/[city-slug]`. This keeps the trainer directory page intact while giving us a broader, keyword-rich page targeting "padel [city]" queries.

The existing `TrainersCity.tsx` already fetches all the data we need (locations, trainers, academies, nearby cities). The new page will reuse the same data-fetching logic but present it in the richer layout described in the prompt.

## New Files

### 1. `src/pages/marketing/CityLanding.tsx`
New page component with these sections:
- **Hero**: H1 "Padel in [City]", subtitle, two anchor CTAs ("Find a court" / "Book a coach")
- **City intro**: Template-generated 200-300 word paragraph using city data (club count, trainer count, top club names, indoor/outdoor availability). Generated client-side from a helper function — no CMS needed for v1
- **Clubs section** (H2): Grid of `LocationCard` components, show 6 initially with "Show all" expand
- **Trainers section** (H2): Grid of trainer cards (reuse pattern from `TrainersCity.tsx`), CTA linking to `/trainers/[city]`
- **Padel lessons section** (H2): Template paragraph targeting "padel les [city]", group vs private, CTA to signup
- **FAQ section** (H2): 5 city-specific FAQs with `FAQPage` structured data
- **Nearby cities strip**: Horizontal scroll of city links to `/padel/[city]`

Data fetching reuses existing functions: `getActiveLocations()`, `getLocationTrainerCounts()`, `getClaimedLocationIds()`, `getCitiesWithTrainers()`, plus the same trainer-fetching logic from `TrainersCity.tsx`.

### 2. `src/lib/cityContent.ts`
Helper that generates the city intro paragraph and lessons paragraph from template strings using city data variables (city name, club count, trainer count, indoor/outdoor counts, top club names, province). Returns localized text per language.

## Modified Files

### 3. `src/components/DomainRouter.tsx`
Add route: `<Route path="padel/:city" element={<CityLanding />} />`

### 4. Translation files (all 5 locales)
Add `cityLanding` namespace with:
- Page title/meta description templates
- Hero headline/subtitle
- Section headings (clubs, trainers, lessons, FAQ)
- FAQ question/answer templates
- CTA button labels
- Lessons section copy template

### 5. `supabase/functions/sitemap/index.ts`
In the `cities` section, generate entries for `/padel/[city]` in addition to (or instead of) `/trainers/[city]`. Both URL patterns will be in the sitemap.

### 6. `supabase/functions/render-page/index.ts`
Add `/padel/:city` to the pre-rendering paths so bots get server-rendered HTML with proper OG tags.

## SEO Implementation

- **Title**: "Padel in [City] — Courts, Clubs & Coaches | PadelTrainer.ai"
- **Meta description**: "Find [X] padel clubs and coaches in [City]. Compare courts, book lessons and start playing padel today."
- **Structured data**: `FAQPage` + `BreadcrumbList` (Home > Padel > [City]) + `LocalBusiness` for each club (if lat/lng available)
- **Hreflang**: All 5 languages pointing to `/[lang]/padel/[city]`
- **Canonical**: Self-referencing per locale
- **Internal linking**: Nearby cities link to `/padel/[other-city]`, clubs link to `/locations/[slug]`, trainers link to `/trainer/[slug]`

## Design

- Matches existing design language: white background, clean cards, orange accents
- Mobile-first layout with stacking sections
- Club/trainer cards use the same `LocationCard` and trainer card patterns already in use
- Lazy load trainer and club grids below the fold
- Hero is clean typography on white/light gray — no full-bleed image

## What stays unchanged

- `/trainers/[city]` remains as-is (trainer-focused directory)
- `/locations/[slug]` individual club pages remain unchanged
- No database changes needed — all data already exists

