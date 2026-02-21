

## Persist User Language Preference + Fix Build Error

### 1. Fix Build Error (forward-invoice)

The `forward-invoice` edge function uses `npm:resend@2.0.0` which fails in the current Deno environment. Fix by switching the import to use `esm.sh` like other edge functions in the project.

### 2. Database: Add `preferred_language` Column

Add a `preferred_language TEXT DEFAULT 'nl'` column to the `profiles` table and backfill all existing rows to `'nl'`.

### 3. Add Language Setting to All Settings Pages

Instead of the globe icon in the header/sidebar, add a "Language" card/item to each settings page:

- **TrainerSettings.tsx**: Add a Language card (similar to existing cards like Calendar Sync) with a select dropdown for English/Dutch
- **PlayerSettings.tsx**: Add a Language settings item card
- **ClubSettings.tsx**: Add a Language card
- **AcademySettings.tsx**: Add a Language card

Each will show a simple select (English / Nederlands) that updates `profiles.preferred_language` and calls `i18n.changeLanguage()`.

### 4. Remove LanguageSwitcher from Navigation

Remove the `LanguageSwitcher` component from:
- `MarketingLayout.tsx` (header and mobile menu)
- `PlayerSidebar.tsx`

Keep the marketing site language detection via URL path (e.g., `/en/`, `/nl/`) -- that still works automatically.

### 5. Apply Saved Language on Login

Update `useAuth.tsx` to call `i18n.changeLanguage(profile.preferred_language)` after fetching the user profile, so the app always loads in their saved language.

### 6. Save Language on Signup

After successful signup in each signup page (`PlayerSignup.tsx`, `ClubSignup.tsx`, `AcademySignup.tsx`, and the `signup-user` edge function for trainers), save the current `i18n.language` to the new `preferred_language` column.

### 7. Update TypeScript Types

Add `preferred_language: string | null` to the `UserProfile` interface in `src/lib/auth.ts`.

### Technical Details

**Files to create:** None

**Files to modify:**
| File | Change |
|------|--------|
| `supabase/functions/forward-invoice/index.ts` | Fix Resend import (esm.sh) |
| Database migration | Add `preferred_language` column, backfill to `'nl'` |
| `src/lib/auth.ts` | Add `preferred_language` to `UserProfile` |
| `src/hooks/useAuth.tsx` | Apply saved language on login |
| `src/pages/TrainerSettings.tsx` | Add language select card |
| `src/pages/PlayerSettings.tsx` | Add language select card |
| `src/pages/club/ClubSettings.tsx` | Add language card |
| `src/pages/academy/AcademySettings.tsx` | Add language card |
| `src/components/marketing/MarketingLayout.tsx` | Remove LanguageSwitcher |
| `src/components/player/PlayerSidebar.tsx` | Remove LanguageSwitcher |
| `src/pages/PlayerSignup.tsx` | Save language on signup |
| `src/pages/ClubSignup.tsx` | Save language on signup |
| `src/pages/AcademySignup.tsx` | Save language on signup |
| `supabase/functions/signup-user/index.ts` | Accept and save language for trainers |

