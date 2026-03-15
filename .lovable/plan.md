

## Surface all cross-category internal links

### Gap analysis

| Page | Already shown | Missing |
|------|--------------|---------|
| StrokePage | relatedStrokes, videoTips | **relatedRules** (exists in schema, not fetched) |
| RulesPage | relatedRules | **relatedStrokes** (exists in schema, not fetched) |
| CoachPage | videos by coach | Nothing missing |
| VideoTipPage | strokes, trainer | Nothing missing |

Only two pages need changes.

### Changes

**1. `src/lib/sanity.ts`**

- **`STROKE_BY_SLUG_QUERY`**: Add `relatedRules` dereference to fetch `_id`, `title`, `slug`, `h1`, `quickAnswer`, `pageType`
- **`RULES_BY_SLUG_QUERY`**: Add `relatedStrokes` dereference to fetch `_id`, `title`, `slug`, `h1`, `shortDescription`, `category`, `difficulty`

**2. `src/pages/marketing/StrokePage.tsx`**

- Add `relatedRules` to the `StrokeDetail` interface
- Render a "Related Rules" card grid after Related Strokes, before the CTA. Each card links to `/padel-rules/{slug}` and shows `h1` + `quickAnswer` (same card style as the existing Related Strokes section)

**3. `src/pages/marketing/RulesPage.tsx`**

- Add `relatedStrokes` to the `RulesArticleDetail` interface
- Render a "Related Strokes" card grid after Related Rules, before the CTA. Each card links to `/padel-strokes/{slug}` and shows category/difficulty badges, `h1` + `shortDescription` (matching the card style used on StrokePage)

Three files, minimal additions. Reuses existing Card/Badge patterns already on both pages.

