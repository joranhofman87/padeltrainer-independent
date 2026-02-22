

# Automated Blog Cover Image Generator

## Overview
Build an end-to-end system that generates branded, multilingual cover images for blog articles using AI image generation, stores them in Supabase Storage, and integrates with the existing admin CMS and blog rendering.

## Changes

### 1. Database Migration
Add two columns to the `articles` table:
- `cover_image_alt` (text, nullable) -- alt text for the cover image
- `cover_image_generated_at` (timestamptz, nullable) -- timestamp of last generation

### 2. Supabase Storage
The `blog-images` bucket already exists and is public. We will store cover images under the path pattern:
```
blog-covers/{locale}/{slug}-1200x630.webp
```
No new bucket needed.

### 3. Edge Function: `generate-blog-cover`
A new edge function that:
1. Accepts `{ article_id }` (or `{ canonical_id, all_locales: true }` for batch)
2. Fetches article data (title, locale, slug, meta_title, tags, primary_keyword)
3. Creates a shortened "display title" (max 50 chars, no mid-word truncation, in the article's language)
4. Calls the Lovable AI image generation endpoint (`google/gemini-2.5-flash-image`) with a prompt like:
   - "Create a professional blog cover image (1200x630) for a padel sports website. Style: modern, clean, high contrast. Show a padel court or player in action as background. Overlay text: '{display_title}'. Small 'PadelTrainer.ai' watermark in bottom-right corner. Language: {locale}."
5. Receives the base64 image, converts to WebP
6. Uploads to Storage at `blog-covers/{locale}/{slug}-1200x630.webp`
7. Updates the article row: `cover_image_url`, `cover_image_alt`, `cover_image_generated_at`

**Responsive variants**: Since AI-generated images are raster at 1200x630, we will skip client-side resizing in the edge function (adds complexity with no image processing library in Deno). Instead, we use CSS `aspect-ratio` and `object-fit` on the frontend, and rely on the CDN/browser for scaling. The 1200x630 image serves both OG and on-page needs.

**Batch mode**: When `all_locales: true` is passed with a `canonical_id`, the function fetches all articles with that canonical_id and generates covers for each one that's missing a cover.

### 4. Admin UI Updates

**AdminBlogEditor.tsx** -- Add a "Cover Image" card in the sidebar:
- Preview of current cover image (or placeholder)
- "Generate Cover Image" button (calls `generate-blog-cover` with article_id)
- "Regenerate" button (same call, overwrites existing)
- "Generate for All Locales" button (calls with canonical_id + all_locales)
- Shows `cover_image_generated_at` timestamp
- Loading/error states

**AdminBlog.tsx** -- Add a small cover image thumbnail in the articles table.

### 5. Auto-generation on Publish
In `AdminBlogEditor.tsx`, within the existing save mutation's `onSuccess` handler (which already auto-translates on publish), add logic to auto-generate cover images:
- When status changes to "published" and `cover_image_url` is empty, invoke `generate-blog-cover`
- After translations are created, invoke `generate-blog-cover` with `all_locales: true`

### 6. Blog Post Page Updates

**BlogPost.tsx**:
- Render cover image with explicit `width={1200} height={630}` and `fetchPriority="high"` (no lazy loading for LCP)
- Add `loading="eager"` instead of current `loading="lazy"`

**SEO component**: Already handles `og:image` and `twitter:card` correctly via the `image` prop -- no changes needed there since `BlogPost.tsx` already passes `post.cover_image_url`.

### 7. Fallback
If generation fails, the function logs the error but does not block. The blog post page already handles missing cover images with a placeholder. We will add a branded default at `blog-covers/default/default-1200x630.webp` that gets used when no cover image exists.

## Technical Details

### Edge Function Prompt Strategy
The AI image model generates the image directly with text overlay baked in. The prompt will be carefully structured to:
- Request a 1200x630 aspect ratio image
- Specify padel-themed visual elements
- Include the display title text in the correct language
- Request the PadelTrainer.ai branding subtly
- Enforce high contrast and readability

### Display Title Logic
```
1. Use meta_title if available, else title
2. If > 50 chars, truncate at last word boundary before 50 chars
3. Append "..." if truncated
```

### Files to create/modify
- **New**: `supabase/functions/generate-blog-cover/index.ts`
- **New migration**: add `cover_image_alt`, `cover_image_generated_at` columns
- **Modify**: `src/pages/admin/AdminBlogEditor.tsx` -- add cover image controls
- **Modify**: `src/pages/admin/AdminBlog.tsx` -- add thumbnail column
- **Modify**: `src/pages/marketing/BlogPost.tsx` -- eager loading, explicit dimensions
- **Modify**: `src/lib/blog.ts` -- add new fields to Article interface

