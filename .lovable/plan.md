
Fix the logo by changing the export strategy, not by tweaking the current size again.

## Root cause
The logo is being embedded in `src/lib/ratingShareCard.ts` as a base64 `<image>` that points to the full `src/assets/logo-light.svg`. That SVG is not a clean icon asset:
- it uses `viewBox="0 660 1500 180"` instead of a normalized origin
- it contains many transformed path groups from a design export
- it is being rendered as a nested SVG image inside another generated SVG, then converted again to PNG

That combination is exactly the kind of thing that gets clipped/chopped during SVG-to-canvas export. The screenshot matches that failure.

## Best fix
Use a dedicated export-safe logo for share cards instead of embedding the app logo file directly.

## Changes

### 1. Add a simplified share-logo asset
Create a new export-specific logo asset with a normalized viewBox starting at `0 0`, sized for wide horizontal use on dark backgrounds.

Best options:
- preferred: a clean `logo-share-light.svg` built from the existing wordmark paths but re-exported with a proper viewBox
- fallback: a text-based wordmark styled to match the brand if we want maximum rendering reliability

This avoids nesting the current problematic SVG as-is.

### 2. Update `src/lib/ratingShareCard.ts`
Replace the current base64 `<image ... href="data:image/svg+xml;base64,...">` approach with one of these safer patterns:
- inline normalized SVG markup directly in the generated share-card SVG, or
- embed the new simplified logo asset instead of `logo-light.svg`

Also slightly increase the top spacing so the logo has more breathing room and cannot appear visually cramped.

### 3. Keep branding consistent in the UI preview
Update `src/components/player/RatingShareCard.tsx` to use the same export-safe logo asset so the on-screen preview matches the downloaded PNG.

### 4. Align OG image branding too
Update `supabase/functions/rating-og-image/index.ts` to use the same cleaned branding treatment instead of the plain text placeholder. That way:
- download image
- public share preview
- WhatsApp/OG preview
all use the same stable logo rendering path.

## Files to update

| File | Change |
|------|--------|
| `src/assets/logo-share-light.svg` | New normalized export-safe logo asset |
| `src/lib/ratingShareCard.ts` | Replace nested base64 app logo with export-safe logo rendering |
| `src/components/player/RatingShareCard.tsx` | Use same logo asset for consistency |
| `supabase/functions/rating-og-image/index.ts` | Reuse same cleaned logo treatment |

## Implementation note
Do not keep adjusting width/height on the current embedded logo. The issue is the source asset/rendering method, not just the dimensions.

## Expected result
- no more chopped logo in downloads
- cleaner top branding
- same logo treatment across dashboard preview, downloaded image, and share preview
