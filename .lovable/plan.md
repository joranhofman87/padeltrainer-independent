

## Make Player Banner Less Generic and Cards Equal Size

**Problems identified:**
1. Cards have unequal heights because some descriptions wrap to 2 lines ("Discover padel clubs nearby", "Improve your game with video") while others stay on 1 line
2. The overall look feels too template-y: centered layout, uniform rounded icon circles, generic copy

**Changes:**

### 1. `src/components/home/PlayerBanner.tsx`
- Add `h-full` to the `LocalizedLink` so all cards stretch to the same height within the grid
- Remove the staggered motion animation on individual cards (too "AI landing page")
- Simplify the icon presentation -- remove the rounded background circle, just show the icon directly
- Make the headline left-aligned or use a more casual tone
- Remove the outer `motion.div` wrapper per card, keep just one subtle entrance for the whole section

### 2. Translation files (en, nl, de, fr, es `marketing.json`)
- Shorten/equalize description lengths so cards look balanced:
  - `trainersDesc`: "Book a session near you" (keep)
  - `locationsDesc`: "Find clubs near you" (shorter)
  - `rulesDesc`: "Learn the official rules" (keep)
  - `videoTipsDesc`: "Watch & improve" (shorter)
  - `blogDesc`: "Tips, guides & news" (keep)
- Make the subtitle more casual: "Here's what we've got for you" instead of "We've got you covered too."

### Technical details
- The equal-height fix: add `h-full` to the `LocalizedLink` element so CSS grid stretches all cards equally
- Remove per-card `motion.div` wrappers, keep only the section-level fade-in
- Drop the `bg-primary/10 rounded-lg` icon wrapper, use plain icon with `text-primary`

