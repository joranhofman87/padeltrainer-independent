

# Downloadable & Shareable Red Flag Quiz Result Card

## What We're Building

Apply the same SVG→PNG share card pattern used in the rating dashboard to the Red Flag Quiz results. Users get a branded, dark-themed card they can download as PNG or share natively (with the image attached).

## Approach

Reuse the exact architecture from `src/lib/ratingShareCard.ts` — build an SVG string programmatically, convert to PNG via canvas, then offer download + native share.

## Changes

### 1. New: `src/lib/redFlagShareCard.ts`

SVG builder function for the quiz result card (1080×1350 Instagram Story format):
- Dark gradient background (`#1a1a2e` → `#16213e`, matching rating card)
- Text-based `PADELTRAINER.AI` wordmark at top (same as rating card — no embedded images)
- Large emoji centered
- Profile name + tagline
- Red flags list (🚩) and green flag (🟢)
- Profile-specific accent color for decorative elements
- Footer: `padeltrainer.ai/playground/red-flag-quiz`
- `escSvg` helper for safe text rendering
- Export `buildQuizShareSvg(profile, redFlags, greenFlag, profileName, tagline)` function
- Reuse `svgToPngBlob` from `ratingShareCard.ts` (already exported)

### 2. Update: `src/components/redflagquiz/RedFlagQuizResult.tsx`

Replace current share buttons with the download/share pattern from `RatingHistoryChart.tsx`:
- **Download button** — generates PNG blob, triggers `<a>` download as `red-flag-quiz-result.png`
- **Share button** — uses `navigator.share` with the PNG file attached (falls back to link-only share)
- **Copy link** — keeps existing clipboard behavior
- **WhatsApp / X** — keep existing but also copy image to clipboard first
- Import `svgToPngBlob` from `ratingShareCard.ts` and `buildQuizShareSvg` from new file

### 3. Translation keys

Add to all 6 `marketing.json` files:
- `redFlagQuiz.downloadImage` — "Download Image"
- `redFlagQuiz.shareImage` — "Share"
- `redFlagQuiz.downloadSuccess` — "Image downloaded!"

## File Summary

| File | Change |
|---|---|
| `src/lib/redFlagShareCard.ts` | New — SVG builder for quiz result |
| `src/components/redflagquiz/RedFlagQuizResult.tsx` | Add download/native share using SVG→PNG pipeline |
| 6× `marketing.json` | Add 3 translation keys |

