

# Add Theme Toggle to All Layouts

## Overview
The dark/light mode toggle component exists but is not rendered anywhere in the UI. This plan adds the `ThemeToggle` component to all navigation headers so users can switch between light, dark, and system themes.

## Changes Required

### 1. Trainer Layout (`src/components/trainer/TrainerLayout.tsx`)
Add `ThemeToggle` to the header bar alongside `LanguageSwitcher` and `ProfileSwitcher`.

```tsx
import { ThemeToggle } from '@/components/ThemeToggle';

// In the header section:
<div className="flex items-center gap-2">
  <LanguageSwitcher />
  <ThemeToggle />  {/* Add here */}
  <ProfileSwitcher context="trainer" />
  ...
</div>
```

### 2. Player Layout (`src/components/player/PlayerLayout.tsx`)
Add `ThemeToggle` to the player navigation header.

### 3. Club Layout (`src/components/club/ClubLayout.tsx`)
Add `ThemeToggle` to the club navigation header.

### 4. Marketing Layout (`src/components/marketing/MarketingLayout.tsx`)
Add `ThemeToggle` to the public-facing marketing navigation so visitors can also toggle themes.

## Technical Details

- **Component**: Already exists at `src/components/ThemeToggle.tsx`
- **Provider**: Already configured in `App.tsx` with `next-themes`
- **Styling**: CSS variables already defined for both `:root` (light) and `.dark` (dark) in `index.css`
- **Translations**: Already available in `common.json` under `theme.light`, `theme.dark`, `theme.system`, and `toggleTheme`

## Files to Modify
1. `src/components/trainer/TrainerLayout.tsx` - Add ThemeToggle import and component
2. `src/components/player/PlayerLayout.tsx` - Add ThemeToggle import and component
3. `src/components/club/ClubLayout.tsx` - Add ThemeToggle import and component
4. `src/components/marketing/MarketingLayout.tsx` - Add ThemeToggle import and component

## Estimated Effort
Minimal - just importing and adding one component to each layout file.

