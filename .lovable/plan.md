
# SEO + LLM Visibility Audit — May 2026

Acting as SEO/Growth manager. Sanity owns marketing content, so this audit focuses on **technical SEO, schema depth, programmatic on-page enrichment, internal linking, and Generative-Engine-Optimization (GEO) signals** that drive ChatGPT / Claude / Perplexity citations.

I crawled the live site as Googlebot and reviewed render-page, sitemap, llms.txt, SEO.tsx, structuredData.ts, og-image, and the marketing page set.

---

## Score card

| Area | Status | Notes |
|---|---|---|
| Bot rendering (Cloudflare → render-page) | Strong | 200 OK, ~10KB HTML, real 404s |
| Hreflang + x-default | Strong | en default, all 6 locales |
| Sitemaps (index + 12 shards) | Good | Static lastmod (today) for ALL urls = signal noise |
| llms.txt / llms-full.txt | Good | Static curation + live entity catalog |
| Schema: Org/Person/Breadcrumb/FAQ | Good | Present on city + entity pages |
| Schema: Review, AggregateRating, Course, Event, HowTo, VideoObject, SpeakableSpecification | Missing | Major gap |
| OG images per entity | Done | dynamic SVG via og-image fn |
| Press kit, Powered-by badge | Done | |
| Programmatic depth on entity pages (bot HTML) | Weak | No DB-derived facts in bot HTML |
| Author entities + sameAs | Missing | Articles cite "Organization" only |
| Internal linking (bot HTML) | Weak | Only generic 21-city list, no contextual crosslinks |
| Localized labels in render-page | Weak | "Trainers" / "Blog" / "FAQ" hardcoded EN on all locales |
| CWV (human SPA) | Unmeasured | Self-hosted fonts still pending |
| GSC / Bing verification | Wired, unset | Need tokens in env |
| IndexNow (Bing/Yandex fast indexing) | Missing | |
| Image / Video sitemaps | Missing | |

---

## Tier 1 — Highest leverage (ship next sprint)

### A1. Enrich render-page bot HTML with live DB facts (M, ★★★)
Single biggest gap. Today `/en/trainers/utrecht` says "Find and book padel trainers in Utrecht" — that's it. Bot HTML must answer the exact query.
- City pages: `count(trainers)`, `min/avg hourly_rate`, `count(clubs)`, top 5 trainers (name, slug, rate, rating), top 5 clubs, intro paragraph stitched from those facts.
- Trainer pages: `hourly_rate`, `years_experience`, `specializations`, `aggregate rating + review count`, home city/club, last 2 review snippets. Unlocks real `AggregateRating` + `Review` schema.
- Club pages: indoor/outdoor courts, address, geo, list of trainers at this club.
- Academy pages: trainer count, active cycle count.
- Cache 1h at edge keyed on path; ~50ms added per cold render.

### A2. Review/AggregateRating/Course/Event/LocalBusiness schema (S, ★★★)
Once A1 ships the data:
- Trainer profile → `Person` + `aggregateRating` + up to 5 `Review`.
- Academy cycles → `Course` with `provider`, `offers.price`, `courseInstance.startDate`.
- Tournaments → `Event`.
- Clubs with reviews → `LocalBusiness` + `aggregateRating` + `geo`.
Result: review stars in SERP → +20-40% CTR with no rank change.

### A3. GEO — make pages citation-ready for LLMs (M, ★★★)
ChatGPT / Claude / Perplexity preferentially cite pages with:
- Factual, dated TL;DR top of page: "As of {Month YYYY}, PadelTrainer.ai lists {N} certified padel trainers across {C} cities in {K} countries."
- Visible "Last updated: {date}" line on every entity / city page.
- Q&A worded the way users prompt LLMs ("How much does a padel coach in Utrecht charge?" not "Pricing").
- Comparison tables ("Padel vs Tennis lessons", "Group vs Private cost").
- Outbound links to authoritative sources (FIP, national federations) on learning pages — outbound link graph is a trust signal for LLMs.
- `SpeakableSpecification` on FAQ + intro blocks for voice assistants.
- Visible byline + `Person` author with `sameAs` on Sanity articles.

### A4. Contextual internal linking in bot HTML (S, ★★)
Today every city page links to the same 21 popular cities. Make it contextual:
- Trainer → "More trainers in {city}", "Other trainers in {province}", "Clubs where {trainer} teaches".
- City → "Nearby cities in {province}" (5), "Top clubs in {city}" (5), "Top academies in {city}".
- Province → every city in that province.
- Club → "Trainers at {club}", "Other clubs in {city}".
- Academy → "Other academies in {country}".
All from existing `provinces.ts` + DB. Compounds A1.

### A5. Localize section labels in render-page (XS, ★★)
`render-page` hardcodes "Trainers", "Locations", "Blog", "Frequently Asked Questions" in English on `/nl/`, `/es/`, `/de/`, `/fr/`, `/it/`. Add a per-lang label map. Improves local SERPs and hreflang quality signal.

---

## Tier 2 — Authority & discoverability

### B1. Author entities + Organization sameAs (S, ★★)
- Add `sameAs` to Organization JSON-LD: LinkedIn, X, Instagram, GitHub, Crunchbase. Disambiguates the brand for Knowledge Graph + LLMs.
- Replace `author: Organization` on articles with a real `Person` (`url`, `sameAs`, `jobTitle`). Build `/author/{slug}` pages from a small Sanity author schema.

### B2. IndexNow + Google Indexing API (S, ★★)
- IndexNow key file at `/{key}.txt`; ping `api.indexnow.org` from a Cloud Function on Sanity publish, new trainer go-live, new city's first trainer. Bing + Yandex re-crawl within minutes.
- Google Indexing API cron for `JobPosting` + `Event` URLs (the only types Google supports).

### B3. Per-URL `lastmod` in sitemaps (S, ★★)
All sitemap URLs currently emit today's date — Google deprioritizes "always today" sitemaps. Use `updated_at` from each row (trainers, locations, academies, articles).

### B4. Image + Video sitemaps (S, ★)
- `sitemap-images.xml` for trainer avatars, club photos, racket images.
- `sitemap-videos.xml` for `/video-tips/*` with thumbnails + durations.

### B5. Trailing-slash 301 in Cloudflare worker (XS, ★)
Canonical normalization is client-side only. Add a 301 in the worker so external links to `/en/trainers/utrecht/` collapse before they reach the SPA.

### B6. llms.txt freshness (XS, ★)
- Add `<link rel="llms" href="/llms.txt">` to HTML head.
- Regenerate `llms.txt` weekly via cron with current top-N trainers/cities.

---

## Tier 3 — Technical hardening & monitoring

### C1. CWV pass on human SPA (M, ★★)
- PageSpeed audit on `/en`, top city, top trainer, top blog post.
- Self-host Inter + Plus Jakarta Sans woff2 with `font-display: swap` + preload.
- Explicit `width`/`height` on every `<img>` to kill CLS.
- Eager + `fetchpriority="high"` on hero images.
- Code-split heavy admin chunks out of marketing entry.

### C2. Set GSC + Bing verification (XS, ★)
Env vars `VITE_GOOGLE_SITE_VERIFICATION` + `VITE_BING_SITE_VERIFICATION` are wired in `SEO.tsx` — just need real values in deployment env, then submit sitemap-index in both consoles.

### C3. Schema regression CI (S, ★★)
GitHub Action that curls 5 representative URLs through `render-page` and validates JSON-LD with `schema-dts` / structured-data-testing-tool. Fails PR on broken schema.

### C4. Sitemap drift alert (XS, ★)
Weekly job that compares current sitemap URL count to last week and Slack-pings if drop >10%. Catches deindexing fast.

---

## Tier 4 — Compounding plays

### D1. Programmatic pillar pages (M, ★★★)
- "Best padel trainers in Europe 2026" (top-100 by rating, programmatic).
- "How much does a padel coach cost?" (calculator + price ranges per country, charts).
- "Find a padel club near you" (map, server-rendered cluster summary for bots).
Each becomes a hub redistributing link equity to city / trainer pages.

### D2. UGC velocity loop (M, ★★)
- Email past players a one-click court / trainer review link (3 questions, 30s).
- "Recently reviewed" feed on city pages → freshness signal.

### D3. Backlink loops (S, ★★)
- Submit `/llms.txt` to llms-txt directories (`directory.llmstxt.cloud`, etc.).
- Embeddable trainer-finder widget for partner club sites → branded backlinks.
- Public READ API documented on `/press`.

### D4. VideoObject + transcripts on /video-tips (M, ★★)
Double indexing surface + Google Video carousel eligibility.

---

## Recommended next sprint (1 week, ordered)

Each step unlocks the next:

1. **A1** DB enrichment in render-page — foundation
2. **A2** Review/AggregateRating/Course schemas — uses A1 data
3. **A4** contextual internal links — uses A1 data
4. **A5** localized labels — XS, same PR
5. **B3** real lastmod in sitemaps — XS, same PR
6. **A3** GEO TL;DR + last-updated + speakable — uses A1 data

Parallel quick wins: **B1** (sameAs + author), **B5** (worker 301), **C2** (GSC/Bing tokens).

Expected outcome in 4-6 weeks: city long-tails ("padel trainer Utrecht", "padel coach Madrid prijs") begin ranking page-1, trainer profiles eligible for SERP star ratings, ChatGPT/Claude begin citing PadelTrainer.ai for "where can I book a padel coach" prompts.

---

## What to ask ChatGPT / Claude to validate

1. "What technical SEO gaps are missing from this audit for a multilingual marketplace?"
2. "Rank these Tier-1 items by expected impact on organic traffic in 90 days."
3. "What additional schema types would help a padel-coach marketplace appear in AI Overviews?"
4. "Audit our llms.txt + llms-full.txt against current best practice (May 2026)."

Tell me which tier to scope into a build plan — I recommend Tier 1 (A1 → A5 + B3) as a single coordinated PR.
