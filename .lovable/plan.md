

# Build: "What's Your Padel Level?" Self-Assessment Quiz

## Overview
A 10-question self-assessment quiz at `/:lang/tools/padel-level-test` that scores players on the 1.0–7.0 international scale with country-specific rating equivalents. Fully frontend — no Sanity schema needed. Results include personalized tips, content recommendations, and a racket finder CTA. Also adds a link in the Player Sidebar.

## Files to Create

### 1. `src/pages/marketing/PadelLevelTest.tsx`
Main page with three states: **intro**, **quiz**, **results**.

- **Intro**: SEO text, country selector (auto-detected from `lang`), "Start Quiz" CTA
- **Quiz**: 10 questions, one per screen, 4 options each (A=0pts, B=1pt, C=2pts, D=3pts), progress bar, animated slide transitions (reuse `framer-motion` pattern from racket finder), Back/Next navigation
- **Results**: Level gauge (3.5 / 7.0), country-specific equivalent, level title + description, strengths list, focus areas, content recommendations (articles, strokes, blog posts — hardcoded links per level tier), racket finder CTA, share buttons, retake button
- Shareable URL via `?result=3.5&country=netherlands` — if params present, show results directly
- SEO: Quiz JSON-LD, localized title/description, hreflang

### 2. `src/components/levelquiz/LevelQuizQuestion.tsx`
Single question component with 4 large option buttons (A/B/C/D), each showing the answer text. Animated transitions between questions. Similar pattern to existing `QuizQuestion.tsx` but with point-based selection instead of value-based.

### 3. `src/components/levelquiz/LevelQuizResults.tsx`
Results display with:
- Visual level gauge/progress indicator (3.5 out of 7.0)
- Country rating equivalent card
- Strengths (green checkmarks) and focus areas (improvement arrows)
- Content recommendation sections: articles, strokes, blog posts (all as `LocalizedLink`s)
- Racket finder CTA linking to `/:lang/racket-finder?level={racketLevel}`
- Share buttons (WhatsApp, X, Facebook, copy link)
- Retake quiz button

### 4. `src/lib/levelQuizData.ts`
All hardcoded quiz data:
- 10 questions with 4 options each, all 5 languages (en/es/nl/de/fr)
- `calculateLevel(totalPoints)` scoring function (0–30 → 1.0–6.5)
- `RATING_MAP` — country conversion table (spain, netherlands, belgium, france, sweden, uk, germany, other)
- `LEVEL_INFO` — title, description, strengths, focusAreas, racketLevel per level
- `CONTENT_LINKS` — curated article/stroke/blog slugs per tier (beginner/intermediate/advanced)
- `COUNTRIES` array with flag emojis and labels
- `getDefaultCountry(lang)` helper

## Files to Modify

### 5. `src/components/DomainRouter.tsx`
Add lazy import for `PadelLevelTest` and route `tools/padel-level-test` inside `/:lang` marketing routes.

### 6. `src/components/player/PlayerSidebar.tsx`
Add a "Level Test" nav item (using `Target` or `Trophy` icon) linking to `/:lang/tools/padel-level-test` as an external marketing page link. Place it after "Following" and before the "Account" group. Uses `i18next` current language to build the URL.

### 7. i18n files (5 locales: `marketing.json`)
Add `levelQuiz.*` translation keys for all UI text (title, subtitle, selectCountry, startQuiz, question X of Y, back, next, seeResults, yourLevel, strengths, focusAreas, share, retake, etc.) — all translations provided in the prompt.

### 8. `src/i18n/locales/*/player.json`
Add `nav.levelTest` key for the sidebar label (e.g., "Level Test", "Niveautest", "Test de Nivel", etc.).

## Technical Details

### Scoring
```typescript
function calculateLevel(totalPoints: number): number {
  if (totalPoints <= 2) return 1.0;
  if (totalPoints <= 4) return 1.5;
  // ... up to 6.5 for 29-30
}
```

### Country auto-detection
```typescript
function getDefaultCountry(lang: string): string {
  switch(lang) {
    case 'es': return 'spain';
    case 'nl': return 'netherlands';
    case 'de': return 'germany';
    case 'fr': return 'france';
    default: return 'other';
  }
}
```

### PostHog events
`level_quiz_started`, `level_quiz_answer` (per question), `level_quiz_completed` (with level + country rating), `level_quiz_shared`, `level_quiz_content_click`

### Player Sidebar link
Opens in a new context (marketing page, not `/app/` route) — uses `window.open` or an `<a>` tag with the localized marketing URL.

