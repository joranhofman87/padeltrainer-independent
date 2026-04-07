/**
 * Cloudflare Worker: Bot Detection Proxy for PadelTrainer.ai
 * 
 * This worker detects bot User-Agents and routes them to the 
 * render-page Edge Function for server-rendered HTML. 
 * Human users get the normal SPA from Lovable.
 * 
 * DEPLOYMENT:
 * 1. Set up padeltrainer.ai on Cloudflare (DNS proxy)
 * 2. Create a new Worker in Cloudflare dashboard
 * 3. Paste this code
 * 4. Add route: padeltrainer.ai/* → this worker
 * 5. Set environment variables:
 *    - ORIGIN_URL: Your Lovable preview/published URL (e.g., https://padeltrainer.lovable.app)
 *    - RENDER_FUNCTION_URL: Your Supabase Edge Function URL 
 *      (e.g., https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/render-page)
 *    - SITEMAP_FUNCTION_URL: Your Supabase sitemap Edge Function URL
 *      (e.g., https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/sitemap)
 *    - LLMS_FUNCTION_URL: Your Supabase llms-full-txt Edge Function URL
 *      (e.g., https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/llms-full-txt)
 */

const BOT_USER_AGENTS = [
  'googlebot', 'google-inspectiontool', 'bingbot', 'msnbot',
  'yandexbot', 'baiduspider', 'duckduckbot', 'applebot',
  'chatgpt-user', 'oai-searchbot', 'gptbot', 'claudebot',
  'claude-web', 'anthropic-ai', 'perplexitybot', 'cohere-ai',
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

// ─── Static Fallback HTML ───────────────────────────────────────
const STATIC_FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PadelTrainer.ai — Find & Book Padel Trainers</title>
  <meta name="description" content="Find and book certified padel trainers near you. PadelTrainer.ai connects players with the best coaches across Europe.">
  <meta property="og:title" content="PadelTrainer.ai — Find & Book Padel Trainers">
  <meta property="og:description" content="Find and book certified padel trainers near you across Europe.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://padeltrainer.ai">
  <meta property="og:image" content="https://padeltrainer.ai/og-image.png">
  <link rel="canonical" href="https://padeltrainer.ai">
</head>
<body>
  <h1>PadelTrainer.ai</h1>
  <p>Find and book certified padel trainers near you.</p>
  <p><a href="https://padeltrainer.ai">Visit PadelTrainer.ai</a></p>
</body>
</html>`;

// ─── Sitemap Proxy ──────────────────────────────────────────────
function getSitemapProxyUrl(pathname, sitemapFunctionUrl) {
  if (!sitemapFunctionUrl) return null;
  if (pathname === '/sitemap.xml') return `${sitemapFunctionUrl}?type=index`;
  if (pathname === '/sitemaps/sitemap-static.xml') return `${sitemapFunctionUrl}?type=static`;
  if (pathname === '/sitemaps/sitemap-content.xml') return `${sitemapFunctionUrl}?type=content`;
  return null;
}

// ─── LLMs.txt Proxy ─────────────────────────────────────────────
function getLlmsProxyUrl(pathname, llmsFunctionUrl) {
  if (!llmsFunctionUrl) return null;
  if (pathname === '/llms-full.txt') return llmsFunctionUrl;
  if (pathname === '/sitemaps/sitemap-provinces.xml') return `${sitemapFunctionUrl}?type=provinces`;
  const locMatch = pathname.match(/^\/sitemaps\/sitemap-locations-(\d+)\.xml$/);
  if (locMatch) return `${sitemapFunctionUrl}?type=locations&page=${locMatch[1]}`;
  const cityMatch = pathname.match(/^\/sitemaps\/sitemap-cities-(\d+)\.xml$/);
  if (cityMatch) return `${sitemapFunctionUrl}?type=cities&page=${cityMatch[1]}`;
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
    }

    // --- Bot pre-rendering with rate limiting + circuit breaker ---
    if (request.method === 'GET' && isBot(userAgent) && shouldPrerender(url.pathname)) {
      const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';

      // Rate limit: return static fallback if bot is too aggressive
      if (isBotRateLimited(clientIP)) {
        return new Response(STATIC_FALLBACK_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
            'X-Rendered-By': 'padeltrainer-static-fallback',
            'X-Rate-Limited': 'true',
          },
        });
      }

      // Circuit breaker: if backend is failing, don't even try
      if (isCircuitOpen()) {
        return new Response(STATIC_FALLBACK_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
            'X-Rendered-By': 'padeltrainer-static-fallback',
            'X-Circuit-Breaker': 'open',
          },
        });
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
        
        // Backend error — record failure, serve fallback
        console.error(`Render failed with status ${response.status} for ${url.pathname}`);
        if (response.status >= 500 || response.status === 429) {
          recordCircuitFailure();
        }
      } catch (error) {
        console.error(`Error calling render function for ${url.pathname}:`, error);
        recordCircuitFailure();
      }

      // Fallback on failure
      return new Response(STATIC_FALLBACK_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=60',
          'X-Rendered-By': 'padeltrainer-static-fallback',
        },
      });
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
