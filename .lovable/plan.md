

## Fix Social Sharing Meta Tags (OG/Twitter) for All Pages

### Root Cause

WhatsApp, Facebook, Twitter, and other social platforms don't run JavaScript. Your app is a React SPA, so the OG meta tags injected by `react-helmet-async` are invisible to these crawlers. 

You have a **Cloudflare Worker + `render-page` edge function** that pre-renders HTML for bots, but it only handles a limited set of routes:
- `/`, `/trainers`, `/trainers/:city`, `/trainer/:slug`, `/locations`, `/locations/:slug`, `/academies/:slug`, `/about`, `/pricing`

**Everything else falls through to `renderFallback()`**, which returns the generic homepage title/description/image. This includes:
- `/blog`, `/blog/:slug`
- `/padel-rules`, `/padel-strokes`, `/padel-coaches`
- `/video-tips`, `/video-tips/:slug`
- `/partner`, `/privacy`, `/terms`

Additionally, the language prefix stripping only handles `en|nl`, missing `es|de|fr`.

### Changes to `supabase/functions/render-page/index.ts`

**1. Fix language prefix regex** (line 24)
- Change `path.replace(/^\/(en|nl)/, '')` to `path.replace(/^\/(en|nl|es|de|fr)/, '')`
- Update lang detection to support all 5 languages

**2. Add static page routes** for pages with known meta:
- `/blog` — "Padel Blog — Tips, Guides & Training Advice"
- `/padel-rules` — "Padel Rules — Complete Guide to the Rules of Padel"
- `/padel-strokes` — "Padel Strokes — Master Every Shot in Padel"
- `/padel-coaches` — "Padel Coaches — Expert Coaching Tips & Techniques"
- `/video-tips` — "Padel Video Tips — Watch & Learn from Top Coaches"
- `/partner` — "Become a Partner — PadelTrainer.ai"
- `/privacy` — "Privacy Policy — PadelTrainer.ai"
- `/terms` — "Terms of Service — PadelTrainer.ai"
- `/academies` — "Padel Academies — Find Professional Training Programs"

**3. Add dynamic blog article renderer** (`renderBlogArticle`)
- Match `/blog/:slug`
- Fetch the article from Sanity using the Sanity CDN API (HTTP fetch, no npm import needed — just `https://{projectId}.api.sanity.io/v2024-01-01/data/query/{dataset}?query=...`)
- Extract title, meta description, cover image from the Sanity response
- Return proper OG tags with article-specific title, description, and image

**4. Add dynamic blog listing renderer** (`renderBlogListing`)
- Fetch recent articles from Sanity
- Render a list page with proper meta

### Files to Modify
- `supabase/functions/render-page/index.ts` — add all missing route handlers

This will ensure every page shared on WhatsApp/social shows its correct title, description, and image instead of the homepage defaults.

