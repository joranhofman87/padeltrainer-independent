

# UI Refresh for Racket Finder Quiz

## Problem
The racket finder quiz pages (intro, quiz steps, results) look generic and template-like. Plain centered text, basic bordered cards, no visual hierarchy or brand personality.

## Design Direction
Make it feel hand-crafted and premium — closer to a product recommendation tool you'd find on a quality sports site. Key improvements:
- **Intro**: Add a hero section with a subtle gradient background, tighter copy, and a more prominent CTA
- **Quiz steps**: Cards with hover states that feel interactive (subtle scale, gradient border on hover), better visual hierarchy with step indicators
- **Results**: Racket cards with image placeholders, visual score indicators, and clearer hierarchy between top pick and alternatives

## Changes

| File | Change |
|------|--------|
| `src/pages/marketing/RacketFinder.tsx` | Restyle intro section: add gradient bg section, larger heading with gradient text accent, smaller subtitle, pill-shaped CTA with icon. Better spacing. |
| `src/components/racketfinder/QuizQuestion.tsx` | Redesign option cards: add number indicators, subtle left border accent on hover, smoother entrance animations, better mobile spacing. Replace emoji with styled icon badges. |
| `src/components/racketfinder/QuizResults.tsx` | Redesign result cards: top pick gets a highlighted border/gradient top, better badge styling (pill-shaped colored badges instead of plain text), clearer visual separation between specs and description. Add a summary card at top showing the user's selected preferences as pills. |
| `src/components/racketfinder/RacketFinderContent.tsx` | Restyle "How it Works" steps: use a horizontal timeline connector between steps on desktop, numbered circles instead of plain icons. Clean up "Why Use" section with a subtle card background. |

## Visual Details
- **Intro hero**: `bg-gradient-to-b from-primary/5 to-background` with rounded container, centered layout
- **Quiz option cards**: Remove emoji column. Use a subtle left-side colored indicator bar. On hover: `border-primary shadow-md`. Selected state: filled primary left bar + light primary bg
- **Progress bar**: Keep existing but add step dots below
- **Result cards**: Top pick gets `ring-2 ring-primary` + "Best Match" pill badge. Others get standard border. Add preference summary pills (e.g., "Intermediate", "Allround", "€100-150") at top of results
- **Overall**: Consistent `rounded-xl` everywhere, tighter spacing, less wasted whitespace

