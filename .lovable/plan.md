

## Move Videos to Bottom + Fix Instagram Reel Embeds

### 1. Fix Instagram Reel Embed URLs

The current code always generates `instagram.com/p/{id}/embed/` even for Reels. Reels need `instagram.com/reel/{id}/embed/` to play correctly inline. Without this, Instagram redirects or fails to load the video.

**File: `src/lib/videoEmbed.ts`**
- Track whether the URL is a reel vs. a post
- Generate `/reel/{id}/embed/` for reels and `/p/{id}/embed/` for posts
- Add `?cr=1&v=14&wp=540` query params which improve inline playback reliability

### 2. Fix VideoGallery Instagram rendering

**File: `src/components/profiles/VideoGallery.tsx`**
- Instagram embeds don't fit well in `aspect-video` (16:9) containers since they're vertical content. Use a taller aspect ratio for Instagram embeds (e.g. 4:5 or 9:16)
- Add `scrolling="no"` to prevent double scrollbars on the Instagram iframe
- Ensure the iframe allows scripts needed for Instagram's embedded player

### 3. Move VideoGallery to bottom of pages

**File: `src/pages/TrainerProfile.tsx`**
- Move `<VideoGallery trainerProfileId={trainer.id} />` from inside `ProfileMainColumn` (line 584) to a `ProfileFullWidthSection` after the Reviews section (after line 758), so it appears near the bottom of the page

**File: `src/pages/AcademyPublicProfile.tsx`**
- Move `<VideoGallery academyProfileId={academy.id!} />` from inside `ProfileMainColumn` (line 357) to a new `ProfileFullWidthSection` after the Reviews section (after line 474), before the Locations section

### Summary of positioning (top to bottom)

**Trainer profile:**
1. Hero card
2. Content grid (coaching method, about, academy, locations, reviews in main column + stats/contact/specializations in sidebar)
3. Videos (full width, new position)

**Academy profile:**
1. Hero card
2. Content grid (about + quick stats)
3. Trainers
4. Open registrations / waiting list
5. Reviews
6. Videos (full width, new position)
7. Locations

