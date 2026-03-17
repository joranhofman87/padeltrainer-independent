

## Add Logo Upload to Academy Profile Page

The academy profile page (`AcademyProfile.tsx`) currently has a banner upload but no logo upload. The `academy_profiles` table already has a `logo_url` column, and the `updateAcademyProfile` function supports updating it.

### Changes

**`src/pages/academy/AcademyProfile.tsx`**:
- Add a logo upload section above (or next to) the banner upload card, following the exact same pattern as the banner upload
- Add a `logoInputRef`, `logoUploading` state
- `handleLogoUpload`: validate image type/size, upload to `avatars/academies/{id}/logo.{ext}` (same bucket as banner), get public URL, call `updateAcademyProfile({ logo_url: ... })`, refresh
- Show current logo in a rounded avatar-style preview (square, ~64px), or a placeholder icon if none
- No dimension constraints needed (unlike banner) — just type + max 5MB size check

The UI will be a card at the top with the logo preview on the left, label + hint in the middle, and an upload button on the right — mirroring the existing banner upload card layout.

### Files to modify
- `src/pages/academy/AcademyProfile.tsx` — add logo upload UI + handler

