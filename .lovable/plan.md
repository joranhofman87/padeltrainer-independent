

## Redesign Coach Detail Page as a Landing Page

### Problem
The current coach page is minimal — a small avatar, name, badges, and bio in a single narrow column. Several new CMS fields are not fetched or displayed. The `profileImageUrl` field is actually `null` for all coaches because the query references a non-existent field instead of the `profileImage` image object. The page doesn't look like something a coach would proudly share.

### New fields available in Sanity (not currently fetched)
- `shortTagline` — one-liner quote
- `location` — city/region
- `languages` — array of spoken languages
- `bestFor` — target audience (e.g. "Beginners", "Intermediate")
- `isFeatured` — featured flag
- `profileImage` — actual image object (current `profileImageUrl` returns null)
- `instagramUrl`, `youtubeUrl`, `tiktokUrl`, `websiteUrl` — social links

### Changes

**1. Fix image + fetch all fields — `src/lib/sanity.ts`**

Update both `COACHES_LIST_QUERY` and `COACH_BY_SLUG_QUERY`:
- Replace `profileImageUrl` with `"profileImageUrl": profileImage.asset->url` (computed projection)
- Add to detail query: `shortTagline`, `location`, `languages`, `bestFor`, `isFeatured`, `instagramUrl`, `youtubeUrl`, `tiktokUrl`, `websiteUrl`
- Add to list query: `shortTagline`, `location`, `"profileImageUrl": profileImage.asset->url`

**2. Redesign CoachPage as a landing page — `src/pages/marketing/CoachPage.tsx`**

Replace the current simple layout with a professional profile landing page structure:

- **Hero section**: Large profile image, name, short tagline as a quote, location with icon, language badges, social links (Instagram, YouTube, TikTok, website) as icon buttons. Use the existing `ProfileHeroCard` pattern/style from the app profiles for visual consistency but implemented inline (since this is a marketing page using `MarketingLayout`).
- **"Best For" section**: If `bestFor` is populated, show a row of cards/badges indicating target audience (e.g. "Beginners", "Intermediate").
- **Bio section**: Full bio in a card with a heading like "About {name}".
- **Specialties section**: Displayed as a grid of badges/chips in their own card.
- **Videos section**: Existing video tips grid (already works).
- **CTA section**: Existing CTA (already works).
- Enhance structured data with `location`, social links (`sameAs`), and `knowsAbout` from specialties.

**3. Improve Coaches list page — `src/pages/marketing/Coaches.tsx`**

- Fix image (same `profileImageUrl` projection fix)
- Add `shortTagline` and `location` display on cards
- Show location under the name

### Layout sketch

```text
┌──────────────────────────────────────────────┐
│  ← Back to Coaches          Breadcrumbs      │
├──────────────────────────────────────────────┤
│  ┌──────┐  Name                              │
│  │      │  "Short tagline"                   │
│  │ IMG  │  📍 Bristol · 🌐 English, Spanish  │
│  │      │  [IG] [YT] [TT] [Web]             │
│  └──────┘  [Best for: Beginners, Inter...]   │
├──────────────────────────────────────────────┤
│  About Gonzalo Lorenzo                       │
│  Full bio text...                            │
├──────────────────────────────────────────────┤
│  Specialties                                 │
│  [technique] [beginners] [Intermediate]      │
├──────────────────────────────────────────────┤
│  Videos by Gonzalo Lorenzo                   │
│  [card] [card] [card]                        │
├──────────────────────────────────────────────┤
│  CTA Section                                 │
└──────────────────────────────────────────────┘
```

### Files changed
1. `src/lib/sanity.ts` — Fix image projection, add new fields to both queries
2. `src/pages/marketing/CoachPage.tsx` — Full redesign with landing page layout
3. `src/pages/marketing/Coaches.tsx` — Fix image, add location + tagline to cards

