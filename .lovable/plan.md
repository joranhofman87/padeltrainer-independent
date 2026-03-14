

## Sanity CMS Frontend Integration Plan

### Summary

Rebuild the content layer and add new page types so all editorial content is driven by Sanity CMS. This involves updating the existing blog and rules pages to match the actual Sanity schema, and creating three new content sections: Strokes, CMS Coaches, and Video Tips.

---

### Route Map

```text
Existing (update)             New
─────────────────             ───
/padel-rules/                 /padel-strokes/
/padel-rules/:slug            /padel-strokes/:slug
/blog/                        /padel-coaches/
/blog/:slug                   /padel-coaches/:slug
                              /video-tips/:slug  (optional V1)
```

The current `/rules` routes will be renamed to `/padel-rules` for SEO alignment with the user's desired URL structure. Existing `/trainers` routes (Supabase app) remain untouched.

---

### Schema Alignment Issues (Current Code vs Actual Sanity)

The current code has several mismatches with the live Sanity schema that must be fixed:

1. **Blog**: Code queries `_type == "post"` but Sanity type is `blogPost`. Fields differ -- Sanity uses `h1`, `bodySections[]`, `authorName`, `category`, `isFeatured`, `datePublished`, `dateModified` instead of `body` (Portable Text), `author` (reference), `tags`, `locale`, `publishedAt`.
2. **Body content**: `bodySection` is `{ heading: string, content: string }` (plain text), not Portable Text. All rendering must use simple text/paragraph splitting, not `<PortableText>`.
3. **Blog has no `mainImage`**: The `blogPost` schema has no image field. Featured post layout needs adjustment.
4. **Blog has no `locale` field**: Content is not language-partitioned in the current schema.

---

### Implementation Tasks

#### 1. Update `src/lib/sanity.ts` -- GROQ Queries

Replace all existing queries and add new ones:

**Blog queries** -- change `_type` from `"post"` to `"blogPost"`, update field projections to match schema (`h1`, `excerpt`, `bodySections`, `authorName`, `category`, `isFeatured`, `seo`, `cta`, `datePublished`, `dateModified`). Remove `locale` filter, `tags`, `mainImage`, `body` references. Add category-based filtering query.

**Rules queries** -- update `RULES_LIST_QUERY` and `RULES_BY_SLUG_QUERY` (mostly correct, minor adjustments).

**New queries:**
- `STROKES_LIST_QUERY` -- all strokes with title, slug, h1, shortDescription, category, difficulty, seo
- `STROKE_BY_SLUG_QUERY` -- single stroke with bodySections, keyTips, commonMistakes, relatedStrokes dereferenced, seo, cta
- `VIDEO_TIPS_BY_STROKE_QUERY` -- `*[_type == "videoTip" && references($strokeId)]` with trainer dereferenced
- `VIDEO_TIPS_BY_TRAINER_QUERY` -- `*[_type == "videoTip" && trainer._ref == $trainerId]` with strokes dereferenced
- `COACHES_LIST_QUERY` -- all trainers with name, slug, bio, specialties, profileImageUrl, seo
- `COACH_BY_SLUG_QUERY` -- single trainer with all fields + platformProfileUrl, seo, cta
- `VIDEO_TIP_BY_SLUG_QUERY` (optional) -- single videoTip with full details

#### 2. Rewrite `src/lib/blog.ts`

Update the `Article` interface and all functions to match the `blogPost` schema. Remove image-related helpers (no `mainImage`). Remove locale-based filtering. Update `calculateReadTime` to work with `bodySections` (plain text) instead of Portable Text blocks.

#### 3. Update Blog Pages

**`Blog.tsx`**: Remove image rendering from cards and featured post. Use `excerpt` for card descriptions. Use `category` for filtering instead of `tags`. Use `isFeatured` flag for hero treatment. Render `datePublished` instead of `publishedAt`.

**`BlogPost.tsx`**: Replace `<PortableText>` rendering with bodySections rendering (heading + text paragraphs). Remove cover image. Use `seo.titleTag` / `seo.metaDescription` for SEO. Show `authorName` as string. Render CTA from Sanity if present.

#### 4. Update Rules Pages

**`Rules.tsx`**: Change route links from `/rules/` to `/padel-rules/`.

**`RulesPage.tsx`**: Change back-link to `/padel-rules/`. Pages are largely correct already.

#### 5. Create Shared Components

**`BodySections` component**: Renders `bodySections[]` -- each section has an `<h2>` heading and plain text content (split by `\n\n` into paragraphs). Reused across rules, blog, and strokes.

**`CommonMistakes` component**: Warning-styled list. Reused on rules and stroke pages.

**`VideoTipCard` component**: Card showing thumbnail (or placeholder), title, short summary, trainer name, platform badge, skill level, tags, and "Watch" external link button. Used on stroke detail pages and coach detail pages.

**`CTASection` component**: Renders the Sanity `cta` object (label + url) with fallback. Reused across all detail pages.

**`Breadcrumbs` component**: Uses `seo.breadcrumbLabel` from Sanity. Shows Home > Section > Page.

#### 6. Create Stroke Pages

**`src/pages/marketing/Strokes.tsx`** (hub):
- Grid of stroke cards grouped or filterable by category (overhead, volley, groundstroke, etc.)
- Each card: h1, shortDescription, difficulty badge, category badge
- Links to `/padel-strokes/:slug`

**`src/pages/marketing/StrokePage.tsx`** (detail):
- H1, short description, difficulty + category badges
- Key tips as a styled list
- Body sections
- Common mistakes
- **Video Tips section**: Query all `videoTip` documents that reference this stroke, render as VideoTipCard grid
- Related strokes section (cards linking to other strokes)
- CTA from Sanity

#### 7. Create Coach Pages (CMS Trainers)

**`src/pages/marketing/Coaches.tsx`** (listing):
- Grid of coach cards: name, profileImageUrl (or avatar fallback), specialties as badges, bio snippet
- Links to `/padel-coaches/:slug`

**`src/pages/marketing/CoachPage.tsx`** (detail):
- Profile image, name, bio
- Specialties as badges/chips
- **If `platformProfileUrl` exists**: show "View trainer on PadelTrainer.ai" link
- **If absent**: show nothing
- **Video Tips section**: Query all `videoTip` documents referencing this trainer, render as VideoTipCard grid
- CTA from Sanity

#### 8. Create Video Tip Detail Page (Optional V1)

**`src/pages/marketing/VideoTipPage.tsx`**:
- Embedded video or external link
- Title, summary, platform, skill level, tags
- Trainer attribution with link to coach page
- Related strokes links

#### 9. Update Router (`DomainRouter.tsx`)

Add under the `/:lang` language router:
```
padel-rules          -> Rules (renamed from rules)
padel-rules/:slug    -> RulesPage
padel-strokes        -> Strokes
padel-strokes/:slug  -> StrokePage
padel-coaches        -> Coaches
padel-coaches/:slug  -> CoachPage
video-tips/:slug     -> VideoTipPage (optional)
```

Add redirects from old `/rules` to `/padel-rules`.

#### 10. Update Navigation (`MarketingLayout.tsx`)

Add "Strokes" and optionally "Coaches" to the nav bar. Update "Rules" link to `/padel-rules`.

#### 11. SEO Wiring

All detail pages will:
- Use `seo.titleTag` as `<title>` via `<SEO>` component
- Use `seo.metaDescription` as meta description
- Use `seo.breadcrumbLabel` in breadcrumb structured data
- Include Article/WebPage JSON-LD structured data
- Respect `seo.indexable` if false by setting `noIndex`

---

### Files Created/Modified

| File | Action |
|------|--------|
| `src/lib/sanity.ts` | Update all queries |
| `src/lib/blog.ts` | Rewrite for `blogPost` schema |
| `src/pages/marketing/Blog.tsx` | Update for new schema |
| `src/pages/marketing/BlogPost.tsx` | Rewrite rendering |
| `src/pages/marketing/Rules.tsx` | Update route to `/padel-rules` |
| `src/pages/marketing/RulesPage.tsx` | Update back-link |
| `src/pages/marketing/Strokes.tsx` | **Create** |
| `src/pages/marketing/StrokePage.tsx` | **Create** |
| `src/pages/marketing/Coaches.tsx` | **Create** |
| `src/pages/marketing/CoachPage.tsx` | **Create** |
| `src/pages/marketing/VideoTipPage.tsx` | **Create** (optional) |
| `src/components/sanity/BodySections.tsx` | **Create** |
| `src/components/sanity/VideoTipCard.tsx` | **Create** |
| `src/components/sanity/CommonMistakes.tsx` | **Create** |
| `src/components/sanity/CTASection.tsx` | **Create** |
| `src/components/sanity/Breadcrumbs.tsx` | **Create** |
| `src/components/DomainRouter.tsx` | Add routes |
| `src/components/marketing/MarketingLayout.tsx` | Update nav |

---

### What Will NOT Be Touched

- `src/pages/Trainers.tsx` (Supabase trainer directory)
- `src/pages/TrainerProfile.tsx` (Supabase trainer profile)
- Any player/club/academy profile code
- Any auth or app-level functionality
- The Sanity schema itself

