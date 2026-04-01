

# Final Homepage Adjustments — 8 Changes

## 1. Remove Featured Trainers & Academies
Remove `HomeFeaturedSections` from `Home.tsx` — delete the import and the `<HomeFeaturedSections />` component from the JSX.

## 2. Reorder bottom sections
New order in `Home.tsx`:
```
PlayerBanner → PricingPreview → FAQSection → FinalCTASection
```
Move `FinalCTASection` after `FAQSection` (currently it's already last before HomeFeaturedSections, so just removing HomeFeaturedSections achieves this).

## 3. Fix pill wrapping in PlayerBanner
In `PlayerBanner.tsx`, reduce pill padding from `px-4` to `px-3` and narrow the left text column from `md:max-w-md` to `md:max-w-sm` to give pills more room.

## 4. Scale up HowItWorks mini illustrations
In `HowItWorksSection.tsx`:
- `MiniWeekCalendar`: increase `p-4` → `p-5`, slot size `h-5 w-7` → `h-7 w-10`, gap `gap-3` → `gap-4`
- `MiniShareLink`: increase padding `px-4 py-3` → `px-5 py-4`, text `text-xs` → `text-sm`
- `MiniNotification`: increase icon `h-8 w-8` → `h-10 w-10`, text sizes up one step
- Increase `min-h-[60px]` → `min-h-[80px]` on the visual container

## 5. Tighten spacing between middle sections
- `PainStoriesSection`: reduce `py-24 md:py-32` → `py-16 md:py-20`
- `SolutionOverview`: reduce `py-24 md:py-32` → `py-16 md:py-20`
- `HowItWorksSection`: reduce `py-24 md:py-32` → `py-16 md:py-24`

## 6. Feature cards hover effect
In `SolutionOverview.tsx`, add `hover:-translate-y-0.5 hover:shadow-lg transition-all duration-200` to each card's className.

## 7. Hero mockup shadow
In `HeroSection.tsx`, the mockup container already has `shadow-2xl`. Add a more specific custom shadow: `shadow-[0_4px_24px_rgba(0,0,0,0.08)]` to the outer container for a softer float effect. Also add `rounded-xl` to the full container (currently `rounded-b-xl rounded-t-none` — keep the tab bar border but add shadow to wrapper).

## 8. Stats row visual separation
In `SocialProofStrip.tsx`, wrap the metrics row in a container with `border-y border-border/50 py-8` and give it a subtle background `bg-[#FAFAFA] rounded-xl px-8`.

## Files Changed

| File | Change |
|------|--------|
| `src/pages/marketing/Home.tsx` | Remove HomeFeaturedSections, reorder sections |
| `src/components/home/PlayerBanner.tsx` | Tighter pills, narrower left column |
| `src/components/home/HowItWorksSection.tsx` | Scale up illustrations ~40% |
| `src/components/home/PainStoriesSection.tsx` | Reduce vertical padding |
| `src/components/home/SolutionOverview.tsx` | Reduce padding, add hover translateY |
| `src/components/home/HeroSection.tsx` | Softer mockup shadow |
| `src/components/home/SocialProofStrip.tsx` | Stats row dividers + subtle bg |

