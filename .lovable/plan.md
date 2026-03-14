

## Footer Redesign Plan

### Current Issues
1. **"Popular Cities"** only lists 5 Dutch cities — the platform now spans NL, BE, ES, DE
2. **"Platform"** section is a dumping ground mixing core product links with educational content (Rules, Strokes, Coaches, Blog)
3. **Tagline** says "Your journey to better padel." — needs updating
4. **Grid layout** is 4 columns which won't fit the new sections well

### New Footer Structure (6 columns on desktop, 2 on mobile)

```text
┌─────────────┬─────────────┬─────────────┬─────────────┬─────────────┬─────────────┐
│   Brand     │  Platform   │  Learn      │ Popular     │  Company    │   Legal     │
│             │             │  Padel      │ Cities      │             │             │
│  Logo       │ Find        │ Rules       │ Amsterdam   │ About Us    │ Privacy     │
│  Tagline    │  Trainers   │ Strokes     │ Madrid      │ Partner     │ Terms       │
│  Socials    │ Clubs       │ Coaches     │ Barcelona   │ Contact     │             │
│             │ Academies   │ Blog        │ Rotterdam   │ Register    │             │
│             │ Pricing     │             │ Antwerpen   │  your club  │             │
│             │ Locations   │             │ München     │             │             │
│             │             │             │ Köln        │             │             │
│             │             │             │ Valencia    │             │             │
└─────────────┴─────────────┴─────────────┴─────────────┴─────────────┴─────────────┘
```

### Changes

**1. `src/components/marketing/MarketingLayout.tsx` — Footer section**

- Change grid from `grid-cols-2 md:grid-cols-4` to `grid-cols-2 md:grid-cols-3 lg:grid-cols-6`
- **Platform** column: Keep Find Trainers, Clubs, Academies, Pricing, Locations (core product)
- **New "Learn Padel"** column: Move Blog, Rules, Strokes, Coaches here (educational/SEO content)
- **Popular Cities** column: Replace the 5 NL-only cities with 8 international cities — Amsterdam, Madrid, Barcelona, Rotterdam, Antwerpen, München, Köln, Valencia
- **Company** column: Add "Register your club" here (moved from Platform), keep About Us, Partner, Contact
- **Legal** column: Stays as-is

**2. Translation files (all 5 locales: en, nl, es, de, fr)**

- Update `footer.tagline` from "Your journey to better padel." to "Everything you need to improve your padel game."
- Add `footer.learnPadel` key: "Learn Padel"
- Update `footer.popularCities` to "Popular Cities"
- Localize the new tagline for `nl` ("Alles wat je nodig hebt om je padelspel te verbeteren.")
- Add localized `footer.learnPadel` for each locale

**3. SEO Best Practices Applied**
- Educational content grouped under "Learn Padel" — signals topical authority to crawlers
- International city links improve geographic relevance signals across markets
- Clean separation of product vs. content vs. company links follows SaaS footer conventions
- More internal links spread across categories improves crawl distribution

### Files to Modify
- `src/components/marketing/MarketingLayout.tsx` (footer section, lines 201–287)
- `src/i18n/locales/en/marketing.json`
- `src/i18n/locales/nl/marketing.json`
- `src/i18n/locales/es/marketing.json`
- `src/i18n/locales/de/marketing.json`
- `src/i18n/locales/fr/marketing.json`

