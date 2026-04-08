

# Padel Challenge Mode — Implementation Plan

## What We're Building

A two-mode random challenge card generator at `/:lang/playground/challenge-mode`. Players pick Practice (skill drills) or Game (match modifiers), choose a difficulty, and tap to get a random challenge card with a flip animation. 44 challenges, no login required. Community suggestion form stores submissions for admin review.

## Architecture

Static challenge data lives in `src/lib/challengeModeData.ts` (same pattern as `redFlagQuizData.ts`). No database needed for the challenges themselves. One new DB table for community suggestions.

## Database (1 migration)

### `challenge_suggestions` table
- `id` (uuid), `name` (text), `description` (text), `mode` (text: practice/game/both), `difficulty` (text), `skill_benefit` (text, nullable), `submitter_name` (text, nullable), `submitter_email` (text, nullable), `status` (text, default 'pending'), `created_at`
- RLS: anyone can insert (anon + authenticated), only admins can read/update

## New Files

### 1. `src/lib/challengeModeData.ts`
All 44 challenges as a typed array. Each challenge:
```typescript
interface Challenge {
  id: number;
  title: string;
  description: string;
  tip: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'chaos';
  mode: 'practice' | 'game' | 'both';
  category: 'shot-restriction' | 'scoring' | 'movement' | 'tactical' | 'communication' | 'fun';
  icon: string;
  duration: string;
}
```
All text hardcoded in English for MVP (no i18n for 44 challenge descriptions initially, translations can be added later). Page-level UI strings go in `marketing.json`.

### 2. `src/pages/marketing/ChallengeModeePage.tsx`
Single-page flow:
- **Mode selection** — two cards (Practice / Game) with toggle at top once selected
- **Generator** — large challenge card in center, "Next Challenge" button, difficulty filter chips (Easy/Medium/Hard/Chaos)
- **Card flip animation** via framer-motion (rotateY transform)
- **Share** — copy link with `?c=ID` param, download card as PNG (reuse SVG-to-PNG pattern from red flag quiz), WhatsApp share
- **Deep link** — if `?c=` param present, show that specific challenge with "Try your own" CTA
- **"How to Play"** collapsible section at bottom
- **"Suggest a Challenge"** link opens a modal/drawer with the submission form

### 3. `src/components/challengemode/ChallengeCard.tsx`
The collectible card component. Dark background, difficulty-colored glow, emoji icon, title, description, tip box, duration badge, mode badge.

### 4. `src/components/challengemode/SuggestChallengeForm.tsx`
Simple form (name, description, mode, difficulty, skill, submitter name/email). Inserts into `challenge_suggestions` table. Shows confirmation toast on success.

### 5. `src/components/challengemode/ChallengeShareCard.ts`
SVG builder for downloadable PNG (same pattern as `redFlagShareCard.ts`). Shows the challenge card with PadelTrainer.ai branding.

## Modified Files

| File | Change |
|---|---|
| `src/pages/marketing/Playground.tsx` | Add 5th card: Challenge Mode (🎲) |
| `src/components/DomainRouter.tsx` | Add `playground/challenge-mode` route |
| 6x `marketing.json` | Add UI strings (page title, subtitle, mode labels, difficulty labels, form labels, CTAs) |
| `supabase/functions/sitemap/index.ts` | Add to static pages |
| `supabase/functions/render-page/index.ts` | Add meta tags |
| `public/llms.txt` | Add URL |

## Viral Angle

- **Share a specific challenge** via `?c=ID` deep link. Recipient sees the card and a "Spin your own" CTA.
- **WhatsApp share** with pre-filled text: "Try this padel challenge: [title]. Can you handle it? 🎲"
- **Downloadable card image** (branded PNG) for Instagram stories
- **Challenge counter** on page: "44 challenges and counting. Suggest yours." — community involvement drives sharing

## Mobile-First Design

The prompt is right that this is a courtside tool. The card takes ~60% of viewport, big tap target for "Next Challenge", difficulty chips are thumb-friendly, minimal scrolling needed.

## What We're NOT Building

- Challenge of the Day
- Combo Mode / Difficulty Ladder
- Multiplayer sync / room codes
- Admin moderation UI for suggestions (can reuse admin patterns later)
- i18n for all 44 challenge descriptions (English-only for MVP)

## File Summary

| File | Type |
|---|---|
| Migration SQL | New table + RLS |
| `src/lib/challengeModeData.ts` | New — 44 challenges |
| `src/pages/marketing/ChallengeModePage.tsx` | New — main page |
| `src/components/challengemode/ChallengeCard.tsx` | New — card UI |
| `src/components/challengemode/SuggestChallengeForm.tsx` | New — community form |
| `src/components/challengemode/ChallengeShareCard.ts` | New — SVG for PNG export |
| `src/pages/marketing/Playground.tsx` | Add 5th card |
| `src/components/DomainRouter.tsx` | Add route |
| 6x `marketing.json` | UI translation keys |
| `sitemap/index.ts` | Add static page |
| `render-page/index.ts` | Add meta tags |
| `llms.txt` | Add URL |

