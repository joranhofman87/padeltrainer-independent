

# Fix Dark Mode Text Visibility

## Problem

Two hardcoded color values break dark mode:

1. **All section headings** use `text-[hsl(var(--brand-navy))]` — a dark navy (`220 60% 20%`) that's invisible on dark backgrounds. This affects **9 files** across the homepage.

2. **`.section-alt` background** in `src/index.css` is hardcoded `#F8F8F6` (light beige) — creates a jarring light block in dark mode.

## Solution

### 1. Replace heading color class (9 files)

Replace all instances of `text-[hsl(var(--brand-navy))]` with `text-foreground` which automatically adapts to dark mode (dark navy in light → light text in dark).

**Files affected:**
- `src/components/home/HeroSection.tsx`
- `src/components/home/PainStoriesSection.tsx`
- `src/components/home/SolutionOverview.tsx`
- `src/components/home/HowItWorksSection.tsx`
- `src/components/home/JobsToBeDoneSection.tsx`
- `src/components/home/PlayerBanner.tsx`
- `src/components/home/PricingPreview.tsx`
- `src/components/home/FAQSection.tsx`
- `src/components/home/SocialProofStrip.tsx`

### 2. Fix `.section-alt` background (`src/index.css`)

Change from hardcoded `#F8F8F6` to a dark-mode-aware approach:

```css
.section-alt {
  background-color: hsl(var(--secondary));
}
```

This uses the existing `--secondary` token which is `220 30% 94%` in light (similar to current beige) and `220 30% 18%` in dark.

## Summary

| File | Change |
|---|---|
| 9 home section components | `text-[hsl(var(--brand-navy))]` → `text-foreground` |
| `src/index.css` | `.section-alt` background → `hsl(var(--secondary))` |

