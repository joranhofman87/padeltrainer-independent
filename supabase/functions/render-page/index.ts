/**
 * render-page: Zero-DB-cost pre-rendering for SEO bots.
 * 
 * This function serves static HTML with appropriate meta tags based on URL patterns.
 * It does NOT query the database at all — all content is derived from the URL path.
 * 
 * Auth: Requires Supabase anon key in Authorization header (sent by Cloudflare Worker).
 * Direct bot hits without the key are rejected with 401.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';
const SUPPORTED_LANGS = ['en', 'nl', 'es', 'de', 'fr'];
const OG_LOCALE_MAP: Record<string, string> = {
  en: 'en_US', nl: 'nl_NL', es: 'es_ES', de: 'de_DE', fr: 'fr_FR',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.searchParams.get('path') || '/';

    // Strip language prefix
    const langMatch = path.match(/^\/(en|nl|es|de|fr)/);
    const lang = langMatch ? langMatch[1] : 'en';
    const cleanPath = path.replace(/^\/(en|nl|es|de|fr)/, '') || '/';

    const html = renderPath(cleanPath, lang);

    return new Response(html, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Error rendering page:', error);
    return new Response('Internal Server Error', {
      status: 500,
      headers: corsHeaders,
    });
  }
});

// ─── Route Matching ─────────────────────────────────────────────

function renderPath(cleanPath: string, lang: string): string {
  // Homepage
  if (cleanPath === '/' || cleanPath === '') {
    return page(
      lang === 'nl' ? 'PadelTrainer.ai - Vind & Boek Padel Trainers in Nederland' : 'PadelTrainer.ai - Find & Book Padel Trainers in the Netherlands',
      lang === 'nl' ? 'Ontdek gecertificeerde padel trainers bij locaties door heel Nederland. Vergelijk tarieven, lees reviews en boek direct.' : 'Discover certified padel trainers at locations across the Netherlands. Compare rates, read reviews, and book lessons directly.',
      '/', lang,
      `<h1>${lang === 'nl' ? 'Vind Jouw Perfecte Padel Trainer' : 'Find Your Perfect Padel Trainer'}</h1>
       <p>${lang === 'nl' ? 'Ontdek gecertificeerde padel trainers door heel Nederland.' : 'Discover certified padel trainers across the Netherlands.'}</p>`,
      [websiteSchema(), organizationSchema()]
    );
  }

  // Trainer profile: /trainer/:slug
  const trainerMatch = cleanPath.match(/^\/trainer\/([^/]+)$/);
  if (trainerMatch) {
    const slug = trainerMatch[1];
    const displayName = slugToDisplay(slug);
    return page(
      `${displayName} - Padel Trainer | PadelTrainer.ai`,
      `Book padel lessons with ${displayName}. View profile, experience, rates, and reviews on PadelTrainer.ai.`,
      `/trainer/${slug}`, lang,
      `<h1>${esc(displayName)}</h1><p>Padel Trainer on PadelTrainer.ai</p>`
    );
  }

  // City trainers: /trainers/:city
  const cityTrainersMatch = cleanPath.match(/^\/trainers\/([^/]+)$/);
  if (cityTrainersMatch) {
    const citySlug = cityTrainersMatch[1];
    const city = slugToDisplay(citySlug);
    return page(
      `Padel Trainers in ${city} | Find & Book Lessons`,
      `Find certified padel trainers in ${city}. Compare rates, read reviews, and book your first lesson today.`,
      `/trainers/${citySlug}`, lang,
      `<h1>Padel Trainers in ${esc(city)}</h1><p>Find and book padel trainers in ${esc(city)}.</p>`
    );
  }

  // Trainers directory
  if (cleanPath === '/trainers') {
    return page(
      'Find Padel Trainers | PadelTrainer.ai',
      'Browse all certified padel trainers in the Netherlands. Filter by location, level, and specialization.',
      '/trainers', lang,
      `<h1>Find Padel Trainers</h1><p>Browse all certified padel trainers in the Netherlands.</p>`
    );
  }

  // Padel city: /padel/:city
  const padelCityMatch = cleanPath.match(/^\/padel\/([^/]+)$/);
  if (padelCityMatch) {
    const citySlug = padelCityMatch[1];
    const city = slugToDisplay(citySlug);
    return page(
      `Padel in ${city} — Courts, Clubs & Coaches`,
      `Find padel clubs and coaches in ${city}. Compare courts, book lessons and start playing padel today.`,
      `/padel/${citySlug}`, lang,
      `<h1>Padel in ${esc(city)}</h1><p>Find padel courts, clubs and coaches in ${esc(city)}.</p>`
    );
  }

  // Location: /locations/:slug
  const locationMatch = cleanPath.match(/^\/locations\/([^/]+)$/);
  if (locationMatch) {
    const locSlug = locationMatch[1];
    const displayName = slugToDisplay(locSlug);
    return page(
      `${displayName} — Padel Club | PadelTrainer.ai`,
      `Discover ${displayName}. View courts, trainers, and book padel lessons at this club.`,
      `/locations/${locSlug}`, lang,
      `<h1>${esc(displayName)}</h1><p>Padel club on PadelTrainer.ai</p>`
    );
  }

  // Locations directory
  if (cleanPath === '/locations') {
    return page(
      'Padel Locations | PadelTrainer.ai',
      'Browse all padel clubs and locations in the Netherlands. Find courts near you.',
      '/locations', lang,
      `<h1>Padel Locations</h1><p>Browse all padel clubs and locations in the Netherlands.</p>`
    );
  }

  // Academy: /academies/:slug
  const academyMatch = cleanPath.match(/^\/academies\/([^/]+)$/);
  if (academyMatch) {
    const acSlug = academyMatch[1];
    const displayName = slugToDisplay(acSlug);
    return page(
      `${displayName} — Padel Academy | PadelTrainer.ai`,
      `Discover ${displayName}. View trainers, programs, and book padel lessons.`,
      `/academies/${acSlug}`, lang,
      `<h1>${esc(displayName)}</h1><p>Padel academy on PadelTrainer.ai</p>`
    );
  }

  // Blog listing
  if (cleanPath === '/blog') {
    return page(
      'Padel Blog — Tips, News & Training Advice | PadelTrainer.ai',
      'Read the latest padel articles, training tips, match strategies, and industry news.',
      '/blog', lang,
      `<h1>Padel Blog</h1><p>Tips, news and training advice for padel players.</p>`
    );
  }

  // Blog article: /blog/:slug
  const blogMatch = cleanPath.match(/^\/blog\/([^/]+)$/);
  if (blogMatch) {
    const slug = blogMatch[1];
    const title = slugToDisplay(slug);
    return page(
      `${title} | PadelTrainer.ai Blog`,
      `Read "${title}" on the PadelTrainer.ai blog.`,
      `/blog/${slug}`, lang,
      `<h1>${esc(title)}</h1>`
    );
  }

  // Learn
  if (cleanPath === '/learn') {
    return page('Learn Padel — Guides, Tactics & Drills', 'Guides, tactics, drills, and everything you need to improve your padel game.', '/learn', lang, `<h1>Learn Padel</h1>`);
  }
  const learnMatch = cleanPath.match(/^\/learn\/([^/]+)$/);
  if (learnMatch) {
    const title = slugToDisplay(learnMatch[1]);
    return page(`${title} | Learn Padel`, `Learn about ${title.toLowerCase()} in padel.`, `/learn/${learnMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Padel rules
  if (cleanPath === '/padel-rules') {
    return page('Padel Rules — Complete Guide', 'Learn all the official padel rules, scoring, serving, and match play.', '/padel-rules', lang, `<h1>Padel Rules</h1>`);
  }
  const rulesMatch = cleanPath.match(/^\/padel-rules\/([^/]+)$/);
  if (rulesMatch) {
    const title = slugToDisplay(rulesMatch[1]);
    return page(`${title} | Padel Rules`, `Learn about ${title.toLowerCase()}.`, `/padel-rules/${rulesMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Padel strokes
  if (cleanPath === '/padel-strokes') {
    return page('Padel Strokes — Master Every Shot', 'Explore all padel strokes and techniques.', '/padel-strokes', lang, `<h1>Padel Strokes</h1>`);
  }
  const strokesMatch = cleanPath.match(/^\/padel-strokes\/([^/]+)$/);
  if (strokesMatch) {
    const title = slugToDisplay(strokesMatch[1]);
    return page(`${title} | Padel Strokes`, `Master the ${title.toLowerCase()} in padel.`, `/padel-strokes/${strokesMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Padel coaches
  if (cleanPath === '/padel-coaches') {
    return page('Padel Coaches — Expert Coaching Tips', 'Discover expert padel coaches and their training tips.', '/padel-coaches', lang, `<h1>Padel Coaches</h1>`);
  }
  const coachesMatch = cleanPath.match(/^\/padel-coaches\/([^/]+)$/);
  if (coachesMatch) {
    const title = slugToDisplay(coachesMatch[1]);
    return page(`${title} | Padel Coaches`, `Learn from ${title}.`, `/padel-coaches/${coachesMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Video tips
  if (cleanPath === '/video-tips') {
    return page('Padel Video Tips & Tutorials', 'Watch expert padel coaching videos.', '/video-tips', lang, `<h1>Padel Video Tips</h1>`);
  }
  const videoMatch = cleanPath.match(/^\/video-tips\/([^/]+)$/);
  if (videoMatch) {
    const title = slugToDisplay(videoMatch[1]);
    return page(`${title} | Video Tips`, `Watch: ${title}`, `/video-tips/${videoMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Topics
  if (cleanPath === '/topics') {
    return page('Padel Topics | PadelTrainer.ai', 'Explore padel topics from beginner to advanced.', '/topics', lang, `<h1>Padel Topics</h1>`);
  }
  const topicsMatch = cleanPath.match(/^\/topics\/([^/]+)$/);
  if (topicsMatch) {
    const title = slugToDisplay(topicsMatch[1]);
    return page(`${title} | Padel Topics`, `Everything about ${title.toLowerCase()} in padel.`, `/topics/${topicsMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Gear / Rackets
  if (cleanPath === '/gear/rackets') {
    return page('Padel Rackets — Find Your Perfect Racket', 'Browse padel rackets. Compare specs and find the perfect racket.', '/gear/rackets', lang, `<h1>Padel Rackets</h1>`);
  }
  const racketMatch = cleanPath.match(/^\/gear\/rackets\/([^/]+)$/);
  if (racketMatch) {
    const title = slugToDisplay(racketMatch[1]);
    return page(`${title} | Padel Racket Review`, `Read the full review of the ${title} padel racket.`, `/gear/rackets/${racketMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Registration routes (no DB needed — generic meta)
  if (/^\/(academies|clubs)\/[^/]+\/register\/[^/]+$/.test(cleanPath) || /^\/register\/[^/]+$/.test(cleanPath)) {
    return page(
      'Register for Padel Training | PadelTrainer.ai',
      'Sign up for padel training sessions. Book your spot in a group or private padel lesson.',
      cleanPath, lang,
      `<h1>Register for Padel Training</h1><p>Book your spot in a padel training session.</p>`
    );
  }

  // Rating page: /rating/:id
  if (/^\/rating\/[^/]+$/.test(cleanPath)) {
    return page(
      'Padel Rating Progress | PadelTrainer.ai',
      'Track your padel rating improvement over time.',
      cleanPath, lang,
      `<h1>Padel Rating Progress</h1><p>Track your padel rating improvement on PadelTrainer.ai.</p>`
    );
  }

  // Static pages
  const staticPages: Record<string, { title: string; desc: string }> = {
    '/about': { title: 'About PadelTrainer.ai', desc: 'PadelTrainer.ai is the leading platform for finding and booking padel trainers in the Netherlands.' },
    '/pricing': { title: 'Pricing — PadelTrainer.ai', desc: 'Explore our flexible pricing plans for padel trainers and academies.' },
    '/founding-trainers': { title: 'Founding 100 Trainers — Free Premium Racket', desc: 'Be one of the first 100 padel coaches on PadelTrainer.ai and receive a free premium racket.' },
    '/partner': { title: 'Become a Partner — PadelTrainer.ai', desc: 'Partner with PadelTrainer.ai to reach thousands of padel players.' },
    '/privacy': { title: 'Privacy Policy — PadelTrainer.ai', desc: 'Read the PadelTrainer.ai privacy policy.' },
    '/terms': { title: 'Terms of Service — PadelTrainer.ai', desc: 'Read the PadelTrainer.ai terms of service.' },
    '/racket-finder': { title: 'Padel Racket Finder | PadelTrainer.ai', desc: 'Find the perfect padel racket for your playing style and level.' },
  };

  const staticMatch = staticPages[cleanPath];
  if (staticMatch) {
    return page(staticMatch.title, staticMatch.desc, cleanPath, lang, `<h1>${esc(staticMatch.title)}</h1>`);
  }

  // Fallback
  return page(
    'PadelTrainer.ai — Find & Book Padel Trainers',
    'Find and book certified padel trainers near you.',
    cleanPath, lang,
    `<h1>PadelTrainer.ai</h1><p>Find and book certified padel trainers near you.</p>`
  );
}

// ─── HTML Builder ───────────────────────────────────────────────

function page(title: string, description: string, urlPath: string, lang: string, body: string, structuredData?: object[]): string {
  const canonicalUrl = `${SITE_URL}/${lang}${urlPath}`;
  const ogImage = `${SITE_URL}/og-image.png`;
  const ogLocale = OG_LOCALE_MAP[lang] || 'en_US';

  const hreflangTags = SUPPORTED_LANGS
    .map(l => `<link rel="alternate" hreflang="${l}" href="${SITE_URL}/${l}${urlPath}">`)
    .join('\n  ');
  const ogLocaleAlternates = SUPPORTED_LANGS
    .filter(l => l !== lang)
    .map(l => `<meta property="og:locale:alternate" content="${OG_LOCALE_MAP[l]}">`)
    .join('\n  ');

  const sdScripts = (structuredData || [])
    .map(sd => `<script type="application/ld+json">${JSON.stringify(sd)}</script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${canonicalUrl}">
  ${hreflangTags}
  <link rel="alternate" hreflang="x-default" href="${SITE_URL}/nl${urlPath}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:site_name" content="PadelTrainer.ai">
  <meta property="og:locale" content="${ogLocale}">
  ${ogLocaleAlternates}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${ogImage}">
  <link rel="icon" href="${SITE_URL}/favicon.ico">
  ${sdScripts}
</head>
<body>
  <nav><a href="${SITE_URL}/${lang}" style="font-weight:bold;font-size:1.25rem;">PadelTrainer.ai</a></nav>
  <main style="max-width:1200px;margin:0 auto;padding:2rem 1rem;">
    ${body}
  </main>
  <footer style="text-align:center;padding:2rem;color:#666;font-size:0.875rem;">
    <p>&copy; ${new Date().getFullYear()} PadelTrainer.ai</p>
  </footer>
</body>
</html>`;
}

// ─── Helpers ────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function slugToDisplay(slug: string): string {
  return decodeURIComponent(slug)
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "PadelTrainer.ai",
    "url": SITE_URL,
  };
}

function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "PadelTrainer.ai",
    "url": SITE_URL,
    "logo": `${SITE_URL}/favicon.png`,
  };
}
