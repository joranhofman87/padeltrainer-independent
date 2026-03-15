

## Fix Remaining Ranking Blockers for Learning Articles

### 1. Make topics crawlable links
- In `LearningArticlePage.tsx`, wrap topic badges in `<LocalizedLink to={`/learn?topic=${topic.slug}`}>` (or a dedicated `/learn/topics/${topic.slug}` route if we want indexable topic pages)
- On `LearnIndex.tsx`, read `?topic=` query param and filter articles accordingly

### 2. Show publish/modified dates on article pages
- Render `datePublished` (and `dateModified` if different) near the header as a small formatted date line
- Use `<time datetime="...">` for semantic markup

### 3. Add `contentType` grouping/filtering on LearnIndex
- Add clickable filter chips for each content type at the top of the index
- Use query params (`?type=tactics`) so filters are crawlable
- Group children by contentType in the default (unfiltered) view

### 4. Localize LearnIndex SEO strings
- Move title/description to translation keys (`learn.seoTitle`, `learn.seoDescription`)
- Use `t()` in the `<SEO>` component props

### 5. Handle images in Portable Text
- Add a `types: { image: ... }` handler in `PortableTextRenderer` using `@sanity/image-url`
- Render with `<img>` with alt text, lazy loading, width/height for CLS prevention

### 6. Add `WebPage` to structured data
- In `buildStructuredData`, add a `WebPage` schema object alongside the existing Article/CollectionPage and BreadcrumbList

### 7. Install `@tailwindcss/typography` (if missing)
- Verify it's in `tailwind.config` plugins; if not, add it so `prose` classes work

### 8. Clean up unused imports
- Remove `AlertCircle` and `ArrowRight` from `LearningArticlePage.tsx` if unused

### Files to change
1. `src/pages/marketing/LearningArticlePage.tsx` — dates, topic links, WebPage schema, unused imports
2. `src/pages/marketing/LearnIndex.tsx` — localized SEO, content type filters, topic query param
3. `src/components/sanity/PortableTextRenderer.tsx` — image block handler
4. `tailwind.config.ts` — verify/add typography plugin
5. Translation files — add `learn.seoTitle`, `learn.seoDescription` keys

