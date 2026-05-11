## Cloudflare Worker for sitemap + llms-full.txt routing

The worker already exists at `docs/cloudflare-worker.js` and handles every path in your list. No code changes are required in the worker itself — this plan is about (a) confirming what's in the repo, (b) tightening the deployment doc so the Cloudflare-side action is unambiguous, and (c) optionally smoke-testing once the route is wired up in the Cloudflare dashboard.

### What's already in `docs/cloudflare-worker.js`

`getSitemapProxyUrl(pathname, SITEMAP_FUNCTION_URL)` maps:

```text
/sitemap.xml                              -> ?type=index
/sitemaps/sitemap-static.xml              -> ?type=static
/sitemaps/sitemap-content.xml             -> ?type=content
/sitemaps/sitemap-provinces.xml           -> ?type=provinces
/sitemaps/sitemap-locations-{N}.xml       -> ?type=locations&page={N}
/sitemaps/sitemap-cities-{N}.xml          -> ?type=cities&page={N}
```

`getLlmsProxyUrl(pathname, LLMS_FUNCTION_URL)` maps:

```text
/llms-full.txt                            -> functions/v1/llms-full-txt
```

Both proxies forward `Authorization: Bearer ${SUPABASE_ANON_KEY}`, return `Cache-Control: public, max-age=3600`, and set the right `Content-Type` (`application/xml` / `text/plain`). Bot detection, IP rate-limiting, the circuit breaker, and the static fallback are unrelated to these proxy paths.

### Manual Cloudflare steps (cannot be done from the repo)

1. In the Cloudflare dashboard for `padeltrainer.ai`, create a Worker and paste the contents of `docs/cloudflare-worker.js`.
2. Add a route: `padeltrainer.ai/*` → that Worker.
3. Set Worker environment variables:
   - `ORIGIN_URL` = `https://padeltrainer.lovable.app`
   - `RENDER_FUNCTION_URL` = `https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/render-page`
   - `SITEMAP_FUNCTION_URL` = `https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/sitemap`
   - `LLMS_FUNCTION_URL` = `https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/llms-full-txt`
   - `SUPABASE_ANON_KEY` = the project's anon key
4. Confirm DNS for `padeltrainer.ai` is proxied through Cloudflare (orange cloud).

### Repo changes I'd make

- **Top-of-file deployment block in `docs/cloudflare-worker.js`**: list `SUPABASE_ANON_KEY` as a required env var (it's referenced by the proxies but missing from the documented variable list), and explicitly enumerate the seven URL patterns the worker now serves so the file is self-documenting.
- **No changes to the proxy logic itself.** The mapping already matches the contract above.

### Verification once the Cloudflare route is live

From any machine, against production:

```text
curl -I https://padeltrainer.ai/sitemap.xml                       # expect 200, application/xml, X-Sitemap-Source: edge-function
curl -I https://padeltrainer.ai/sitemaps/sitemap-static.xml       # 200 xml
curl -I https://padeltrainer.ai/sitemaps/sitemap-content.xml      # 200 xml
curl -I https://padeltrainer.ai/sitemaps/sitemap-provinces.xml    # 200 xml
curl -I https://padeltrainer.ai/sitemaps/sitemap-locations-1.xml  # 200 xml
curl -I https://padeltrainer.ai/sitemaps/sitemap-cities-1.xml     # 200 xml
curl -I https://padeltrainer.ai/llms-full.txt                     # 200 text/plain, X-LLMs-Source: edge-function
```

If any of those still 404 after the route is wired, the most likely causes are: route not attached to the zone, missing `SITEMAP_FUNCTION_URL` / `LLMS_FUNCTION_URL` / `SUPABASE_ANON_KEY` env vars, or the Supabase function returning non-200 (worker logs "Sitemap edge function returned {status}").

### Out of scope

- Editing the Supabase functions themselves.
- The bot-prerender / `render-page` flow (already covered by the existing worker).
- Adding `/robots.txt` or `/llms.txt` (short variant) — say the word and I'll extend the proxy map.