## Two fixes from the post-publish verification

### 1. `render-page` returns 404 with wrong-slug hreflangs for topic hubs

**Problem.** `GET /functions/v1/render-page?path=/en/strokes` returns the generic 404 HTML with hreflang siblings built by naively swapping the language prefix (`/nl/strokes` instead of `/nl/slagen`). Cloudflare proxies bot traffic to this function, so Googlebot sees a 404 + broken hreflangs even though the React app renders the page correctly.

**Cause.** `renderPathInner` in `supabase/functions/render-page/index.ts` has no branch for the `:topicSlug` catch route. Each per-locale slug is different (`rules` / `regels` / `padel-regeln` / `reglas` / `regles-padel` / `colpi`), so a generic prefix-swap doesn't work — sibling slugs must come from Sanity.

**Fix.** Add a topic-hub branch in `renderPathInner`, placed **before** the short-handle resolver fallback (around line 710, before `shortMatch`):

1. Fetch the matching topic doc + its sibling-language docs from Sanity:
   ```groq
   *[_type=="topic" && slug.current==$slug && language==$lang && !(_id in path("drafts.**"))][0]{
     title, h1, intro, description, contentType,
     "alternates": *[_type=="topic" && contentType==^.contentType && _id!=^._id && !(_id in path("drafts.**"))]{
       language, "slug": slug.current
     }
   }
   ```
2. If no doc matches, fall through to the existing short-handle resolver (preserves trainer/academy short-link behavior).
3. If matched, render with:
   - `<title>` = `${h1 || title} | PadelTrainer.ai`
   - `<meta name="description">` from `description` (or `intro` first sentence)
   - `<h1>` from `h1 || title`
   - body: short intro paragraph + a "View full guide" link to `${SITE_URL}/${lang}/${slug}`
4. Generate hreflang from the alternates list using the actual translated slugs (matches what React Helmet emits and what the sitemap already contains). The current `page()` builder hard-codes prefix-swapped hreflangs at line 808-809 — extend `page()` to accept an optional `alternates: { lang, slug }[]` and skip the default loop when provided.

**Sanity client.** Use direct `fetch` to `https://<projectId>.api.sanity.io/v2024-01-01/data/query/production?query=...` (matches existing zero-import-map style of this function — no `@sanity/client` SDK needed in Deno). Project ID is `Wr8P9` per the connector. Add a 5-minute in-memory cache keyed by `${lang}:${slug}` so repeated bot hits don't hammer Sanity.

**Sanity CORS.** No CORS header needed for server-to-server fetches; the Sanity public CDN allows unauthenticated reads.

**Test after deploy.** `curl https://<project>.supabase.co/functions/v1/render-page?path=/en/strokes` → expect 200, `<title>Padel Strokes …`, `<h1>Padel Strokes</h1>`, hreflang `nl` → `/nl/slagen`, `de` → `/de/schlaege`, etc. Plus repeat for `/de/padel-regeln` and `/it/colpi` (IT has no Sanity topic doc per data; should fall through to 404 — that's fine).

### 2. NL footer column heading shows "Padel topics" (English)

**Cause.** `FooterTopics` in `src/components/marketing/MarketingLayout.tsx:32` uses `t('footer.padelTopics', 'Padel topics')` but the key is missing from every locale's `common.json` (only `footer.description` and similar exist), so i18next falls back to the English default in every locale.

**Fix.** Add `padelTopics` under the existing `footer` block in:
- `src/i18n/locales/nl/common.json` → `"padelTopics": "Padel onderwerpen"`
- `src/i18n/locales/de/common.json` → `"padelTopics": "Padel Themen"`
- `src/i18n/locales/fr/common.json` → `"padelTopics": "Sujets de padel"`
- `src/i18n/locales/es/common.json` → `"padelTopics": "Temas de pádel"`
- `src/i18n/locales/it/common.json` → `"padelTopics": "Argomenti di padel"`
- `src/i18n/locales/en/common.json` → `"padelTopics": "Padel topics"` (explicit, so no fallback)

Sentence case for NL per project memory.

### Files touched

| File | Change |
|---|---|
| `supabase/functions/render-page/index.ts` | New topic-hub branch + Sanity fetch helper + `page()` accepts optional `alternates`. |
| `src/i18n/locales/{en,nl,de,fr,es,it}/common.json` | Add `footer.padelTopics`. |

### Out of scope

- No changes to client-side `TopicPage`, `SEO`, sitemap, or `DomainRouter` (already verified correct).
- No new Sanity SDK dependency in the edge function — keep the Deno-friendly direct-fetch pattern.
- No retry/backoff on Sanity errors — on failure, fall through to the existing 404 path so behavior degrades safely.

### Verification after deploy

1. `curl '…/render-page?path=/en/strokes'` → 200 + correct `<title>`, `<h1>`, and 5 hreflang siblings using actual NL/DE/ES/FR slugs.
2. Same for `/de/padel-regeln` and `/nl/slagen`.
3. Reload `/nl` in the live preview → footer heading reads "Padel onderwerpen".
4. Switch language → heading updates accordingly.
