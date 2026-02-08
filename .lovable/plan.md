
# Add Logo to App Sidebars and Marketing Site

## Overview
Add the uploaded logo images (dark and white variants) across all sidebars and update the marketing site to use the actual logo image instead of text-only branding. The logo placement at the top of each sidebar will add visual breathing room and push content down.

## Logo Files
- `PadelTrainer.ai_5.png` -- dark text logo (for light mode)
- `PadelTrainer.ai_3.png` -- white text logo (for dark mode)

Both will be copied to `src/assets/` and imported as ES6 modules for proper bundling.

## Changes

### 1. Copy logo files to project
- `src/assets/logo-dark.png` -- the dark-text version (for light backgrounds)
- `src/assets/logo-light.png` -- the white-text version (for dark backgrounds)

### 2. Create a reusable `Logo` component (`src/components/Logo.tsx`)
A small component that renders the correct logo variant based on the current theme (light/dark mode). Accepts size props for flexibility. When collapsed in sidebar, shows just the icon/small version.

### 3. Update all 4 app sidebars
Add the logo at the very top of the `SidebarHeader`, above the existing avatar/profile section, with some spacing (`py-3`). This pushes content down and gives the sidebar a more polished feel.

| Sidebar File | Change |
|---|---|
| `src/components/trainer/TrainerSidebar.tsx` | Add logo above avatar section in header |
| `src/components/player/PlayerSidebar.tsx` | Add logo above avatar section in header |
| `src/components/academy/AcademySidebar.tsx` | Add logo above avatar section in header |
| `src/components/admin/AdminSidebar.tsx` | Add logo above shield icon in header |

When the sidebar is collapsed, the logo will hide (since the full wordmark doesn't fit in the icon-width sidebar).

### 4. Update marketing site header and footer
Replace the text-based `PadelTrainer.ai` branding in `MarketingLayout.tsx` (both the navigation header and the footer) with the actual logo image, using the theme-aware Logo component.

## Technical Details

**Logo component** will use `next-themes`' `useTheme()` hook (already in the project) to detect dark/light mode and render the appropriate image variant:

```text
src/components/Logo.tsx
  - import logoDark from "@/assets/logo-dark.png"
  - import logoLight from "@/assets/logo-light.png"
  - useTheme() to pick variant
  - <img> with configurable className for sizing
```

**Sidebar header structure** (same pattern for all 4):

```text
<SidebarHeader>
  [Logo row - new, with padding]       <-- NEW
  [Existing avatar/profile section]     <-- EXISTING (unchanged)
</SidebarHeader>
```

### Files summary

| File | Action |
|---|---|
| `src/assets/logo-dark.png` | Copy from uploaded file |
| `src/assets/logo-light.png` | Copy from uploaded file |
| `src/components/Logo.tsx` | New reusable component |
| `src/components/trainer/TrainerSidebar.tsx` | Add logo to header |
| `src/components/player/PlayerSidebar.tsx` | Add logo to header |
| `src/components/academy/AcademySidebar.tsx` | Add logo to header |
| `src/components/admin/AdminSidebar.tsx` | Add logo to header |
| `src/components/marketing/MarketingLayout.tsx` | Replace text logos with image logos |
