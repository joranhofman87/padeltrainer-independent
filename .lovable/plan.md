

## Video Tips: Embedded Player + Listing Page with Filters

### Current State
- **VideoTipPage** (detail): Shows a thumbnail image + "Watch on YouTube" button — no embedded player
- **VideoTipCard**: Same — thumbnail + external link, no embed
- **No listing page** exists at `/video-tips` — only detail pages at `/video-tips/:slug`
- **`parseVideoUrl`** in `src/lib/videoEmbed.ts` already supports YouTube, Vimeo, TikTok, Instagram embedding
- Only 1 video tip in Sanity currently, but the infrastructure should support filtering by stroke, skill level, tags, trainer, and platform

### Plan

#### 1. Embed videos on the detail page (`VideoTipPage.tsx`)
- Replace the static thumbnail + "Watch on external site" button with an embedded iframe using `parseVideoUrl()` from `src/lib/videoEmbed.ts`
- Keep the external link as a secondary action below the embed
- Fall back to thumbnail + external link if `parseVideoUrl` returns null

#### 2. Embed videos on the card (`VideoTipCard.tsx`)
- Replace the thumbnail with an actual embedded player (or keep thumbnail with a play overlay that links to the detail page)
- Better approach: keep the thumbnail on the card for performance, link to the detail page where the embed lives

#### 3. Create listing page (`src/pages/marketing/VideoTips.tsx`) at `/video-tips`
- Hero section matching the Strokes page style
- Fetch all video tips with a new `VIDEO_TIPS_LIST_QUERY` in `src/lib/sanity.ts`
- **Filters** (client-side, since data volume is small):
  - **Stroke** — dropdown/badge filter from dereferenced strokes
  - **Skill Level** — badge filter (beginner/intermediate/advanced)
  - **Tags** — clickable tag badges
  - **Trainer** — dropdown or badge filter
- Grid of `VideoTipCard` components, filtered in real-time
- Each card links to `/video-tips/:slug` for the full embedded view

#### 4. Add route + navigation
- Register `/video-tips` route in `DomainRouter.tsx`
- Add "Video Tips" link to the footer's "Learn Padel" section
- Add to the sitemap static pages

### Files to Create/Modify
- **Create**: `src/pages/marketing/VideoTips.tsx` — listing page with filters
- **Modify**: `src/lib/sanity.ts` — add `VIDEO_TIPS_LIST_QUERY`
- **Modify**: `src/pages/marketing/VideoTipPage.tsx` — embed video instead of thumbnail
- **Modify**: `src/components/sanity/VideoTipCard.tsx` — link to detail page instead of external
- **Modify**: `src/components/DomainRouter.tsx` — add `/video-tips` route
- **Modify**: `src/components/marketing/MarketingLayout.tsx` — add Video Tips to footer Learn Padel section
- **Modify**: `supabase/functions/sitemap/index.ts` — add `/video-tips` to static pages

