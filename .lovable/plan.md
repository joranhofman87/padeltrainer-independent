

## Add "Players" dropdown menu to marketing header

Add a "Players" dropdown/submenu to the desktop and mobile navigation in `MarketingLayout.tsx` with the following items:

- Find Trainers → `/trainers`
- Find Club → `/locations`
- Padel Strokes → `/padel-strokes`
- Padel Rules → `/padel-rules`
- Video Tips → `/video-tips`
- Coaches → `/padel-coaches`

### Implementation

**File: `src/components/marketing/MarketingLayout.tsx`**

1. **Desktop**: Use a hover-triggered dropdown (CSS group-hover or a lightweight popover). Render a "Players" label in the nav bar that reveals a vertical list of `LocalizedLink` items on hover. No heavy library needed — a `relative` parent with an absolutely positioned dropdown using Tailwind `group` + `group-hover:block` pattern keeps it simple and consistent.

2. **Mobile**: In the mobile menu, render "Players" as a collapsible section (toggle with state) that expands to show the same sub-links indented underneath.

3. **Nav structure change**: The `navLinks` array stays for flat links (Home, Pricing, About, Blog). The Players dropdown is rendered separately between Home and Pricing in the desktop nav, and as an expandable group in the mobile menu.

### Desktop dropdown structure (rough)
```text
 Home   Players ▾   Pricing   About   Blog
           ┌──────────────────┐
           │ Find Trainers    │
           │ Find Club        │
           │ Padel Strokes    │
           │ Padel Rules      │
           │ Video Tips       │
           │ Coaches          │
           └──────────────────┘
```

Uses Tailwind `group`/`group-hover` for zero-JS hover menu on desktop, and a `useState` toggle for mobile accordion. All links use `LocalizedLink` for proper language prefixing.

