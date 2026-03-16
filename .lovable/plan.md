

# Marketing Navigation Mega Menu + Light Theme Default

## 1. Default Theme → Light

Change `defaultTheme="system"` to `defaultTheme="light"` in `src/App.tsx`. This makes both the marketing site and app default to light mode. Users can still toggle to dark.

## 2. Mega Menu Navigation (Monday.com / ClickUp style)

Replace the current small dropdown with a full-width mega menu panel that opens on hover, inspired by the reference screenshots.

### Proposed Navigation Structure

```text
┌──────────────────────────────────────────────────────────┐
│ Logo    Players ▾    For Trainers ▾    Pricing  Blog     │  Sign In  [Start Free Trial]
└──────────────────────────────────────────────────────────┘
         │                │
    ┌────▼────────────────▼──────────────────────────────┐
    │  LEARN PADEL          FIND & PLAY         CONTENT  │
    │  ─────────           ──────────           ──────── │
    │  📖 Padel Rules       🎾 Find Trainers    📹 Video │
    │  🏸 Padel Strokes     📍 Find Club          Tips   │
    │  🏫 Coaches           🏫 Academies        📝 Blog  │
    └────────────────────────────────────────────────────┘
```

**"For Trainers"** dropdown (new):
```text
    ┌─────────────────────────────────────┐
    │  FOR TRAINERS         FOR ACADEMIES │
    │  ──────────           ───────────── │
    │  Platform overview    Manage teams  │
    │  Pricing              Registration  │
    │  Start free trial     cycles        │
    │                       Partner with  │
    │                       us            │
    └─────────────────────────────────────┘
```

### Technical Approach

- Build a reusable `MegaMenuPanel` component with multi-column grid layout
- Each column has a header (uppercase label) and icon+text link items
- Panel appears on hover with a subtle fade-in animation and a semi-transparent backdrop
- On mobile: remains an accordion (current pattern works fine)
- Remove standalone "Home" link (logo already links home)
- Move "About" into footer or keep as standalone link

### Files to Change

1. **`src/App.tsx`** — Change `defaultTheme="system"` → `defaultTheme="light"`
2. **`src/components/marketing/MarketingLayout.tsx`** — Replace the simple Players dropdown with mega menu panels, reorganize nav items into "Players" and "For Trainers" mega menus, keep Pricing/Blog/About as standalone links

