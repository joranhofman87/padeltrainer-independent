

## Plan: Dynamic Sitemap Proxy via Cloudflare

### What we'll do

Two code changes in this repo, then one manual step in Cloudflare.

---

### Step 1: Update `docs/cloudflare-worker.js` (I do this)

Add a sitemap proxy block **before** the bot detection logic. Any request (bot or human) to `/sitemap.xml` or `/sitemaps/*.xml` gets proxied directly to the sitemap edge function — no bot check needed since sitemaps are always machine-consumed.

```text
GET /sitemap.xml         → edge function ?type=index
GET /sitemaps/sitemap-*  → edge function (passthrough by filename)
```

Add a new environment variable `SITEMAP_FUNCTION_URL` to the deployment instructions.

### Step 2: Delete `public/sitemap.xml` (I do this)

Remove the stale 181K-line static file so it can never be served as a fallback.

### Step 3: You deploy to Cloudflare (manual, ~2 minutes)

1. Go to **dash.cloudflare.com** → Workers & Pages → your PadelTrainer worker
2. Click **Edit Code**
3. Replace the code with the updated `docs/cloudflare-worker.js`
4. Add environment variable: `SITEMAP_FUNCTION_URL` = `https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/sitemap`
5. Click **Save and Deploy**

### Step 4: Verify (manual, ~1 minute)

Open these URLs in your browser and confirm they return XML:
- `https://padeltrainer.ai/sitemap.xml` — should show `<sitemapindex>` with sub-sitemap links
- `https://padeltrainer.ai/sitemaps/sitemap-static.xml` — should show `<urlset>` with URLs

### Optional: Keep GitHub Action as backup

The `.github/workflows/sitemap.yml` can remain as-is. It regenerates static copies daily, which serves as a cache layer if the edge function ever goes down. No changes needed there.

