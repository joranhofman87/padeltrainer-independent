

## Player Redirect Banner

**What:** A new `PlayerBanner` component placed between `SocialProofStrip` and `PadelRealitiesSection` on the homepage. It acts as a quick off-ramp for players who landed on the trainer-focused homepage, surfacing the same options from the "Players" mega menu.

**Design:** A visually distinct horizontal banner (accent background, e.g. `bg-primary/5 border-primary/20`) with:
- Headline: "Are you a padel player?" 
- Subtitle: "We've got you covered too"
- A row of 4-5 card-style links matching the Players mega menu items:
  - Find Trainers (Dumbbell icon) → `/trainers`
  - Find Club (MapPin icon) → `/locations`
  - Padel Rules (BookOpen icon) → `/padel-rules`
  - Video Tips (Video icon) → `/video-tips`
  - Blog (PenLine icon) → `/blog`
- Each card shows icon + label + short description, clickable via `LocalizedLink`

**Layout:** On desktop, a horizontal row of cards. On mobile, a scrollable horizontal strip or 2-column grid.

**Files to create/modify:**
1. **`src/components/home/PlayerBanner.tsx`** — New component with the banner UI, using icons and links matching the Players mega menu
2. **`src/pages/marketing/Home.tsx`** — Add lazy-loaded `PlayerBanner` between `SocialProofStrip` and `PadelRealitiesSection`
3. **Translation files** (en, nl, es, de, fr `marketing.json`) — Add keys:
   - `homev2.playerBanner.headline` — "Are you a padel player?"
   - `homev2.playerBanner.subtitle` — "We've got you covered too"

Existing mega menu description translations will be reused for the card descriptions.

