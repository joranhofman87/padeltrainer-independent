

## Handle White Logos on Light Backgrounds

### Problem
When a trainer, club, or academy uploads a white logo, it becomes invisible against the light theme's white/near-white backgrounds.

### Solution
Add a subtle `shadow-sm` inner shadow and a light `border` to all Avatar/logo containers that display user-uploaded logos. This creates enough contrast for white logos without affecting dark or colored logos. The border uses the existing `border` token which is light gray in light mode and dark gray in dark mode — unobtrusive but effective.

### Approach
Most logo displays already use the `Avatar` component. The fix targets two layers:

1. **`AvatarImage` component** (`src/components/ui/avatar.tsx`): Add a default `rounded-[inherit]` background so the image always sits on a defined surface. Not ideal here since it affects all avatars.

2. **Better approach — targeted CSS class**: Add a utility class `.logo-safe` that applies a subtle inset shadow and border, then apply it to the ~15 Avatar wrappers that display `logo_url`. This is too many touch points.

3. **Simplest approach — update `AvatarImage`**: Since all avatars benefit from having a visible boundary, add a default thin border to the `Avatar` root where it wraps logos. But many already have `border` — the ones that don't are the problem.

**Chosen approach**: Update the `Avatar` component in `src/components/ui/avatar.tsx` to include a very subtle `ring-1 ring-border` by default. This gives every avatar a barely-visible outline that makes white logos visible without affecting the look of photos or colored logos. The `ring-border` uses the theme's border color — very subtle in both modes.

### Files to edit

1. **`src/components/ui/avatar.tsx`** — Add `ring-1 ring-border/50` to the `Avatar` root's default classes. This adds a half-opacity border-colored ring around all avatars, ensuring white logos are always distinguishable from the background while remaining invisible on dark/colored content.

This is a single-line change that fixes the problem globally for all current and future logo usages.

