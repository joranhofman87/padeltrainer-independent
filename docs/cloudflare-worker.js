/**
 * Cloudflare Worker: Bot Detection + Sitemap/LLM Proxy for PadelTrainer.ai
 *
 * Responsibilities:
 *  1. Proxy SEO discovery URLs to Supabase Edge Functions (sitemaps + llms-full.txt).
 *  2. Detect bot User-Agents and route them to the render-page Edge Function
 *     for server-rendered HTML (with rate-limit + circuit-breaker + cache).
 *  3. Pass everything else through to the Lovable origin (the SPA).
 *
 * Proxied URL contract (these MUST resolve via this worker, otherwise they 404):
 *    /sitemap.xml                         -> SITEMAP_FUNCTION_URL?type=index
 *    /sitemaps/sitemap-static.xml         -> SITEMAP_FUNCTION_URL?type=static
 *    /sitemaps/sitemap-content.xml        -> SITEMAP_FUNCTION_URL?type=content
 *    /sitemaps/sitemap-provinces.xml      -> SITEMAP_FUNCTION_URL?type=provinces
 *    /sitemaps/sitemap-locations-{N}.xml  -> SITEMAP_FUNCTION_URL?type=locations&page={N}
 *    /sitemaps/sitemap-cities-{N}.xml     -> SITEMAP_FUNCTION_URL?type=cities&page={N}
 *    /llms-full.txt                       -> LLMS_FUNCTION_URL
 *
 * DEPLOYMENT (manual, in Cloudflare dashboard — cannot be done from this repo):
 * 1. Make sure padeltrainer.ai DNS is on Cloudflare and proxied (orange cloud).
 * 2. Workers & Pages -> Create Worker -> paste the contents of this file.
 * 3. Add route: `padeltrainer.ai/*` -> this worker (zone: padeltrainer.ai).
 * 4. Set Worker environment variables (Settings -> Variables) — use the CURRENT project
 *    (ficwbdrzefmblkbkomzw) and the Vercel origin, NOT the retired Lovable/ppkbhd ones:
 *    - ORIGIN_URL            the live human origin, e.g. the Vercel deployment URL for padeltrainer.ai
 *                            (must NOT be https://padeltrainer.lovable.app — that retired deploy is
 *                            being taken down to kill duplicate content)
 *    - RENDER_FUNCTION_URL   https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/render-page
 *    - SITEMAP_FUNCTION_URL  https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/sitemap
 *    - LLMS_FUNCTION_URL     https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/llms-full-txt
 *    - SUPABASE_ANON_KEY     ficwb project anon/publishable key (forwarded as Bearer token to all
 *                            Supabase Edge Function calls — proxies AND render-page)
 *
 * Smoke test after deploying:
 *    curl -I https://padeltrainer.ai/sitemap.xml                       # 200 application/xml
 *    curl -I https://padeltrainer.ai/sitemaps/sitemap-static.xml       # 200 application/xml
 *    curl -I https://padeltrainer.ai/sitemaps/sitemap-content.xml      # 200 application/xml
 *    curl -I https://padeltrainer.ai/sitemaps/sitemap-provinces.xml    # 200 application/xml
 *    curl -I https://padeltrainer.ai/sitemaps/sitemap-locations-1.xml  # 200 application/xml
 *    curl -I https://padeltrainer.ai/sitemaps/sitemap-cities-1.xml     # 200 application/xml
 *    curl -I https://padeltrainer.ai/llms-full.txt                     # 200 text/plain
 *
 * If any return 404, the route isn't attached to the zone or an env var is missing.
 */

const BOT_USER_AGENTS = [
  'googlebot', 'google-inspectiontool', 'google-extended', 'bingbot', 'msnbot',
  'yandexbot', 'baiduspider', 'duckduckbot', 'applebot', 'applebot-extended',
  'chatgpt-user', 'oai-searchbot', 'gptbot', 'claudebot',
  'claude-web', 'anthropic-ai', 'perplexitybot', 'cohere-ai',
  'bytespider', 'amazonbot', 'meta-externalagent', 'meta-externalfetcher',
  'mistralai-user', 'youbot', 'diffbot', 'phindbot',
  'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot',
  'slackbot', 'whatsapp', 'telegrambot', 'discordbot', 'pinterestbot',
  'ia_archiver', 'archive.org_bot', 'semrushbot', 'ahrefsbot',
];

function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some(bot => ua.includes(bot));
}

function shouldPrerender(pathname) {
  if (pathname.startsWith('/app')) return false;
  if (pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|webp|avif|mp4|webm)$/)) return false;
  return true;
}

// ─── Rate Limiting (per-IP, resets per isolate) ─────────────────
const BOT_RATE_MAP = new Map(); // IP -> { count, windowStart }
const BOT_RATE_WINDOW_MS = 10_000; // 10 seconds
const BOT_RATE_MAX = 2; // max 2 requests per 10s per IP

function isBotRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  let entry = BOT_RATE_MAP.get(ip);
  if (!entry || now - entry.windowStart > BOT_RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    BOT_RATE_MAP.set(ip, entry);
  }
  entry.count++;
  // Cleanup old entries periodically (keep map small)
  if (BOT_RATE_MAP.size > 5000) {
    for (const [key, val] of BOT_RATE_MAP) {
      if (now - val.windowStart > BOT_RATE_WINDOW_MS) BOT_RATE_MAP.delete(key);
    }
  }
  return entry.count > BOT_RATE_MAX;
}

// ─── Circuit Breaker ────────────────────────────────────────────
let circuitFailures = 0;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 3;        // failures before opening
const CIRCUIT_COOLDOWN_MS = 300_000; // 5 minutes

function isCircuitOpen() {
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    if (Date.now() - circuitLastFailure < CIRCUIT_COOLDOWN_MS) return true;
    // Cooldown expired, reset
    circuitFailures = 0;
  }
  return false;
}

function recordCircuitFailure() {
  circuitFailures++;
  circuitLastFailure = Date.now();
}

function recordCircuitSuccess() {
  circuitFailures = 0;
}

// ─── Temporary-unavailable fallback (503) ───────────────────────
// Served when the render backend is failing / rate-limited / the circuit is open. It is
// noindex and carries NO canonical — crucially it must never be a 200 homepage, which Google
// reads as a soft-404 + duplicate canonical for whatever URL was requested. A 503 + Retry-After
// tells crawlers "temporary, come back later" so they neither index it nor drop the real URL.
const UNAVAILABLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Temporarily unavailable — PadelTrainer.ai</title>
</head>
<body>
  <h1>Temporarily unavailable</h1>
  <p>This page couldn't be rendered right now. Please try again shortly.</p>
</body>
</html>`;

// A 503 that crawlers should retry, never cache, and never index. Used for ALL transient
// render failures (5xx/429/network), rate-limited bots, and an open circuit breaker.
function unavailableResponse(retryAfterSeconds = 120, marker = 'unavailable') {
  return new Response(UNAVAILABLE_HTML, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Retry-After': String(retryAfterSeconds),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Rendered-By': `padeltrainer-${marker}`,
    },
  });
}

// ─── Sitemap Proxy ──────────────────────────────────────────────
function getSitemapProxyUrl(pathname, sitemapFunctionUrl) {
  if (!sitemapFunctionUrl) return null;
  if (pathname === '/sitemap.xml') return `${sitemapFunctionUrl}?type=index`;
  if (pathname === '/sitemaps/sitemap-static.xml') return `${sitemapFunctionUrl}?type=static`;
  if (pathname === '/sitemaps/sitemap-content.xml') return `${sitemapFunctionUrl}?type=content`;
  if (pathname === '/sitemaps/sitemap-provinces.xml') return `${sitemapFunctionUrl}?type=provinces`;
  const locMatch = pathname.match(/^\/sitemaps\/sitemap-locations-(\d+)\.xml$/);
  if (locMatch) return `${sitemapFunctionUrl}?type=locations&page=${locMatch[1]}`;
  const cityMatch = pathname.match(/^\/sitemaps\/sitemap-cities-(\d+)\.xml$/);
  if (cityMatch) return `${sitemapFunctionUrl}?type=cities&page=${cityMatch[1]}`;
  return null;
}

// ─── LLMs.txt Proxy ─────────────────────────────────────────────
function getLlmsProxyUrl(pathname, llmsFunctionUrl) {
  if (!llmsFunctionUrl) return null;
  if (pathname === '/llms-full.txt') return llmsFunctionUrl;
  return null;
}

// ─── Prerender Cache Key ────────────────────────────────────────
function prerenderCacheKey(url, pathname) {
  return new Request(`${url.origin}/__prerender${pathname}`, { method: 'GET' });
}

const PRERENDER_CACHE_TTL = 3600; // 1 hour

// ─── Main Handler ───────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userAgent = request.headers.get('User-Agent') || '';

    // --- Sitemap proxy ---
    if (request.method === 'GET') {
      const sitemapUrl = getSitemapProxyUrl(url.pathname, env.SITEMAP_FUNCTION_URL);
      if (sitemapUrl) {
        try {
          const response = await fetch(sitemapUrl, {
            headers: { 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}` },
          });
          if (response.ok) {
            return new Response(response.body, {
              status: 200,
              headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
                'X-Sitemap-Source': 'edge-function',
              },
            });
          }
          console.error(`Sitemap edge function returned ${response.status} for ${url.pathname}`);
        } catch (error) {
          console.error(`Sitemap proxy error for ${url.pathname}:`, error);
        }
      }

      // --- LLMs.txt proxy ---
      const llmsUrl = getLlmsProxyUrl(url.pathname, env.LLMS_FUNCTION_URL);
      if (llmsUrl) {
        try {
          const response = await fetch(llmsUrl, {
            headers: { 'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}` },
          });
          if (response.ok) {
            return new Response(response.body, {
              status: 200,
              headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=3600',
                'X-LLMs-Source': 'edge-function',
              },
            });
          }
          console.error(`LLMs edge function returned ${response.status}`);
        } catch (error) {
          console.error(`LLMs proxy error:`, error);
        }
      }

      // --- Short-link resolver:  /s/<code>  →  301/302 to target_path ---
      // Placed BEFORE the bot check so both humans and social crawlers get the redirect; a crawler
      // then re-requests the destination (a bot path) and hits the prerender below, where render-page
      // emits the per-form OG tags. Edge-cached so a viral link never touches origin/DB after the
      // first hit; resolution on a miss is a single primary-key read via PostgREST.
      const shortMatch = url.pathname.match(/^\/s\/([0-9A-Za-z]{4,16})$/);
      if (shortMatch) {
        const code = shortMatch[1];
        const slCache = caches.default;
        const slKey = new Request(`${url.origin}/__shortlink/${code}`, { method: 'GET' });
        const slHit = await slCache.match(slKey);
        if (slHit) return slHit;

        try {
          // Derive PostgREST from the render fn origin → no new Worker env var (respects keep_vars).
          const rpcUrl = `${new URL(env.RENDER_FUNCTION_URL).origin}/rest/v1/rpc/resolve_short_link`;
          const rpcRes = await fetch(rpcUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': env.SUPABASE_ANON_KEY,
              'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ _code: code }),
          });
          if (rpcRes.ok) {
            const row = (await rpcRes.json())?.[0];
            if (row && row.target_path) {
              // 301 (default) consolidates backlink/SEO equity on our own domain — the reason to
              // self-host rather than use an external shortener. permanent=false → 302 for future
              // repointable links.
              const redirect = new Response(null, {
                status: row.permanent === false ? 302 : 301,
                headers: {
                  'Location': `https://padeltrainer.ai${row.target_path}`,
                  'Cache-Control': 'public, max-age=86400',
                  'X-Shortlink': 'resolved',
                },
              });
              // Edge-cache only permanent (301) redirects; a 302 or a miss is never cached.
              if (row.permanent !== false) ctx.waitUntil(slCache.put(slKey, redirect.clone()));
              return redirect;
            }
          }
        } catch (error) {
          console.error(`Short-link resolve error for /s/${code}:`, error);
        }
        // Unknown / failed code → short-lived noindex 404 (never a 200 homepage soft-404).
        return new Response('Not found', {
          status: 404,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
            'X-Robots-Tag': 'noindex',
          },
        });
      }
    }

    // --- Bot pre-rendering with rate limiting + circuit breaker ---
    if (request.method === 'GET' && isBot(userAgent) && shouldPrerender(url.pathname)) {
      const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';

      // Rate limit: ask the (over-eager) bot to back off with a 503 — never a 200 page that
      // would get indexed/canonicalised in place of the real prerender.
      if (isBotRateLimited(clientIP)) {
        return unavailableResponse(30, 'rate-limited');
      }

      // Circuit breaker: backend is failing — return 503 Retry-After (not a 200 homepage)
      // for the remaining cooldown so crawlers come back instead of indexing a fallback.
      if (isCircuitOpen()) {
        return unavailableResponse(300, 'circuit-open');
      }

      // Check Cloudflare Cache
      const cache = caches.default;
      const cacheKey = prerenderCacheKey(url, url.pathname);
      const cachedResponse = await cache.match(cacheKey);
      if (cachedResponse) {
        return new Response(cachedResponse.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': cachedResponse.headers.get('Cache-Control') || `public, max-age=${PRERENDER_CACHE_TTL}`,
            'X-Rendered-By': 'padeltrainer-prerender',
            'X-Cache': 'HIT',
          },
        });
      }

      // Call render-page edge function
      try {
        const renderUrl = `${env.RENDER_FUNCTION_URL}?path=${encodeURIComponent(url.pathname)}`;
        const response = await fetch(renderUrl, {
          headers: {
            'User-Agent': userAgent,
            'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
          },
        });
        
        if (response.ok) {
          recordCircuitSuccess();
          const html = await response.text();
          const responseToCache = new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': `public, max-age=${PRERENDER_CACHE_TTL}`,
              'X-Rendered-By': 'padeltrainer-prerender',
              'X-Cache': 'MISS',
            },
          });
          ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
          return responseToCache;
        }

        // A 404/410 is a HEALTHY answer for an unknown page — render-page already returns a
        // proper noindex Not-Found document. Pass the REAL status + body straight through so
        // crawlers see a true 404 (not a 200 homepage soft-404). Don't trip the circuit breaker.
        if (response.status === 404 || response.status === 410) {
          recordCircuitSuccess();
          const html = await response.text();
          return new Response(html, {
            status: response.status,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              // Short cache so a page that later becomes real is re-crawled soon; not cached
              // under the prerender key, so it never masquerades as a valid page.
              'Cache-Control': 'public, max-age=300',
              'X-Robots-Tag': 'noindex',
              'X-Rendered-By': 'padeltrainer-prerender-notfound',
            },
          });
        }

        // 5xx / 429 / any other non-OK → transient backend failure. 401/403 means a
        // misconfigured/rotated SUPABASE_ANON_KEY (a hard config outage, not a per-page
        // issue) — trip the breaker too, so it surfaces as loud circuit-open 503s instead
        // of silently 503-ing every bot request forever.
        console.error(`Render failed with status ${response.status} for ${url.pathname}`);
        if (response.status >= 500 || response.status === 429 || response.status === 401 || response.status === 403) {
          recordCircuitFailure();
        }
      } catch (error) {
        console.error(`Error calling render function for ${url.pathname}:`, error);
        recordCircuitFailure();
      }

      // Transient render failure (5xx / 429 / network). Return 503 Retry-After + noindex —
      // NEVER a 200 homepage canonical, which would create soft-404s + duplicate canonicals.
      return unavailableResponse(120, 'render-unavailable');
    }
    
    // --- Human users: proxy to Lovable origin ---
    const originUrl = new URL(url.pathname + url.search, env.ORIGIN_URL);
    const originResponse = await fetch(originUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
    });
    
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: originResponse.headers,
    });
  },
};
