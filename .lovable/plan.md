## Goal

Comprehensive schema.org JSON-LD coverage on every public page, sourced from Sanity / DB fields, emitted client-side via `SEO` and server-side via the `render-page` edge function so bots see it without JS execution.

## Audit of current state

The codebase already emits structured data on most public pages via `<SEO structuredData={[...]} />` and the `react-helmet-async` head. Existing coverage:

| Page | Currently emits |
|---|---|
| `Home` | WebSite + Organization |
| `BlogPost` | Article + Breadcrumb (+ Blog) |
| `Blog` index | Blog + Breadcrumb |
| `LearningArticlePage` | Article/CollectionPage + WebPage + Breadcrumb |
| `StrokePage` | Article + Breadcrumb + HowTo (when `keyTips` non-empty) |
| `Strokes` index | Breadcrumb + ItemList |
| `RulesPage` | Article + Breadcrumb |
| `Rules` index | Breadcrumb + FAQPage + ItemList |
| `TopicPage` | CollectionPage + WebPage + Breadcrumb |
| `CoachPage` | Person + Breadcrumb |
| `CityLanding` (DB-backed) | FAQPage + Breadcrumb + LocalBusiness[] |
| `TrainersCity` | ItemList + FAQPage + Breadcrumb |
| `TrainersProvince` | ItemList + Breadcrumb |
| `Locations` index | ItemList + Breadcrumb |
| `LocationDetail` | SportsClub + AggregateRating + Breadcrumb |
| `TrainerProfile` (DB) | Person-ish + Breadcrumb |

Gaps + issues to fix:

1. `StrokePage` HowTo emits with **any** non-empty `keyTips` — should require **≥3 steps** per spec; otherwise drop HowTo and keep Article.
2. `TrainerProfile` (DB-side) Person schema should include `jobTitle: "Padel Coach"` + `knowsAbout: ["Padel", ...specialties]` + skip entirely when bio is empty.
3. `LocationDetail` uses `SportsClub` — keep (it's a valid subtype of `SportsActivityLocation`); add `sport: "Padel"` for clarity. Omit `geo` when lat/lng missing (already handled in CityLanding, audit Detail).
4. `TopicsIndex` and `LearnIndex` lack CollectionPage + Breadcrumb — add.
5. `Coaches` index, `VideoTips` index, `VideoTipPage`, `RacketListing`, `RacketDetail`, `AcademyPublicProfile`, `Trainers` index — verify and add Breadcrumb (+ ItemList for index pages, Person for academy, VideoObject for video tips, Product for rackets).
6. `render-page` (bot SSR) currently emits **no** structured data for blog/learning/stroke/rules/topic/trainer/location pages. Bots that don't execute JS see naked HTML. Mirror the schema set in the SSR HTML.
7. `rulesArticle` Sanity docs do **not** have a `faqs` field (verified). Spec assumed they did. Decision: **keep Article schema only** for individual rules pages; the Rules **index** keeps its FAQPage (already wired with i18n FAQ strings). No spam FAQPage on per-rule pages.
8. Sanity `cityPage` has `faqs` (verified) — already wired in `CityLanding`. Confirm the route is reachable and add Breadcrumb step polish.

## Design

### Centralize via `src/lib/structuredData.ts`

Extend the existing module with one pure builder per schema type. Pages compose builders; the result is a flat array passed to `<SEO structuredData={[...]} />`. No new component — `SEO` already serializes any array of objects. Builders:

- `buildArticle({ headline, description, image, datePublished, dateModified, authorName, lang, url })`
- `buildHowTo({ name, description, image, lang, steps })` — returns null if `steps.length < 3`
- `buildFaqPage(items)` (exists)
- `buildBreadcrumbList(steps)` (exists) — extend to accept lang for typed Home label
- `buildPerson({ name, bio, image, jobTitle, knowsAbout, url })` — returns null if no bio
- `buildCollectionPage({ name, description, url, lang })`
- `buildSportsActivityLocation({ name, description, address, geo, url, sport })` — omits `geo` when missing
- `buildOrganization()` / `buildWebSite({ searchUrl? })` — consts for homepage
- `buildItemList(items)` (already inline in several pages — extract)
- `buildVideoObject({ name, description, thumbnail, embedUrl, uploadDate })` — for video-tip pages
- `buildProduct({ name, image, description, brand, offers })` — for rackets

Helper: `portableTextToPlain(blocks)` for converting Sanity Portable Text answers/intros to flat strings used in `description` / `text` fields. Already exists somewhere in the codebase or can wrap `@portabletext/toolkit` `toPlainText`.

### Page wiring (refactor + fill gaps)

Touch each page to swap inline schema literals for builder calls. Behavior changes only where flagged below:

| Page | Schemas | Change |
|---|---|---|
| `Home` | Organization + WebSite | keep, route through builders |
| `BlogPost` | Article + Breadcrumb | builders, drop unused inner CollectionPage variant |
| `Blog` index | Breadcrumb (+ ItemList of recent posts) | route through builders |
| `LearningArticlePage` | Article + Breadcrumb | builders |
| `LearnIndex` | CollectionPage + Breadcrumb + ItemList | **add** |
| `StrokePage` | Article + Breadcrumb + HowTo (≥3 keyTips) | **fix step guard** |
| `Strokes` index | Breadcrumb + ItemList | builders |
| `RulesPage` | Article + Breadcrumb | builders (no FAQPage — see decision above) |
| `Rules` index | FAQPage + Breadcrumb + ItemList | builders |
| `TopicPage` | CollectionPage + Breadcrumb (+ ItemList of featured guides) | builders |
| `TopicsIndex` | CollectionPage + Breadcrumb + ItemList | **add** |
| `CoachPage` (Sanity trainer) | Person + Breadcrumb | builders |
| `Coaches` index | Breadcrumb + ItemList | **add** |
| `VideoTipPage` | VideoObject + Breadcrumb | **add** |
| `VideoTips` index | Breadcrumb + ItemList | **add** |
| `RacketDetail` | Product + Breadcrumb | **add** |
| `RacketListing` | Breadcrumb + ItemList | **add** |
| `CityLanding` | FAQPage + Breadcrumb + LocalBusiness[] | builders (already correct) |
| `LocationDetail` | SportsActivityLocation (alias of SportsClub) + Breadcrumb | builders + ensure `geo` skipped if missing |
| `Locations` index | Breadcrumb + ItemList | builders |
| `TrainerProfile` (DB) | Person (with jobTitle + knowsAbout) + Breadcrumb | **fix Person fields** |
| `Trainers` index | Breadcrumb + ItemList | builders |
| `TrainersCity` | ItemList + FAQPage + Breadcrumb | builders |
| `TrainersProvince` | ItemList + Breadcrumb | builders |
| `AcademyPublicProfile` | Organization + Breadcrumb | builders |

### Server-side parity (`supabase/functions/render-page/index.ts`)

Currently no structured data is emitted in SSR HTML. Add a small builder set inside `db-facts.ts` (Deno-safe, no React) and inject the result via the existing `page()` helper's `structuredData` parameter. Coverage:

- Topic hubs (already DB-fetched from Sanity in the recent fix): emit CollectionPage + BreadcrumbList.
- Trainer/club short-link pages: emit Person/SportsActivityLocation + BreadcrumbList using the Sanity/DB facts already fetched.
- Static `/about`, `/pricing`, etc.: keep WebPage + BreadcrumbList only.
- Homepage SSR: emit Organization + WebSite (parity with the React Home page).

This guarantees Googlebot's pre-render path and the live React render produce the **same** structured data.

## Validation

For every page type, after deploy, run the Google Rich Results Test against one live URL each:

1. `/en/blog/<latest-slug>` → expect Article + BreadcrumbList
2. `/en/learn/<slug>` → Article + BreadcrumbList
3. `/en/strokes/<slug>` → HowTo + Article + BreadcrumbList (HowTo only if ≥3 steps)
4. `/en/rules/<slug>` → Article + BreadcrumbList (no FAQPage — documented)
5. `/en/strokes` (topic hub) → CollectionPage + BreadcrumbList
6. `/nl/padel/amsterdam` (CityLanding) → FAQPage + BreadcrumbList + LocalBusiness
7. `/en/padel-coaches/<slug>` → Person + BreadcrumbList
8. `/en/trainers/<slug>` (DB) → Person + BreadcrumbList
9. `/en/locations/<slug>` → SportsActivityLocation + BreadcrumbList
10. `/` → Organization + WebSite

Repeat steps 1–9 against `…/functions/v1/render-page?path=<path>` to confirm SSR parity. Report a results table with the schemas detected and any warnings.

## Files touched

- `src/lib/structuredData.ts` — new builders.
- `src/components/SEO.tsx` — no change (already serializes arrays correctly).
- ~22 page files — swap inline literals for builders, fill gaps listed above.
- `supabase/functions/render-page/index.ts` + a new `supabase/functions/render-page/structured-data.ts` — server-side schema emission.

## Out of scope

- Adding new Sanity schema fields (e.g. `stroke.steps` or `rulesArticle.faqs`) — defer to a separate content-modeling pass; today we use what the docs already have.
- New OG image generation.
- Auth-required pages (`/app/*`) — bots don't crawl them.
- Migrating from `react-helmet-async` to a different head manager.

## Question before implementation

The spec asks for FAQPage on `rulesArticle` if `≥2` items, but live Sanity `rulesArticle` docs have no `faqs` array (only `quickAnswer` + `commonMistakes`). I'm proposing to keep per-rule pages on Article schema only and not emit FAQPage there. If you want FAQPage, the cleanest path is to add a `faqs` field to the `rulesArticle` Sanity schema and backfill — out of scope for this pass. Confirm or I'll proceed with Article-only.
