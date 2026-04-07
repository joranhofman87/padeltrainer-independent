

# Blog SEO Super-Optimization Plan

## Current State — What's Already Good

Your blog pages already have solid foundations: Article structured data, BreadcrumbList schemas on listing pages, hreflang tags, canonical URLs, OG/Twitter cards, and a `render-page` edge function for bot pre-rendering.

## What's Missing — 7 Improvements

### 1. Add `mainEntityOfPage`, `image`, and `url` to Article structured data
Google requires `image` and recommends `mainEntityOfPage` for Article rich results eligibility. Currently missing from `BlogPost.tsx`.

**Change in `BlogPost.tsx`**: Add these properties to the Article schema:
```json
"mainEntityOfPage": { "@type": "WebPage", "@id": "https://padeltrainer.ai/{lang}/blog/{slug}" },
"image": "post.seo?.ogImage || defaultOgImage",
"url": "https://padeltrainer.ai/{lang}/blog/{slug}"
```

### 2. Add BreadcrumbList structured data to individual blog posts
The blog listing page has BreadcrumbList schema, but individual posts do not — only a visual breadcrumb component. Google needs the JSON-LD version.

**Change in `BlogPost.tsx`**: Add a `BreadcrumbList` schema alongside the Article schema:
```json
{ "@type": "BreadcrumbList", "itemListElement": [
  { "position": 1, "name": "Home", "item": ".../{lang}" },
  { "position": 2, "name": "Blog", "item": ".../{lang}/blog" },
  { "position": 3, "name": "{post title}" }
]}
```

### 3. Create `llms-full.txt` — currently referenced but missing (404)
`robots.txt` and `llms.txt` both point to `/llms-full.txt` but the file doesn't exist. AI crawlers hitting this get a 404.

**Create `public/llms-full.txt`**: An expanded version of `llms.txt` with detailed entity descriptions — all content types, trainer/club/academy concepts, URL patterns with parameter docs, and data model summaries. This helps LLMs like ChatGPT and Perplexity understand and cite your platform.

### 4. Add `article:published_time` and `article:author` OG meta tags
These Open Graph article-specific tags are missing. Facebook and LinkedIn use them for article previews.

**Change in `SEO.tsx`**: When `type === 'article'`, accept optional `publishedTime` and `author` props and render:
```html
<meta property="article:published_time" content="2025-01-15" />
<meta property="article:modified_time" content="2025-02-01" />
<meta property="article:author" content="Author Name" />
```

### 5. Add `render-page` blog route for bot pre-rendering
The edge function handles `/trainer/:slug`, homepage, etc. but has no route for `/blog/:slug`. Bots that hit the pre-renderer get generic fallback HTML instead of article-specific meta tags.

**Change in `render-page/index.ts`**: Add a `/blog/:slug` route that renders title/description from the slug (display-name style, same zero-DB pattern as trainer pages).

### 6. Add `SpeakableSpecification` to Article schema for voice search
Google uses this to identify content suitable for voice assistants (Google Assistant, Alexa).

**Change in `BlogPost.tsx`**: Add to Article structured data:
```json
"speakable": { "@type": "SpeakableSpecification", "cssSelector": ["h1", ".prose"] }
```

### 7. Add `isPartOf` linking to Blog schema
Individual articles should reference the parent Blog entity for better knowledge graph connections.

**Change in `BlogPost.tsx`**: Add to Article schema:
```json
"isPartOf": { "@type": "Blog", "name": "PadelTrainer.ai Blog", "url": "https://padeltrainer.ai/{lang}/blog" }
```

---

## File Summary

| File | Change |
|------|--------|
| `src/pages/marketing/BlogPost.tsx` | Add `mainEntityOfPage`, `image`, `url`, `speakable`, `isPartOf` to Article schema; add `BreadcrumbList` JSON-LD |
| `src/components/SEO.tsx` | Add optional `publishedTime`, `modifiedTime`, `author` props; render `article:*` OG tags when type is article |
| `public/llms-full.txt` | Create the missing file with full entity catalog |
| `supabase/functions/render-page/index.ts` | Add `/blog/:slug` route for bot pre-rendering |

