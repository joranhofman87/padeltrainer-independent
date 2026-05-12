## Topic-hub fixes 2–5

### 1. Free up `/:lang/rules` for the topic catch route

`src/components/DomainRouter.tsx` lines 380–381 currently:

```tsx
<Route path="rules" element={<Navigate to="padel-rules" replace />} />
<Route path="rules/:slug" element={<RulesPage />} />
```

Changes:
- Delete the `rules` Navigate so `/en/rules`, `/de/regeln-pickup`, etc. fall through to the `:topicSlug` catch route at line 431.
- Delete the bare `rules/:slug` route. `padel-rules/:slug` (line 383) is already the canonical detail route.
- Add explicit, slug-specific 301-style redirects for any legacy URLs that need preservation. Today there are no inbound legacy `/<lang>/rules/<slug>` references in the codebase (`rg "rules/" src/` confirms only `padel-rules/` is linked), so no per-slug redirects are needed for now. If we later identify inbound deep links, we add them as individual `<Route path="rules/scoring" element={<Navigate to="../padel-rules/scoring" replace />} />` lines — never a blanket parent redirect.

The English `rules` topic doc has slug `rules` (verified in Sanity), so `/en/rules` will resolve to the topic hub. Other locales already use distinct slugs (`padel-regeln`, `reglas`, `regles-padel`, `padel-regels`) and weren't affected by the legacy redirect.

### 2. Hreflang alternates on TopicPage

`src/lib/topics.ts` — extend `TopicDetail` and `TOPIC_BY_SLUG_QUERY`:

```ts
// add to TopicDetail
alternates: { language: string; slug: string }[] | null;

// inside TOPIC_BY_SLUG_QUERY projection
"alternates": *[_type == "topic" && contentType == ^.contentType && _id != ^._id && !(_id in path("drafts.**"))]{
  language, "slug": slug.current
},
```

Note: grouping by `contentType` works because every topic doc has a `contentType` field and shared values across languages (verified — 12 contentTypes × 5 languages = 60 docs, no nulls).

`src/pages/marketing/TopicPage.tsx` — pass alternates plus a self entry into `<SEO />`:

```tsx
const translations = [
  { language: currentLang, slug: slug! },
  ...(topic.alternates ?? []),
];

<SEO
  ...
  translations={translations}
  pathPrefix=""   // topics live at /<lang>/<slug>, no prefix
/>
```

`src/components/SEO.tsx` already accepts `translations` + `pathPrefix` and emits per-language `<link rel="alternate" hreflang>` plus `x-default` pointing to the EN slug. One small adjustment: when `pathPrefix === ""`, the current code builds `…/${pathPrefix}/${slug}` which produces a double slash. Update the alternate URL builder to omit the prefix segment when empty:

```ts
const segment = pathPrefix ? `/${pathPrefix}` : '';
url: `${baseUrl}/${t.language}${segment}/${t.slug}`
```

Apply the same fix to the `xDefaultUrl` branch.

### 3. Sitemap audit (`supabase/functions/sitemap/index.ts` lines 343–368)

Re-read of the loop shows it does emit one `<url>` per topic doc (`for (const topic of group)` inside the outer `for (const [, group] of topicGroups)`), and the Sanity query at line 325–327 returns all 60 indexable docs (verified: total=60, indexable=60, no missing slug/language). The "31/60" production count is most likely deployment lag — the previous edit to this function may not have been redeployed.

Action:
- Re-deploy the `sitemap` edge function so the published `sitemap-content.xml` is regenerated with the current loop.
- Add a defensive log line (`console.log('topic urls emitted', topicUrlCount)`) to confirm 60 entries on the next request.
- After deploy, re-fetch `/sitemap-content.xml` and grep for `<loc>https://padeltrainer.ai/[a-z]{2}/(strokes|serve|rules|...)` — expect 60 hub `<url>` blocks each containing 5 `<xhtml:link hreflang>` siblings + 1 `x-default`.
- If the live count is still <60 after redeploy, the next investigation step is XML serialization (e.g. an upstream gzip truncation or response size limit) — not the loop itself.

No code logic change to the loop is planned in this pass; only redeploy + counter log.

### 4. Surface hub links in footer

`src/components/marketing/MarketingLayout.tsx` footer currently has columns: Platform, Learn Padel, Popular Cities, Company, Legal.

Add a new "Padel topics" column between "Learn Padel" and "Popular Cities" listing the 12 hubs for the current locale. Slugs are locale-specific, so fetch them client-side via the existing `getTopics(lang)` helper from `src/lib/topics.ts` (already cached by react-query for `TopicsIndex`).

```tsx
const { data: topics } = useQuery({
  queryKey: ['footer-topics', currentLang],
  queryFn: () => getTopics(currentLang),
  staleTime: 1000 * 60 * 30,
});

// render up to 12 LocalizedLink items pointing to /${slug}
```

The header dropdown / megamenu already links to `/topics` (the index). We are not adding 12 hub items to the global header in this pass — footer is the minimum acceptable surface specified by the user, and the existing `/topics` index already provides a discoverable entry point with internal anchors to each hub.

### Files touched

| File | Change |
|---|---|
| `src/components/DomainRouter.tsx` | Remove lines 380–381 (rules Navigate + rules/:slug). |
| `src/lib/topics.ts` | Extend `TopicDetail.alternates` + projection in `TOPIC_BY_SLUG_QUERY`. |
| `src/pages/marketing/TopicPage.tsx` | Pass `translations` + `pathPrefix=""` to `<SEO />`. |
| `src/components/SEO.tsx` | Handle empty `pathPrefix` in alternate + x-default URL builders. |
| `supabase/functions/sitemap/index.ts` | Add `topicUrlCount` log; redeploy. |
| `src/components/marketing/MarketingLayout.tsx` | New "Padel topics" footer column populated from `getTopics(lang)`. |

### Out of scope

- No new global-header dropdown.
- No /padel-topics index page (existing `/topics` route covers it).
- No changes to the `:topicSlug` catch route or to any other static `/lang/*` route.
- No bulk redirect maps; only specific legacy slug redirects if/when identified.

### Verification after publish

1. `/en/rules`, `/en/strokes`, `/nl/slagen`, `/de/padel-regeln` render the topic hub (H1, intro, related cards).
2. View source on `/en/strokes` → expect `<link rel="alternate" hreflang="nl" href=".../nl/slagen">` etc., plus `x-default` → `/en/strokes`.
3. `https://padeltrainer.ai/sitemap-content.xml` contains 60 `<url>` blocks for topic hubs, each with 5 `<xhtml:link hreflang>` + 1 x-default.
4. Footer on every locale shows a "Padel topics" column with 12 links resolving to `/<lang>/<slug>`.
