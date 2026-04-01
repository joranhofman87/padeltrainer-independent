

# Remove All Gradient Backgrounds — Clean White Everywhere

## Summary
Replace all gradient backgrounds across the entire app with clean `bg-background` (white in light mode, dark in dark mode). This affects ~37 files.

## Categories of Changes

### 1. Layout-level gradients (3 files)
- **`TrainerLayout.tsx`** — `bg-gradient-to-br from-orange-50 via-background to-orange-100/30 ...` → `bg-background`
- **`PlayerLayout.tsx`** — `bg-gradient-to-br from-blue-50 via-background to-blue-100/30 ...` → `bg-background`
- **`AcademyLayout.tsx`** — already `bg-background` ✓

### 2. Auth & onboarding pages (~8 files)
Replace `bg-gradient-to-br from-primary/10 via-background to-secondary/10` → `bg-background` in:
- `Auth.tsx`, `TrainerSignup.tsx`, `PlayerSignup.tsx`, `AcademySignup.tsx`, `AcademyOnboarding.tsx`, `Onboarding.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx`, `VerificationPending.tsx`

### 3. Public/marketing pages (~8 files)
- **`Trainers.tsx`** — page gradient → `bg-background`
- **`Locations.tsx`** — page gradient + hero gradient → `bg-background`
- **`BookLesson.tsx`** — page gradient → `bg-background`
- **`EditProfile.tsx`** — page gradient → `bg-background`
- **Marketing pages** (Pricing, Blog, VideoTips, Rules, About, etc.) — hero section `bg-gradient-to-b from-background to-accent/20` → `bg-background`

### 4. Component-level decorative gradients (~10+ files)
- **`FeaturedSection.tsx`** — `bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5` → light border/background instead
- **Cards with gradient backgrounds** (e.g. TrainerProfile academy card, Pricing card) — `bg-gradient-to-br from-primary/5 to-transparent` → plain card styling
- **Landing page hero** — gradient overlays → `bg-background`

### 5. Gradient badges/buttons — Keep as-is
Small UI elements like `FeaturedBadge` (amber-to-orange gradient on a tiny badge) and CTA buttons stay — these are accent elements, not backgrounds.

## Approach
Simple find-and-replace across all files. Each page/layout wrapper div gets `bg-background` instead of its gradient classes. Hero sections use `bg-background` or `bg-muted/30` for subtle separation.

## Files Changed (~25-30 files)

| Category | Files | Change |
|----------|-------|--------|
| Layouts | `TrainerLayout.tsx`, `PlayerLayout.tsx` | Remove gradient, use `bg-background` |
| Auth | `Auth.tsx`, `*Signup.tsx`, `Onboarding.tsx`, `ForgotPassword.tsx`, `ResetPassword.tsx`, `VerificationPending.tsx` | Same |
| Public | `Trainers.tsx`, `Locations.tsx`, `BookLesson.tsx`, `EditProfile.tsx`, `TrainerProfile.tsx` | Same |
| Marketing | `Pricing.tsx`, `Blog.tsx`, `VideoTips.tsx`, `Rules.tsx`, `About.tsx`, landing sections | Hero gradients → `bg-background` |
| Components | `FeaturedSection.tsx`, various cards | Remove gradient tints |

