
# Growth-hacker SEO roadmap — what's left to win

You've nailed the foundation (bot rendering, schemas, hreflang, llms.txt, sitemaps, fonts). The next gains come from **content depth, internal linking, Core Web Vitals, and entity signals** — the levers Google actually uses to rank.

Below is a prioritized list. Each item has effort (S/M/L), expected impact (★1-3), and what it unlocks.

---

## Tier 1 — Highest leverage, ship first

### 1. Programmatic content depth on city/province pages (M, ★★★)
Right now `/en/trainers/utrecht` renders just a title + `<p>Find and book…</p>` for bots. That's thin content. Competitors with 800-1500 words rank above us by default.
- For each city add: trainer count, avg price, top 3 trainers, top 3 clubs, weather/season note, FAQ block (3-5 Q&A), nearby cities (internal links), "popular searches" chips.
- Generate from existing DB data — no new content writing required.
- Same pattern for `/trainers/region/<province>` and `/padel/<club>`.
- Expected: rank for 100s of "padel trainer in {city}" long-tails currently invisible.

### 2. FAQPage + HowTo + Review schemas (M, ★★★)
Already have Person/Org/Breadcrumb/Article. Missing the high-CTR rich-result types:
- **FAQPage** on every city, trainer, academy, learning article (uses generated FAQ block from #1).
- **HowTo** on `/strokes/*`, `/learn/*`, `/video-tips/*` step-by-step content.
- **AggregateRating + Review** on trainer profiles using existing `trainer_reviews` table.
- **Course** schema on academy/cycle pages.
- **Event** schema on tournament pages.
- Expected: stars/FAQ accordions in SERPs → +20-40% CTR even at same rank.

### 3. Internal linking engine (M, ★★★)
Pages with <3 internal inbound links get crawled rarely. Today city pages live in isolation.
- Auto-generate "Padel in nearby cities" block (5-10 links) on every city page using `provinces.ts`.
- "More trainers in {province}" on every trainer profile.
- "Other articles in {topic}" carousel on blog/learning posts (already have `topics.ts`).
- Footer mega-menu with top 50 cities (renders for bots too).
- Expected: deep pages get crawled + ranked. Compounds with #1.

### 4. Core Web Vitals pass on render-page output (S, ★★★)
The bot HTML has zero CSS, but the **human SPA** is what Google ranks for CWV. Run real-user check:
- Audit current LCP/CLS/INP via PageSpeed on `/`, `/trainers/utrecht`, `/trainer/<top>`, `/blog/<top>`.
- Quick wins: image `width`/`height` on every `<img>`, `loading="lazy"` audit, eliminate render-blocking JS chunks, preload hero image.
- Self-host `Inter` + `Plus Jakarta Sans` under `/fonts/*.woff2` (carry-over from Phase 3).
- Expected: green CWV → ~10% rank lift across the board (confirmed Google ranking factor).

---

## Tier 2 — Authority & freshness signals

### 5. Dynamic, dated, human-friendly OG images per entity (M, ★★)
Currently every page shares `og-image.png`. Generate per-trainer / per-city / per-article OG cards via an edge function (already have share-card patterns from `ratingShareCard.ts`, `redFlagShareCard.ts`).
- Boosts social CTR (LinkedIn, X, WhatsApp, Slack previews).
- Indirect rank lift via increased referral + brand-search volume.

### 6. Pillar pages for high-volume queries (L, ★★★)
Blog has pillar hubs — extend to commercial intent:
- "Best padel trainers in Europe 2026" (programmatic top-100 ranked by reviews).
- "How much does a padel coach cost?" (calculator + price ranges from your data).
- "Find a padel club near you" map page.
- Each becomes a hub linking to all relevant city/trainer pages = link equity distribution.

### 7. User-generated content velocity (M, ★★)
Fresh, unique content is the cheapest ranking lever.
- Encourage court reviews (already built) — email past players a one-click review link.
- Trainer testimonials publicly displayed = unique text per profile = solves thin-content problem at scale.
- "Recently booked / recently reviewed" feed on city pages = freshness signal.

### 8. External backlink loops (S setup, ★★)
- Submit `/llms.txt` to llms.txt directories.
- Public API + "Powered by PadelTrainer.ai" badge for partner clubs (the existing external API).
- Free embeddable trainer-finder widget for club websites → backlinks.
- Press kit page with high-res logos for journalists.

---

## Tier 3 — Technical hardening & monitoring

### 9. SEO regression CI (S, ★★)
- Lighthouse CI per PR on 5 representative URLs (already have `.github/workflows/`).
- Schema validator in CI (curl render-page + run through `schema-dts` validator).
- Broken-link crawler weekly (Lychee / Linkinator).
- Alert on sitemap URL count drops >10% week-over-week.

### 10. Search Console + Bing Webmaster integration (S, ★)
- Verify both, submit sitemap-index.
- Wire GSC API to a `/admin/seo` dashboard showing: top queries, CTR by URL, indexing status, coverage errors.
- Catches deindexing issues days earlier than third-party tools.

### 11. Trailing-slash + canonical hygiene (S, ★)
Carry-over from Phase 3. Decide policy (no trailing slash recommended for SEO), enforce 301s in Cloudflare worker, ensure all canonicals + sitemap + internal links agree.

### 12. 404 + bot-aware soft-404 handling (S, ★)
Render real 404 status for unknown trainer/city slugs in `render-page` (currently returns 200 fallback). Soft 404s waste crawl budget.

### 13. Country-targeted subfolders for top markets (M, ★★)
You have `nl/es/de/fr/it` — but the hreflang `x-default` points to `nl`. Switch to `en` or geo-detect. Consider adding `en-gb`, `es-es`, `de-de`, `de-at` variants for Search Console country targeting if you have local trainer density.

---

## Tier 4 — Content engine (compounds over months)

### 14. AI-assisted localized blog at scale (L, ★★★)
You already have Sanity + AI generation infra. Use it:
- 50 long-tail "padel + {topic} + {city}" articles per month per locale.
- Topic clusters around: rules, gear, technique, level systems, tournaments.
- Each article links into 3 city pages + 3 trainer pages.

### 15. Video SEO (M, ★★)
`VideoTips` exists. Add `VideoObject` schema with thumbnails, transcripts, chapters. Embed YouTube + transcribe to text below = double indexing surface.

### 16. Glossary / "What is …" pages (M, ★★)
Capture top-of-funnel + AI-overview real estate. "What is padel?", "What is a bandeja?", "Padel vs tennis" — these are the queries ChatGPT/Gemini cite.

---

## Recommended next sprint

If you want a single 1-week sprint that moves the needle most: **#1 + #2 + #3** in parallel. They share infrastructure (city/trainer page renderers), reuse existing data, and unlock measurable rank/CTR gains within 2-4 weeks of recrawl.

Tell me which tier or items you want to scope first and I'll write the implementation plan for those specifically.
