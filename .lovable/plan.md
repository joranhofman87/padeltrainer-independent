

# Playground Hub + Red Flag Quiz

## What We're Building

1. **Playground landing page** — a card-based hub at `/:lang/playground` showcasing all interactive tools
2. **Red Flag Quiz** — the viral personality quiz at `/:lang/playground/red-flag-quiz`
3. **Route migration** — move existing tools (Racket Finder, Level Test) under the playground URL namespace
4. **Navigation update** — add "Playground" to the marketing site header

## Architecture

Current tool routes:
- `/:lang/racket-finder` → moves to `/:lang/playground/racket-finder`
- `/:lang/tools/padel-level-test` → moves to `/:lang/playground/level-test`

New routes:
- `/:lang/playground` → hub page
- `/:lang/playground/red-flag-quiz` → new quiz

Old URLs get redirect routes to preserve SEO.

## Changes

### 1. New: `src/pages/marketing/Playground.tsx`
Landing page with cards for each tool:
- Red Flag Quiz ("What's Your Padel Red Flag?")
- Racket Finder
- Level Test

Each card: icon/emoji, title, short description, CTA button. Uses `MarketingLayout` + `SEO`. Simple responsive grid (1 col mobile, 3 col desktop).

### 2. New: `src/pages/marketing/RedFlagQuiz.tsx`
Full quiz implementation following the uploaded prompt:
- 3 phases: intro → quiz (10 questions) → results
- Scoring system mapping answers to 8 profiles (+ hidden Chaos Agent)
- Result card designed for Instagram Story screenshots (bold profile-specific colors, emoji, red/green flags)
- Share buttons (copy link, WhatsApp, Twitter/X)
- "Challenge your partner" feature via `?ref=challenge` URL param
- Auto-advance after answer selection (0.5s delay)
- Slide transitions between questions (reuse `AnimatePresence` pattern from existing quizzes)
- PostHog tracking events for start/answer/complete/share
- SEO structured data (`Quiz` schema)
- All quiz data lives client-side in a dedicated `src/lib/redFlagQuizData.ts`

### 3. New: `src/lib/redFlagQuizData.ts`
All 10 questions, 4 options each, profile mappings, and the 9 result profile definitions (name, emoji, tagline, description, red flags, green flag, color). Exported as typed constants.

### 4. New: `src/components/redflagquiz/`
- `RedFlagQuizQuestion.tsx` — single question card with answer options
- `RedFlagQuizResult.tsx` — the screenshot-worthy result card + share buttons below

### 5. Update: `src/components/DomainRouter.tsx`
- Add lazy imports for `Playground` and `RedFlagQuiz`
- Add routes under `/:lang`:
  - `playground` → Playground
  - `playground/red-flag-quiz` → RedFlagQuiz
  - `playground/racket-finder` → RacketFinder (existing component)
  - `playground/level-test` → PadelLevelTest (existing component)
- Add redirects from old paths to new playground paths

### 6. Update: `src/components/marketing/MarketingLayout.tsx`
- Add "Playground" as a standalone nav link (or replace the racket-finder entry in the mega menu Content column with a Playground link)
- Update mobile menu accordingly

### 7. Update: `supabase/functions/sitemap/index.ts`
Add `playground`, `playground/red-flag-quiz`, `playground/racket-finder`, `playground/level-test` to static pages.

### 8. Update: `supabase/functions/render-page/index.ts`
Add meta tags for the new playground routes.

### 9. Translation keys
Add keys to all 6 language files under `marketing.json` for:
- Playground page title/description
- Red Flag Quiz intro, questions, profiles, share text
- Navigation label

### 10. Update: `public/llms.txt`
Add playground URLs to the URL structure section.

## Scope Summary

| Area | Files |
|---|---|
| New pages | 2 (Playground hub, RedFlagQuiz) |
| New components | 2 (question + result card) |
| New lib | 1 (quiz data) |
| Updated routing | 1 (DomainRouter) |
| Updated nav | 1 (MarketingLayout) |
| Updated edge functions | 2 (sitemap, render-page) |
| Translation files | 6 languages × marketing.json |
| Other | llms.txt |

