

## Add Visual Elements to Homepage Sections

The homepage currently has 7 below-fold sections that are almost entirely text + icons. The Hero already has interactive mock screens, and SocialProofStrip has photos/logos. The remaining sections need visual support.

### Strategy

Rather than using stock photos or AI-generated images (which would look generic), we'll use **illustrated UI mock-ups** built with Tailwind — similar to the Hero's mock screens. These are lightweight, on-brand, and actually show the product. For the "problem" sections, we'll use simple visual metaphors.

### Section-by-section plan

**1. PadelRealitiesSection** (before/after cards)
- Add a small emoji or visual icon per card that represents the "chaos" scenario (e.g., phone for WhatsApp chaos, calendar-x for no-shows, coins for payment chasing)
- Add a subtle background illustration on the sticky left side — a messy WhatsApp-style chat mockup (built in Tailwind, not an image) showing chaotic messages, crossed out and faded, reinforcing "this is what you're leaving behind"

**2. SolutionOverview** (4 value props in a 2x2 grid)
- Upgrade from icon+text rows to **card-style layout** with a small illustrative mock per card:
  - "Filled schedule" → mini calendar grid showing green filled slots
  - "Less admin" → mini to-do list with items auto-checked
  - "No-show protection" → shield with a cancelled slot being blocked
  - "Player experience" → mini phone frame showing a booking confirmation
- Each is a small Tailwind-built illustration (40-60px), not a real image

**3. HowItWorksSection** (3 steps)
- Add a visual mock under each step number:
  - Step 1 (Add availability): Mini weekly calendar grid with some slots highlighted
  - Step 2 (Share your link): A styled link/URL bar with a share button
  - Step 3 (AI handles the rest): A notification-style card showing "New booking from Ana M."
- These are simple Tailwind components, ~100px tall, sitting between the step number and the text

**4. JobsToBeDoneSection** (3 persona cards)
- Add a small contextual illustration at the top of each card (above the icon):
  - Academy: mini org chart / team grid
  - Trainer: mini schedule view
  - Club: mini building with courts
- Keep these as simple SVG or Tailwind illustrations, replacing the current plain icon boxes

### Files to create/modify

1. **`src/components/home/HowItWorksSection.tsx`** — Add inline mini-mock components per step
2. **`src/components/home/SolutionOverview.tsx`** — Upgrade to card layout with mini illustrations
3. **`src/components/home/PadelRealitiesSection.tsx`** — Add a "chaos chat" mockup on the sticky left side and per-card visual hints
4. **`src/components/home/JobsToBeDoneSection.tsx`** — Add small visual headers to persona cards

### What we're NOT changing
- HeroSection (already has interactive mocks)
- SocialProofStrip (already has photos/logos)
- PricingPreview (standard pricing cards, visuals would distract)
- FAQSection (accordion pattern, no visuals needed)
- FinalCTASection (CTA banner, keep clean)
- PlayerBanner (just added, looks good)

### Technical approach
- All visuals are Tailwind-built components (no external images to load)
- This keeps bundle size small and ensures they match the design system
- No translation changes needed — these are purely visual

