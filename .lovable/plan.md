

## Fix Light Mode Issues in Sidebar

### Problem
The sidebar has a dark background in **both** light and dark modes (by design -- navy sidebar). However, two elements don't account for this:

1. **Logo**: The `Logo` component picks `logo-dark.svg` in light mode (designed for light backgrounds), but the sidebar background is always dark. Result: dark logo on dark background = invisible.

2. **"View Public Profile" button**: Uses `variant="outline"`, which inherits light-mode colors (`bg-background` = white, light border). On the dark sidebar, this creates a jarring white button that doesn't match.

### Solution

**1. Logo -- always use the light variant in sidebars**

Update the `Logo` component to accept an optional `forceDark` prop (or similar like `variant`). When used inside sidebars, pass this prop so it always renders `logo-light.svg` (the one designed for dark backgrounds), since the sidebar is always dark.

Affected files:
- `src/components/Logo.tsx` -- add `variant?: 'auto' | 'light' | 'dark'` prop
- `src/components/trainer/TrainerSidebar.tsx` -- pass `variant="dark"` to Logo
- `src/components/player/PlayerSidebar.tsx` -- pass `variant="dark"` to Logo
- `src/components/academy/AcademySidebar.tsx` -- pass `variant="dark"` to Logo (if it uses Logo)
- `src/components/club/ClubSidebar.tsx` -- pass `variant="dark"` to Logo (if it uses Logo)
- `src/components/admin/AdminSidebar.tsx` -- pass `variant="dark"` to Logo (if it uses Logo)

**2. "View Public Profile" button -- use sidebar-compatible styling**

Change the button from `variant="outline"` to `variant="ghost"` and add sidebar-friendly text color classes so it blends with the dark sidebar in both themes.

Affected files:
- `src/components/trainer/TrainerSidebar.tsx` -- update button variant and add `text-sidebar-foreground` class

### Technical Details

**Logo component change:**
```tsx
interface LogoProps {
  className?: string;
  variant?: 'auto' | 'dark';  // 'dark' = always show light logo (for dark backgrounds)
}

export function Logo({ className = 'h-7', variant = 'auto' }: LogoProps) {
  const { resolvedTheme } = useTheme();
  const src = variant === 'dark'
    ? logoLight
    : resolvedTheme === 'dark' ? logoLight : logoDark;
  // ...
}
```

**Button change:**
```tsx
<Button
  variant="ghost"
  size={collapsed ? "icon" : "sm"}
  className={cn(
    collapsed ? "h-8 w-8" : "w-full justify-start",
    "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
  )}
  onClick={handleViewPublicProfile}
>
```

