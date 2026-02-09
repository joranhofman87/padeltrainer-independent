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
 */

const BOT_USER_AGENTS = [
  // Search engines
  'googlebot',
  'google-inspectiontool',
  'bingbot',
  'msnbot',
  'yandexbot',
  'baiduspider',
  'duckduckbot',
  'applebot',
  
  // LLM crawlers
  'chatgpt-user',
  'oai-searchbot',
  'gptbot',
  'claudebot',
  'claude-web',
  'anthropic-ai',
  'perplexitybot',
  'cohere-ai',
  
  // Social media crawlers
  'facebookexternalhit',
  'facebot',
  'twitterbot',
  'linkedinbot',
  'slackbot',
  'whatsapp',
  'telegrambot',
  'discordbot',
  'pinterestbot',
  
  // Other
  'ia_archiver',
  'archive.org_bot',
  'semrushbot',
  'ahrefsbot',
];

function isBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some(bot => ua.includes(bot));
}

// Only pre-render marketing pages, not app routes
function isMarketingPath(pathname) {
  // Skip /app/* routes entirely
  if (pathname.startsWith('/app/') || pathname.startsWith('/app')) return false;
  
  // Skip static assets
  if (pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt)$/)) return false;
  
  // Marketing routes that should be pre-rendered
  const marketingPatterns = [
    /^\/(en|nl)\/?$/,                    // Homepage
    /^\/(en|nl)\/trainers\/?$/,          // Trainers directory
    /^\/(en|nl)\/trainers\/[^/]+$/,      // City pages
    /^\/(en|nl)\/trainer\/[^/]+$/,       // Trainer profiles
    /^\/(en|nl)\/locations\/?$/,         // Locations directory
    /^\/(en|nl)\/locations\/[^/]+$/,     // Location pages
    /^\/(en|nl)\/academies\/[^/]+$/,     // Academy pages
    /^\/(en|nl)\/blog\/[^/]+$/,          // Blog posts
    /^\/(en|nl)\/about\/?$/,             // About
    /^\/(en|nl)\/pricing\/?$/,           // Pricing
    /^\/(en|nl)\/partner\/?$/,           // Partner
  ];
  
  return marketingPatterns.some(pattern => pattern.test(pathname));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const userAgent = request.headers.get('User-Agent') || '';
    
    // Only intercept GET requests from bots on marketing pages
    if (request.method === 'GET' && isBot(userAgent) && isMarketingPath(url.pathname)) {
      try {
        // Call the render-page Edge Function
        const renderUrl = `${env.RENDER_FUNCTION_URL}?path=${encodeURIComponent(url.pathname)}`;
        
        const response = await fetch(renderUrl, {
          headers: {
            'User-Agent': userAgent,
          },
        });
        
        if (response.ok) {
          // Return the pre-rendered HTML with proper headers
          const html = await response.text();
          return new Response(html, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': response.headers.get('Cache-Control') || 'public, max-age=3600',
              'X-Rendered-By': 'padeltrainer-prerender',
            },
          });
        }
        
        // If render fails, fall through to origin
        console.error(`Render failed with status ${response.status} for ${url.pathname}`);
      } catch (error) {
        console.error(`Error calling render function for ${url.pathname}:`, error);
      }
    }
    
    // For human users or failed pre-renders, proxy to the Lovable origin
    const originUrl = new URL(url.pathname + url.search, env.ORIGIN_URL);
    
    const originResponse = await fetch(originUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow',
    });
    
    // Return origin response as-is
    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: originResponse.headers,
    });
  },
};
