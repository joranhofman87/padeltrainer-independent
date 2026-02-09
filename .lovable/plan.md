

## SEO and LLM Discoverability Improvements

### Task 1: Fix Sitemap -- Use Trainer Slugs Instead of UUIDs

**Problem**: The sitemap edge function uses `trainer.user_id` (UUID) for trainer URLs, but the platform uses SEO-friendly slugs (e.g., `/trainer/jan-de-vries`).

**Fix**: Update the sitemap query to fetch `slug` alongside `user_id`, and prefer slug in URL generation. Fall back to `user_id` only if slug is null.

**File**: `supabase/functions/sitemap/index.ts`
- Change trainer query from `select('user_id, updated_at')` to `select('user_id, slug, updated_at')`
- Update URL generation: use `/trainer/${trainer.slug || trainer.user_id}`

---

### Task 2: Add SEO Component to BlogPost.tsx

**Problem**: Blog posts have zero meta tags -- no title, description, canonical, or structured data.

**Fix**: Add `<SEO>` component with article structured data.

**File**: `src/pages/marketing/BlogPost.tsx`
- Import `SEO` from `@/components/SEO`
- Add `<SEO>` after the MarketingLayout opening with:
  - Title: post title
  - Description: post excerpt (first 155 chars)
  - URL: `/blog/${slug}`
  - Type: `article`
  - Image: post featured image
  - Structured data: `Article` schema with author, datePublished, image

---

### Task 3: Create Dynamic llms-full.txt Edge Function

**Problem**: Current `llms.txt` is a static file with hardcoded city examples. LLM crawlers cannot discover the full entity catalog.

**Fix**: Create a new `llms-full.txt` edge function that dynamically generates a comprehensive text file listing all trainers, cities, locations, and academies.

**New file**: `supabase/functions/llms-full-txt/index.ts`
- Fetches all public trainers (name, slug, city, specializations, rating)
- Fetches all active locations (name, city, court counts)
- Fetches all verified academies (name, slug)
- Fetches all unique cities with trainer counts
- Outputs structured plain text with sections for each entity type
- Cached for 1 hour

**Update**: `public/llms.txt`
- Add reference: `llms-full.txt: https://padeltrainer.ai/llms-full.txt` pointing to the edge function
- This follows the llms.txt spec where the base file references the full version

**Update**: `public/robots.txt`
- Add reference to llms-full.txt for AI crawlers

---

### Task 4: Add BreadcrumbList Structured Data

**Problem**: TrainerProfile, TrainersCity, and LocationDetail pages have visual breadcrumbs but no structured data for them. Only AcademyPublicProfile has BreadcrumbList schema.

**Fix**: Add `BreadcrumbList` JSON-LD to the `structuredData` arrays on:

**File**: `src/pages/TrainerProfile.tsx`
- Add BreadcrumbList: Home > Trainers > [City if available] > [Trainer Name]

**File**: `src/pages/TrainersCity.tsx`
- Add BreadcrumbList: Home > Trainers > [City Name]

**File**: `src/pages/LocationDetail.tsx`
- Add BreadcrumbList: Home > Locations > [Location Name] (already has visual breadcrumbs via ProfileLayout, just missing the structured data)

---

### Task 5: Render FAQ Content Visibly on City Pages

**Problem**: TrainersCity has FAQ structured data (FAQPage schema) but the questions/answers are NOT visible on the page. Google can penalize this as deceptive markup.

**Fix**: Render the FAQ section visibly on the page using an accordion.

**File**: `src/pages/TrainersCity.tsx`
- Add a visible FAQ section below the existing SEO content section using Accordion components
- Render the same two questions that are already in the structured data:
  - "How much do padel lessons cost in [City]?"
  - "How do I find a padel trainer near me in [City]?"
- Uses the same dynamic answer text that's already in the schema

---

### Task 6: Clean Up index.html Conflicting Meta Tags

**Problem**: `index.html` has hardcoded OG/Twitter meta tags that conflict with the dynamic ones injected by `react-helmet-async`. The hardcoded ones use an old Google Storage image URL while the SEO component uses proper OG images.

**Fix**: Remove all dynamic meta tags from `index.html`, keeping only the essentials that `react-helmet-async` cannot override (charset, viewport, icons, manifest).

**File**: `index.html`
- Keep: charset, viewport, favicon links, manifest link
- Remove: title, description, keywords, author, all og:* tags, all twitter:* tags
- The SEO component already handles all of these dynamically per page

---

### Task 7: Add Cross-Linking Between Related Pages

**Problem**: Pages exist in isolation without linking to related content, reducing internal link equity and crawlability.

**Fixes**:

**File**: `src/pages/TrainersCity.tsx`
- Already links to location pages in the clubs section
- Add a "Nearby Cities" section at the bottom that links to other city pages (fetch cities from the same locations data, exclude current city, limit to 6)

**File**: `src/pages/TrainerProfile.tsx`
- Already links to locations via trainer_locations
- Add a link to the trainer's city page (e.g., "View all trainers in Amsterdam") below the locations card

**File**: `src/pages/LocationDetail.tsx`
- Already has "Similar Clubs" section for same-city locations
- Add a link to the city's trainer page (e.g., "Find more trainers in Amsterdam") in the sidebar

---

### Summary of Changes

| File | Change |
|------|--------|
| `supabase/functions/sitemap/index.ts` | Use slug instead of UUID for trainer URLs |
| `src/pages/marketing/BlogPost.tsx` | Add SEO component with Article schema |
| `supabase/functions/llms-full-txt/index.ts` | New: dynamic llms-full.txt generator |
| `public/llms.txt` | Add llms-full.txt reference |
| `public/robots.txt` | Add llms-full.txt reference |
| `src/pages/TrainerProfile.tsx` | Add BreadcrumbList schema + city page link |
| `src/pages/TrainersCity.tsx` | Add BreadcrumbList schema + visible FAQ + nearby cities |
| `src/pages/LocationDetail.tsx` | Add BreadcrumbList schema + city trainer page link |
| `index.html` | Remove conflicting hardcoded meta tags |

