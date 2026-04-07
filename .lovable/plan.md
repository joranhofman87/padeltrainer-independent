

# Fix: Active Language Not Clearly Visible in Dropdown

## Problem

The selected language uses `bg-accent` which blends into the dark dropdown background, making it hard to see which language is active (visible in screenshot with Italian selected).

## Solution

Replace the subtle `bg-accent` with a more prominent active state using the primary color and a check mark icon.

## Changes

### File: `src/components/LanguageSwitcher.tsx`

- Change the active item class from `'bg-accent'` to `'bg-primary/10 text-primary font-semibold'` for a clear visual distinction
- Add a `Check` icon from lucide-react on the right side of the active language item
- This works in both light and dark mode since it uses the theme's primary color

