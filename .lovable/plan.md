

# Homepage UI Redesign — Monday.com/Slack Inspired

This is a large visual overhaul touching every homepage section. The goal is to go from "template" to "confident product" with bold typography, more whitespace, subtle shadows instead of borders, and alternating section backgrounds.

## Design System Changes

### `src/index.css`
- Override `--background` to pure white `0 0% 100%` (light mode)
- Add utility classes: `.section-alt` for alternating light gray backgrounds (`#F8F8F6`)
- Add `.card-elevated` utility for shadow-on-hover cards

### `tailwind.config.ts` (if needed)
- Ensure brand navy color token exists for section headings

## Component Changes (10 files)

### 1. `HeroSection.tsx` — Bold hero, floating mockup
- Headline: `text-4xl md:text-5xl lg:text-[64px]` with `tracking-[-0.02em]`
- Subheadline: `text-lg md:text-xl` (18-20px)
- Increase section padding to `py-20 md:py-32`
- Primary CTA: larger padding `px-8 py-4`, `rounded-lg`, subtle shadow
- Secondary CTA: add hover background fill
- Product mockup: add `shadow-2xl` drop shadow + slight scale, light blur backdrop
- Tab bar: active tab gets orange bottom border indicator (not bg fill)
- Remove `rounded-tl-none` on the card container

### 2. `SocialProofStrip.tsx` — Bolder metrics, larger avatars
- Remove `border-y bg-muted/30`, use white bg with generous padding (`py-16 md:py-24`)
- Testimonial cards: white bg, `shadow-md`, `rounded-xl`, larger text (18px italic), stars in brand orange (already primary)
- Avatar size: `h-10 w-10` to `h-14 w-14`
- Metrics row: numbers `text-4xl md:text-5xl font-extrabold text-[hsl(var(--brand-navy))]`, labels `text-sm text-muted-foreground`
- Remove icons from metrics (the big numbers ARE the visual)

### 3. `PainStoriesSection.tsx` — Story cards with orange left border
- Section padding: `py-24 md:py-32`
- Headline: `text-3xl md:text-[42px] font-bold tracking-[-0.02em]`
- Cards: remove `rounded-xl border bg-card`, replace with `bg-white rounded-lg border-l-4 border-l-primary shadow-sm p-8`
- Remove red destructive icon backgrounds; use muted icon inline
- Solution text: add `mt-4` spacing before the orange "With PadelTrainer.ai:" line
- Body text: `text-[17px] leading-relaxed`
- Remove `whileInView` animations (show immediately)
- Ensure all 3 cards render (whatsapp, cancellation, payments)
- Replace em dashes with commas or periods in translations

### 4. `SolutionOverview.tsx` — Elevated feature cards
- Section bg: `bg-[#F8F8F6]` (subtle warm gray) instead of `bg-muted/30`
- Section padding: `py-24 md:py-32`
- Heading: `text-3xl md:text-[42px] font-bold tracking-[-0.02em]`
- Cards: remove `border`, add `shadow-sm hover:shadow-lg transition-shadow duration-200`, `rounded-xl`, `p-8`
- Icon visuals: wrap in `h-12 w-12 rounded-xl bg-primary/10` container
- Body text: `text-base` (16px)

### 5. `HowItWorksSection.tsx` — Remove fade animation, oversized numbers
- Section padding: `py-24 md:py-32`
- **Remove all `motion.div` / `whileInView` wrappers** — render at full opacity always
- Step numbers: `text-7xl md:text-8xl font-extrabold text-primary/10` (oversized watermark style)
- Heading: `text-3xl md:text-[42px]`

### 6. `JobsToBeDoneSection.tsx` — Highlighted center card
- Section bg: `bg-[#F8F8F6]`
- Section padding: `py-24 md:py-32`
- Featured (trainer) card: `scale-[1.02] shadow-lg` with `border-primary`
- Non-featured cards: `shadow-sm hover:shadow-md`
- Checkmarks: use `text-primary` (brand orange) — already done
- Remove border on all cards, rely on shadow

### 7. `PlayerBanner.tsx` — Subtle aside
- Add `bg-[#F8F8F6]` background to distinguish as aside
- Keep current compact layout

### 8. `PricingPreview.tsx` — Polish
- Section padding: `py-24 md:py-32`
- Both cards: add `shadow-md`, more padding
- Heading: larger size

### 9. `FAQSection.tsx` — Dividers between items
- Section padding: `py-24 md:py-32`
- Add `divide-y` on the accordion wrapper or ensure `AccordionItem` has border-bottom
- Heading: larger

### 10. `FinalCTASection.tsx` — Dark navy background
- Change from `bg-primary` to `bg-[hsl(var(--brand-navy))]` (dark navy)
- Larger CTA button
- Section padding: `py-24 md:py-32`

### 11. `HomeFeaturedSections.tsx` — Academy description guard
- Add guard: if `academy.description` is shorter than 15 chars or contains generic text like "great academy", hide it

### 12. Translation files (all 5 locales)
- Remove em dashes from all homepage copy, replace with periods or commas
- This affects pain stories and any other sections using " — "

## Section Background Rhythm

```text
Hero              — white
Social Proof      — white
Pain Stories      — white (cards have orange left border)
Solution Overview — light gray (#F8F8F6)
How It Works      — white
Jobs To Be Done   — light gray (#F8F8F6)
Player Banner     — light gray (#F8F8F6)
Pricing           — white
FAQ               — white
Final CTA         — dark navy
Featured          — alternating white / light gray
```

## Files Changed

| File | Change |
|------|--------|
| `src/index.css` | Pure white background, utility classes |
| `src/components/home/HeroSection.tsx` | Bold typography, floating mockup, larger CTAs, tab underline |
| `src/components/home/SocialProofStrip.tsx` | Bigger metrics, larger avatars, shadow cards |
| `src/components/home/PainStoriesSection.tsx` | Orange left-border story cards, remove animations, fix spacing |
| `src/components/home/SolutionOverview.tsx` | Shadow cards, icon circles, warm gray bg |
| `src/components/home/HowItWorksSection.tsx` | Remove fade animations, oversized step numbers |
| `src/components/home/JobsToBeDoneSection.tsx` | Elevated center card, shadow-based styling |
| `src/components/home/PlayerBanner.tsx` | Subtle gray background |
| `src/components/home/PricingPreview.tsx` | Shadow polish, more padding |
| `src/components/home/FAQSection.tsx` | Dividers, larger heading |
| `src/components/home/FinalCTASection.tsx` | Dark navy bg, larger button |
| `src/components/home/HomeFeaturedSections.tsx` | Guard against placeholder descriptions |
| `src/i18n/locales/[en,nl,de,es,fr]/marketing.json` | Remove em dashes from copy |

