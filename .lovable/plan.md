## Goal

Make localized topic hub URLs like `/nl/slagen`, `/en/strokes`, `/en/drills` resolve to the existing `TopicPage`, render full content (h1, intro, body, related items), and appear in the sitemap. Currently they fall through to NotFound, which is the root cause of the indexation drop.

## Validation summary

- Sanity has 60 indexable `topic` docs across 6 languages with localized slugs (verified by direct GROQ).
- `DomainRouter.tsx` only mounts `/:lang/topics/:slug`; no `/:lang/{localizedSlug}` route exists.
- `getTopicBySlug` in `src/lib/topics.ts` does not filter by `language` — wrong-language docs can leak.
- The sitemap edge function emits topic entries as `/topics/{slug}` (no language prefix), so localized hubs are absent from the sitemap.
- Issue 2 (`/padel/:city` blank shell) is out of scope per your decision.

## Changes

### 1. `src/lib/topics.ts` — language-aware fetching
- Update `TOPIC_BY_SLUG_QUERY` and `TOPICS_LIST_QUERY` to filter by `language == $lang`.
- Change `getTopicBySlug(slug, lang)` and `getTopics(lang, indexableOnly)` signatures to require `lang`.
- Add a new helper `getTopicByLocalizedSlug(slug, lang)` that returns `null` when no doc matches (used by the catch route to decide between rendering and 404).

### 2. `src/pages/marketing/TopicPage.tsx` — pass current language and accept either route
- Read `slug` and (optional) `lang` from `useParams`; resolve current language via `useTranslation`.
- Pass `lang` into `getTopicBySlug`.
- When a topic is fetched via the localized catch route (no `topics/` segment), set canonical URL to `/{lang}/{slug}`. When fetched via `/topics/:slug`, set canonical to the localized URL too — so the legacy URL has a single canonical pointing at the new one.
- Update `TopicsIndex` cards to link to `/{slug}` instead of `/topics/{slug}`.

### 3. `src/pages/marketing/TopicsIndex.tsx`
- Pass current `lang` into `getTopics`.
- Update card links to `/{slug}` (LocalizedLink already prepends `/{lang}`).

### 4. `src/components/DomainRouter.tsx` — add catch route
Inside the existing `/:lang` `<Route>`, add as the LAST child route:

```tsx
<Route path=":topicSlug" element={<TopicPage />} />
```

Placed last so all existing static routes (`pricing`, `blog`, `learn`, `topics`, `padel-rules`, `padel-strokes`, `padel-coaches`, `video-tips`, `trainers`, `locations`, `academies`, `gear`, `padel`, `claim`, `playground`, `register`, etc.) win. Keep `/topics/:slug` as legacy alias.

`TopicPage` will:
- If `lang` is not in `SUPPORTED_LANGUAGES` → render NotFound (handled by LanguageRouter already).
- If `getTopicByLocalizedSlug(slug, lang)` returns null → render the existing "Topic not found" UI but with `<SEO noIndex />` and a `meta name="prerender-status-code" content="404"` so the Cloudflare bot proxy serves a real 404 to crawlers (per the `mem://seo/dynamic-rendering-strategy` setup).
- Otherwise render normally.

### 5. `supabase/functions/sitemap/index.ts`
In the `type === 'content'` branch, change the topic fetch to include `language`:

```ts
sanity.fetch(`*[_type == "topic" && !(_id in path("drafts.**"))]{
  "slug": slug.current, language, "isIndexable": coalesce(isIndexable, true), _updatedAt
}`)
```

Then emit one entry per topic doc:

```ts
for (const topic of sanityTopics || []) {
  if (!topic.isIndexable || !topic.language || !topic.slug) continue;
  const lastmod = topic._updatedAt ? topic._updatedAt.split('T')[0] : today;
  xml += generateUrlEntry(`/${topic.language}/${topic.slug}`, lastmod, 'weekly', '0.7');
}
```

Remove the old `/topics/${slug}` emission (those URLs become legacy aliases — not added to sitemap to avoid duplicate-canonical signals).

### 6. `public/llms.txt`
Add a section listing the localized topic hubs (one bullet per `{lang}/{slug}` pair) under "Learning hubs", so LLM crawlers discover them.

## Out of scope (per your answers)
- `/padel/:city` blank shell — separate ticket.
- Adding/removing static routes inside `/:lang` — left untouched.
- Translating any UI strings inside TopicPage that still hardcode English.

## Verification checklist (after implementation)
1. Build succeeds.
2. `/en/strokes`, `/nl/slagen`, `/nl/regels`, `/nl/oefeningen`, `/de/aufschlag`, `/fr/regles-padel`, `/es/golpes` all render an `<h1>` with the topic title and intro paragraph.
3. `/en/topics/strokes` (legacy) still renders and its `<link rel="canonical">` points at `/en/strokes`.
4. `/en/some-nonsense-slug` returns the NotFound UI with `noindex` meta.
5. `/en/pricing`, `/en/blog`, `/en/topics` (static routes) still render their normal pages — not the topic catch route.
6. Curl the sitemap content function and confirm 60 new `<loc>` entries (`/{lang}/{slug}` for indexable topics).
