import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.searchParams.get('path') || '/';
    
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Strip language prefix (supports all 5 languages)
    const langMatch = path.match(/^\/(en|nl|es|de|fr)/);
    const lang = langMatch ? langMatch[1] : 'en';
    const cleanPath = path.replace(/^\/(en|nl|es|de|fr)/, '') || '/';

    // Route to the appropriate renderer
    let html: string;
    let cacheMaxAge = 3600; // default 1 hour

    if (cleanPath === '/' || cleanPath === '') {
      html = await renderHomepage(supabase, lang);
      cacheMaxAge = 3600;
    } else if (/^\/trainer\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/trainer\/([^/]+)$/)![1];
      html = await renderTrainerProfile(supabase, slug, lang);
      cacheMaxAge = 1800;
    } else if (/^\/trainers\/([^/]+)$/.test(cleanPath)) {
      const citySlug = cleanPath.match(/^\/trainers\/([^/]+)$/)![1];
      html = await renderCityPage(supabase, citySlug, lang);
      cacheMaxAge = 3600;
    } else if (/^\/locations\/([^/]+)$/.test(cleanPath)) {
      const locSlug = cleanPath.match(/^\/locations\/([^/]+)$/)![1];
      html = await renderLocationPage(supabase, locSlug, lang);
      cacheMaxAge = 3600;
    } else if (/^\/academies\/([^/]+)$/.test(cleanPath)) {
      const acSlug = cleanPath.match(/^\/academies\/([^/]+)$/)![1];
      html = await renderAcademyPage(supabase, acSlug, lang);
      cacheMaxAge = 3600;
    } else if (cleanPath === '/trainers') {
      html = await renderTrainersDirectory(supabase, lang);
      cacheMaxAge = 3600;
    } else if (cleanPath === '/locations') {
      html = await renderLocationsDirectory(supabase, lang);
      cacheMaxAge = 3600;
    } else if (cleanPath === '/about') {
      html = renderStaticPage('About PadelTrainer.ai', 'PadelTrainer.ai is the leading platform for finding and booking padel trainers in the Netherlands. We connect players with certified trainers for personalized coaching.', lang, '/about');
      cacheMaxAge = 86400;
    } else if (cleanPath === '/pricing') {
      html = renderStaticPage('Pricing - PadelTrainer.ai', 'Explore our flexible pricing plans for padel trainers and academies. Start with a free trial.', lang, '/pricing');
      cacheMaxAge = 86400;
    // ─── Blog routes ───
    } else if (cleanPath === '/blog') {
      html = await renderBlogListing(lang);
      cacheMaxAge = 1800;
    } else if (/^\/blog\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/blog\/([^/]+)$/)![1];
      html = await renderSanityArticle('blogPost', slug, lang, '/blog');
      cacheMaxAge = 1800;
    // ─── Rules routes ───
    } else if (cleanPath === '/padel-rules') {
      html = renderStaticPage('Padel Rules — Complete Guide to the Rules of Padel', 'Learn all the official padel rules, scoring, serving, and match play. A complete guide for beginners and advanced players.', lang, '/padel-rules');
      cacheMaxAge = 86400;
    } else if (/^\/padel-rules\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/padel-rules\/([^/]+)$/)![1];
      html = await renderSanityArticle('rulesArticle', slug, lang, '/padel-rules');
      cacheMaxAge = 3600;
    // ─── Strokes routes ───
    } else if (cleanPath === '/padel-strokes') {
      html = renderStaticPage('Padel Strokes — Master Every Shot in Padel', 'Explore all padel strokes and techniques. Learn the bandeja, vibora, smash, and more with tips from top coaches.', lang, '/padel-strokes');
      cacheMaxAge = 86400;
    } else if (/^\/padel-strokes\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/padel-strokes\/([^/]+)$/)![1];
      html = await renderSanityArticle('stroke', slug, lang, '/padel-strokes');
      cacheMaxAge = 3600;
    // ─── Coaches routes ───
    } else if (cleanPath === '/padel-coaches') {
      html = renderStaticPage('Padel Coaches — Expert Coaching Tips & Techniques', 'Discover expert padel coaches and their training tips, techniques, and video lessons.', lang, '/padel-coaches');
      cacheMaxAge = 86400;
    } else if (/^\/padel-coaches\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/padel-coaches\/([^/]+)$/)![1];
      html = await renderSanityArticle('trainer', slug, lang, '/padel-coaches');
      cacheMaxAge = 3600;
    // ─── Video Tips routes ───
    } else if (cleanPath === '/video-tips') {
      html = renderStaticPage('Padel Video Tips — Watch & Learn from Top Coaches', 'Watch curated padel video tips from top coaches. Improve your technique with visual guides for every skill level.', lang, '/video-tips');
      cacheMaxAge = 86400;
    } else if (/^\/video-tips\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/video-tips\/([^/]+)$/)![1];
      html = await renderSanityArticle('videoTip', slug, lang, '/video-tips');
      cacheMaxAge = 3600;
    // ─── Learn routes ───
    } else if (cleanPath === '/learn') {
      html = renderStaticPage('Learn Padel — Guides, Tactics & Drills', 'Guides, tactics, drills, and everything you need to improve your padel game. From beginner to advanced.', lang, '/learn');
      cacheMaxAge = 86400;
    } else if (/^\/learn\/([^/]+)$/.test(cleanPath)) {
      const slug = cleanPath.match(/^\/learn\/([^/]+)$/)![1];
      html = await renderSanityArticle('learningArticle', slug, lang, '/learn');
      cacheMaxAge = 3600;
    // ─── Other static pages ───
    } else if (cleanPath === '/partner') {
      html = renderStaticPage('Become a Partner — PadelTrainer.ai', 'Partner with PadelTrainer.ai to reach thousands of padel players. Promote your brand, products, or services to the padel community.', lang, '/partner');
      cacheMaxAge = 86400;
    } else if (cleanPath === '/privacy') {
      html = renderStaticPage('Privacy Policy — PadelTrainer.ai', 'Read the PadelTrainer.ai privacy policy. Learn how we collect, use, and protect your personal data.', lang, '/privacy');
      cacheMaxAge = 86400;
    } else if (cleanPath === '/terms') {
      html = renderStaticPage('Terms of Service — PadelTrainer.ai', 'Read the PadelTrainer.ai terms of service. Understand the rules and guidelines for using our platform.', lang, '/terms');
      cacheMaxAge = 86400;
    } else {
      // Fallback: return minimal HTML with meta redirect to SPA
      html = renderFallback(path, lang);
      cacheMaxAge = 3600;
    }

    return new Response(html, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=${cacheMaxAge}`,
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

// ─── HTML Helpers ───────────────────────────────────────────────

function htmlDoc(opts: {
  title: string;
  description: string;
  url: string;
  lang: string;
  image?: string;
  structuredData?: object[];
  body: string;
}) {
  const canonicalUrl = `${SITE_URL}/${opts.lang}${opts.url}`;
  const altLang = opts.lang === 'nl' ? 'en' : 'nl';
  const altUrl = `${SITE_URL}/${altLang}${opts.url}`;
  const ogImage = opts.image || `${SITE_URL}/og-image.png`;

  const structuredDataScripts = (opts.structuredData || [])
    .map(sd => `<script type="application/ld+json">${JSON.stringify(sd)}</script>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="${opts.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escHtml(opts.title)}</title>
  <meta name="description" content="${escHtml(opts.description)}">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="${opts.lang}" href="${canonicalUrl}">
  <link rel="alternate" hreflang="${altLang}" href="${altUrl}">
  <link rel="alternate" hreflang="x-default" href="${SITE_URL}/nl${opts.url}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escHtml(opts.title)}">
  <meta property="og:description" content="${escHtml(opts.description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:site_name" content="PadelTrainer.ai">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escHtml(opts.title)}">
  <meta name="twitter:description" content="${escHtml(opts.description)}">
  <meta name="twitter:image" content="${ogImage}">
  <link rel="icon" href="${SITE_URL}/favicon.ico">
  ${structuredDataScripts}
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 0; color: #1a1a1a; background: #fff; }
    .container { max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; }
    h2 { font-size: 1.5rem; margin-top: 2rem; margin-bottom: 0.75rem; }
    h3 { font-size: 1.2rem; margin-bottom: 0.5rem; }
    p { line-height: 1.6; color: #444; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .badge { display: inline-block; background: #f0fdf4; color: #16a34a; padding: 2px 8px; border-radius: 4px; font-size: 0.875rem; }
    .stats { display: flex; gap: 2rem; margin: 1rem 0; }
    .stat { text-align: center; }
    .stat-value { font-size: 1.5rem; font-weight: bold; color: #2563eb; }
    .stat-label { font-size: 0.875rem; color: #666; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
    .breadcrumb { font-size: 0.875rem; color: #666; margin-bottom: 1rem; }
    .breadcrumb a { color: #666; }
    .breadcrumb span { margin: 0 0.5rem; }
    .faq { margin-top: 2rem; }
    .faq-item { margin-bottom: 1.5rem; }
    .faq-q { font-weight: 600; margin-bottom: 0.5rem; }
    nav { background: #f8fafc; padding: 1rem 0; border-bottom: 1px solid #e5e7eb; }
    nav .container { display: flex; align-items: center; justify-content: space-between; padding-top: 0; padding-bottom: 0; }
    footer { background: #f8fafc; padding: 2rem 0; border-top: 1px solid #e5e7eb; margin-top: 3rem; text-align: center; color: #666; font-size: 0.875rem; }
  </style>
</head>
<body>
  <nav>
    <div class="container">
      <a href="${SITE_URL}/${opts.lang}" style="font-weight: bold; font-size: 1.25rem; color: #1a1a1a;">PadelTrainer.ai</a>
      <div>
        <a href="${SITE_URL}/${opts.lang}/trainers" style="margin-right: 1rem;">Trainers</a>
        <a href="${SITE_URL}/${opts.lang}/locations" style="margin-right: 1rem;">Locations</a>
        <a href="${SITE_URL}/${opts.lang}/academies" style="margin-right: 1rem;">Academies</a>
        <a href="${SITE_URL}/${opts.lang}/blog">Blog</a>
      </div>
    </div>
  </nav>
  <div class="container">
    ${opts.body}
  </div>
  <footer>
    <div class="container">
      <p>&copy; ${new Date().getFullYear()} PadelTrainer.ai. All rights reserved.</p>
      <p>
        <a href="${SITE_URL}/${opts.lang}/about">About</a> &middot;
        <a href="${SITE_URL}/${opts.lang}/pricing">Pricing</a> &middot;
        <a href="${SITE_URL}/${opts.lang}/terms">Terms</a> &middot;
        <a href="${SITE_URL}/${opts.lang}/privacy">Privacy</a>
      </p>
    </div>
  </footer>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function breadcrumb(items: { name: string; url?: string }[], lang: string): string {
  return `<div class="breadcrumb">${items.map((item, i) => {
    if (item.url) return `<a href="${SITE_URL}/${lang}${item.url}">${escHtml(item.name)}</a>`;
    return `<strong>${escHtml(item.name)}</strong>`;
  }).join('<span>›</span>')}</div>`;
}

function breadcrumbSchema(items: { name: string; url?: string }[], lang: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": items.map((item, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": item.name,
      ...(item.url ? { "item": `${SITE_URL}/${lang}${item.url}` } : {})
    }))
  };
}

// ─── Page Renderers ─────────────────────────────────────────────

async function renderHomepage(supabase: any, lang: string): Promise<string> {
  const [trainerRes, locationRes, academyRes] = await Promise.all([
    supabase.from('trainer_profiles').select('id', { count: 'exact', head: true }),
    supabase.from('locations').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('academy_profiles').select('id', { count: 'exact', head: true }).eq('is_verified', true).eq('is_public', true),
  ]);

  const trainerCount = trainerRes.count || 0;
  const locationCount = locationRes.count || 0;
  const academyCount = academyRes.count || 0;

  // Fetch top cities
  const { data: locations } = await supabase
    .from('locations')
    .select('city')
    .eq('is_active', true);
  
  const cityCounts: Record<string, number> = {};
  locations?.forEach((l: any) => {
    cityCounts[l.city] = (cityCounts[l.city] || 0) + 1;
  });
  const topCities = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);

  const title = lang === 'nl' 
    ? 'PadelTrainer.ai - Vind & Boek Padel Trainers in Nederland'
    : 'PadelTrainer.ai - Find & Book Padel Trainers in the Netherlands';
  const description = lang === 'nl'
    ? `Ontdek ${trainerCount}+ gecertificeerde padel trainers bij ${locationCount}+ locaties. Vergelijk tarieven, lees reviews en boek direct.`
    : `Discover ${trainerCount}+ certified padel trainers at ${locationCount}+ locations. Compare rates, read reviews, and book lessons directly.`;

  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "PadelTrainer.ai",
      "url": SITE_URL,
      "description": description,
      "potentialAction": {
        "@type": "SearchAction",
        "target": `${SITE_URL}/${lang}/trainers?search={search_term}`,
        "query-input": "required name=search_term"
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": "PadelTrainer.ai",
      "url": SITE_URL,
      "logo": `${SITE_URL}/favicon.png`,
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "customer service",
        "availableLanguage": ["Dutch", "English"]
      }
    }
  ];

  const citiesHtml = topCities.map(([city, count]) => {
    const slug = encodeURIComponent(city.toLowerCase().replace(/\s+/g, '-'));
    return `<div class="card"><a href="${SITE_URL}/${lang}/trainers/${slug}"><h3>${escHtml(city)}</h3><p>${count} padel clubs</p></a></div>`;
  }).join('');

  const body = `
    <h1>${lang === 'nl' ? 'Vind Jouw Perfecte Padel Trainer' : 'Find Your Perfect Padel Trainer'}</h1>
    <p>${description}</p>
    <div class="stats">
      <div class="stat"><div class="stat-value">${trainerCount}+</div><div class="stat-label">${lang === 'nl' ? 'Trainers' : 'Trainers'}</div></div>
      <div class="stat"><div class="stat-value">${locationCount}+</div><div class="stat-label">${lang === 'nl' ? 'Locaties' : 'Locations'}</div></div>
      <div class="stat"><div class="stat-value">${academyCount}</div><div class="stat-label">${lang === 'nl' ? 'Academies' : 'Academies'}</div></div>
    </div>
    <h2>${lang === 'nl' ? 'Populaire Steden' : 'Popular Cities'}</h2>
    <div class="grid">${citiesHtml}</div>
    <h2>${lang === 'nl' ? 'Hoe het werkt' : 'How it Works'}</h2>
    <ol>
      <li><strong>${lang === 'nl' ? 'Zoek een trainer' : 'Find a trainer'}</strong> - ${lang === 'nl' ? 'Zoek op locatie, niveau of specialisatie' : 'Search by location, level, or specialization'}</li>
      <li><strong>${lang === 'nl' ? 'Vergelijk & kies' : 'Compare & choose'}</strong> - ${lang === 'nl' ? 'Lees reviews en vergelijk tarieven' : 'Read reviews and compare rates'}</li>
      <li><strong>${lang === 'nl' ? 'Boek een les' : 'Book a lesson'}</strong> - ${lang === 'nl' ? 'Boek direct online' : 'Book directly online'}</li>
    </ol>
  `;

  return htmlDoc({ title, description, url: '/', lang, structuredData, body });
}

async function renderTrainerProfile(supabase: any, slug: string, lang: string): Promise<string> {
  // Try by slug first, then UUID
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slug);
  
  let trainerQuery = supabase
    .from('trainer_profiles')
    .select('id, user_id, slug, hourly_rate, experience_years, certifications, specializations, is_verified, is_public, coaching_method');

  if (isUUID) {
    trainerQuery = trainerQuery.eq('id', slug);
  } else {
    trainerQuery = trainerQuery.eq('slug', slug);
  }

  const { data: trainer } = await trainerQuery.maybeSingle();
  if (!trainer) return renderNotFound(lang);

  // Fetch profile, locations, and reviews in parallel
  const [profileRes, locationsRes, reviewsRes] = await Promise.all([
    supabase.from('profiles').select('full_name, avatar_url, bio, location').eq('user_id', trainer.user_id).maybeSingle(),
    supabase.from('trainer_locations').select('location:locations(name, city, slug)').eq('trainer_id', trainer.id),
    supabase.from('reviews').select('rating').eq('trainer_id', trainer.id).eq('is_public', true),
  ]);

  const profile = profileRes.data;
  const locations = locationsRes.data || [];
  const reviews = reviewsRes.data || [];
  
  const name = profile?.full_name || 'Padel Trainer';
  const city = profile?.location || locations[0]?.location?.city || '';
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const avgRating = reviews.length > 0 
    ? (reviews.reduce((sum: number, r: any) => sum + r.rating, 0) / reviews.length).toFixed(1) 
    : null;

  const title = `${name} - Padel Trainer${city ? ` in ${city}` : ''}`;
  const description = profile?.bio 
    ? profile.bio.slice(0, 155)
    : `Book padel lessons with ${name}${city ? ` in ${city}` : ''}. ${trainer.experience_years ? `${trainer.experience_years} years experience.` : ''} ${trainer.hourly_rate ? `€${trainer.hourly_rate}/hour.` : ''}`;

  const trainerSlug = trainer.slug || trainer.id;
  const breadcrumbItems = [
    { name: 'Home', url: '/' },
    { name: 'Trainers', url: '/trainers' },
    ...(city ? [{ name: city, url: `/trainers/${citySlug}` }] : []),
    { name }
  ];

  const structuredData: object[] = [
    breadcrumbSchema(breadcrumbItems, lang),
    {
      "@context": "https://schema.org",
      "@type": "Person",
      "name": name,
      "jobTitle": "Padel Trainer",
      "image": profile?.avatar_url,
      "url": `${SITE_URL}/${lang}/trainer/${trainerSlug}`,
      ...(city && { "address": { "@type": "PostalAddress", "addressLocality": city } }),
      ...(avgRating && reviews.length > 0 && {
        "aggregateRating": {
          "@type": "AggregateRating",
          "ratingValue": avgRating,
          "reviewCount": reviews.length,
          "bestRating": 5,
          "worstRating": 1
        }
      })
    }
  ];

  const locationsHtml = locations.map((l: any) => {
    if (!l.location) return '';
    return `<li><a href="${SITE_URL}/${lang}/locations/${l.location.slug}">${escHtml(l.location.name)}</a> - ${escHtml(l.location.city)}</li>`;
  }).join('');

  const specsHtml = trainer.specializations?.length 
    ? `<p><strong>${lang === 'nl' ? 'Specialisaties' : 'Specializations'}:</strong> ${trainer.specializations.map(escHtml).join(', ')}</p>` 
    : '';
  const certsHtml = trainer.certifications?.length 
    ? `<p><strong>${lang === 'nl' ? 'Certificeringen' : 'Certifications'}:</strong> ${trainer.certifications.map(escHtml).join(', ')}</p>` 
    : '';

  const body = `
    ${breadcrumb(breadcrumbItems, lang)}
    <h1>${escHtml(name)}</h1>
    ${trainer.is_verified ? '<span class="badge">✓ Verified</span>' : ''}
    <div class="stats">
      ${trainer.hourly_rate ? `<div class="stat"><div class="stat-value">€${trainer.hourly_rate}</div><div class="stat-label">${lang === 'nl' ? 'per uur' : 'per hour'}</div></div>` : ''}
      ${trainer.experience_years ? `<div class="stat"><div class="stat-value">${trainer.experience_years}</div><div class="stat-label">${lang === 'nl' ? 'jaar ervaring' : 'years experience'}</div></div>` : ''}
      ${avgRating ? `<div class="stat"><div class="stat-value">${avgRating} ★</div><div class="stat-label">${reviews.length} ${reviews.length === 1 ? 'review' : 'reviews'}</div></div>` : ''}
    </div>
    ${city ? `<p>📍 ${escHtml(city)}</p>` : ''}
    ${profile?.bio ? `<h2>${lang === 'nl' ? 'Over' : 'About'} ${escHtml(name)}</h2><p>${escHtml(profile.bio)}</p>` : ''}
    ${trainer.coaching_method ? `<h2>${lang === 'nl' ? 'Coaching Methode' : 'Coaching Method'}</h2><p>${escHtml(trainer.coaching_method)}</p>` : ''}
    ${specsHtml}
    ${certsHtml}
    ${locationsHtml ? `<h2>${lang === 'nl' ? 'Trainingslocaties' : 'Training Locations'}</h2><ul>${locationsHtml}</ul>` : ''}
    ${city ? `<p><a href="${SITE_URL}/${lang}/trainers/${citySlug}">${lang === 'nl' ? `Bekijk alle trainers in ${city}` : `View all trainers in ${city}`} →</a></p>` : ''}
  `;

  return htmlDoc({ title, description, url: `/trainer/${trainerSlug}`, lang, image: profile?.avatar_url, structuredData, body });
}

async function renderCityPage(supabase: any, citySlug: string, lang: string): Promise<string> {
  const displayCity = decodeURIComponent(citySlug)
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

  // Fetch trainers in this city and locations
  const [profilesRes, locationsRes] = await Promise.all([
    supabase.from('profiles').select('user_id, full_name, location').ilike('location', `%${displayCity}%`),
    supabase.from('locations').select('id, name, city, slug, indoor_courts, outdoor_courts').eq('is_active', true),
  ]);

  const profiles = profilesRes.data || [];
  const allLocations = locationsRes.data || [];
  const cityLocations = allLocations.filter((l: any) => 
    l.city.toLowerCase().replace(/\s+/g, '-') === citySlug.toLowerCase()
  );

  // Fetch trainer profiles for these users
  const userIds = profiles.map((p: any) => p.user_id);
  let trainers: any[] = [];
  if (userIds.length > 0) {
    const { data } = await supabase
      .from('trainer_profiles')
      .select('id, user_id, slug, hourly_rate, experience_years, is_verified, specializations')
      .in('user_id', userIds)
      .eq('is_public', true);
    trainers = data || [];
  }

  // Also get trainers linked to locations in this city
  if (cityLocations.length > 0) {
    const locIds = cityLocations.map((l: any) => l.id);
    const { data: trainerLocs } = await supabase
      .from('trainer_locations')
      .select('trainer_id')
      .in('location_id', locIds);
    
    const linkedTrainerIds = trainerLocs?.map((tl: any) => tl.trainer_id) || [];
    if (linkedTrainerIds.length > 0) {
      const { data: linkedTrainers } = await supabase
        .from('trainer_profiles')
        .select('id, user_id, slug, hourly_rate, experience_years, is_verified, specializations')
        .in('id', linkedTrainerIds)
        .eq('is_public', true);
      
      // Merge without duplicates
      const existingIds = new Set(trainers.map((t: any) => t.id));
      linkedTrainers?.forEach((t: any) => {
        if (!existingIds.has(t.id)) trainers.push(t);
      });

      // Fetch names for newly added trainers
      const newUserIds = linkedTrainers?.filter((t: any) => !existingIds.has(t.id)).map((t: any) => t.user_id) || [];
      if (newUserIds.length > 0) {
        const { data: newProfiles } = await supabase
          .from('profiles')
          .select('user_id, full_name, location')
          .in('user_id', newUserIds);
        if (newProfiles) profiles.push(...newProfiles);
      }
    }
  }

  const profileMap: Record<string, any> = {};
  profiles.forEach((p: any) => { profileMap[p.user_id] = p; });

  const rates = trainers.filter((t: any) => t.hourly_rate).map((t: any) => t.hourly_rate);
  const minRate = rates.length > 0 ? Math.min(...rates) : 30;
  const maxRate = rates.length > 0 ? Math.max(...rates) : 60;

  const title = `Padel Trainers in ${displayCity} | Find & Book Lessons`;
  const description = `Find ${trainers.length} certified padel trainers in ${displayCity}. Compare rates from €${minRate}/hour, read reviews, and book your first lesson today.`;

  const faqQuestions = [
    {
      question: `How much do padel lessons cost in ${displayCity}?`,
      answer: trainers.length > 0
        ? `Padel lessons in ${displayCity} typically range from €${minRate} to €${maxRate} per hour. Prices vary based on trainer experience, certifications, and lesson type.`
        : `Padel lesson prices in ${displayCity} vary based on trainer experience and qualifications. Contact trainers directly for current rates.`
    },
    {
      question: `How do I find a padel trainer near me in ${displayCity}?`,
      answer: `Browse our directory of ${trainers.length} certified padel trainers in ${displayCity}. Compare ratings, read reviews, and book lessons directly through PadelTrainer.ai.`
    }
  ];

  const breadcrumbItems = [
    { name: 'Home', url: '/' },
    { name: 'Trainers', url: '/trainers' },
    { name: displayCity }
  ];

  const structuredData = [
    breadcrumbSchema(breadcrumbItems, lang),
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": `Padel Trainers in ${displayCity}`,
      "description": description,
      "numberOfItems": trainers.length,
      "itemListElement": trainers.slice(0, 10).map((t: any, i: number) => ({
        "@type": "ListItem",
        "position": i + 1,
        "item": {
          "@type": "Person",
          "name": profileMap[t.user_id]?.full_name || "Padel Trainer",
          "jobTitle": "Padel Trainer",
          "url": `${SITE_URL}/${lang}/trainer/${t.slug || t.id}`,
          "address": { "@type": "PostalAddress", "addressLocality": displayCity }
        }
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": faqQuestions.map(faq => ({
        "@type": "Question",
        "name": faq.question,
        "acceptedAnswer": { "@type": "Answer", "text": faq.answer }
      }))
    }
  ];

  const trainersHtml = trainers.slice(0, 20).map((t: any) => {
    const p = profileMap[t.user_id];
    const trainerUrl = `${SITE_URL}/${lang}/trainer/${t.slug || t.id}`;
    return `<div class="card">
      <h3><a href="${trainerUrl}">${escHtml(p?.full_name || 'Padel Trainer')}</a></h3>
      ${t.is_verified ? '<span class="badge">✓ Verified</span>' : ''}
      ${t.hourly_rate ? `<p>€${t.hourly_rate}/hour</p>` : ''}
      ${t.experience_years ? `<p>${t.experience_years} years experience</p>` : ''}
      ${t.specializations?.length ? `<p>${t.specializations.join(', ')}</p>` : ''}
    </div>`;
  }).join('');

  const locationsHtml = cityLocations.slice(0, 12).map((l: any) => {
    const courts = [];
    if (l.indoor_courts) courts.push(`${l.indoor_courts} indoor`);
    if (l.outdoor_courts) courts.push(`${l.outdoor_courts} outdoor`);
    return `<div class="card">
      <h3><a href="${SITE_URL}/${lang}/locations/${l.slug}">${escHtml(l.name)}</a></h3>
      ${courts.length > 0 ? `<p>${courts.join(', ')} courts</p>` : ''}
    </div>`;
  }).join('');

  const faqHtml = faqQuestions.map(faq => `
    <div class="faq-item">
      <div class="faq-q">${escHtml(faq.question)}</div>
      <p>${escHtml(faq.answer)}</p>
    </div>
  `).join('');

  // Get nearby cities
  const otherCities = new Map<string, number>();
  allLocations.forEach((l: any) => {
    if (l.city.toLowerCase().replace(/\s+/g, '-') !== citySlug.toLowerCase()) {
      otherCities.set(l.city, (otherCities.get(l.city) || 0) + 1);
    }
  });
  const nearbyCities = Array.from(otherCities.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  const nearbyCitiesHtml = nearbyCities.map(([city, count]) => {
    const slug = encodeURIComponent(city.toLowerCase().replace(/\s+/g, '-'));
    return `<a href="${SITE_URL}/${lang}/trainers/${slug}" style="display:inline-block; margin: 0.25rem; padding: 0.5rem 1rem; background: #f0f9ff; border-radius: 6px;">${escHtml(city)} (${count})</a>`;
  }).join('');

  const body = `
    ${breadcrumb(breadcrumbItems, lang)}
    <h1>Padel Trainers in ${escHtml(displayCity)}</h1>
    <p>${escHtml(description)}</p>
    <p>${trainers.length} trainer${trainers.length !== 1 ? 's' : ''} found in ${escHtml(displayCity)}</p>
    <div class="grid">${trainersHtml}</div>
    ${locationsHtml ? `<h2>Padel Clubs in ${escHtml(displayCity)}</h2><div class="grid">${locationsHtml}</div>` : ''}
    <div class="faq"><h2>Frequently Asked Questions</h2>${faqHtml}</div>
    ${nearbyCitiesHtml ? `<h2>Explore Other Cities</h2><div>${nearbyCitiesHtml}</div>` : ''}
  `;

  return htmlDoc({ title, description, url: `/trainers/${citySlug}`, lang, image: `${SITE_URL}/og-trainers.png`, structuredData, body });
}

async function renderLocationPage(supabase: any, slug: string, lang: string): Promise<string> {
  const { data: location } = await supabase
    .from('locations')
    .select('id, name, city, slug, street_address, postal_code, indoor_courts, outdoor_courts, number_of_courts, website_url, description, logo_url')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (!location) return renderNotFound(lang);

  // Fetch trainers and club profile
  const [trainerLocsRes, clubRes] = await Promise.all([
    supabase.from('trainer_locations').select('trainer_id, trainer_profiles:trainer_profiles(slug, user_id)').eq('location_id', location.id),
    supabase.from('club_profiles').select('description, logo_url, banner_url').eq('location_id', location.id).maybeSingle(),
  ]);

  const trainerLocs = trainerLocsRes.data || [];
  const clubProfile = clubRes.data;

  // Fetch trainer names
  const trainerUserIds = trainerLocs.map((tl: any) => tl.trainer_profiles?.user_id).filter(Boolean);
  let trainerNames: Record<string, string> = {};
  if (trainerUserIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('user_id, full_name').in('user_id', trainerUserIds);
    profiles?.forEach((p: any) => { trainerNames[p.user_id] = p.full_name; });
  }

  const displayDesc = clubProfile?.description || location.description || '';
  const displayLogo = clubProfile?.logo_url || location.logo_url;
  const citySlug = location.city.toLowerCase().replace(/\s+/g, '-');

  const title = `${location.name} - Padel Training in ${location.city}`;
  const description = displayDesc
    ? displayDesc.slice(0, 155)
    : `Book padel lessons at ${location.name} in ${location.city}. ${trainerLocs.length} certified trainers available.`;

  const breadcrumbItems = [
    { name: 'Home', url: '/' },
    { name: 'Locations', url: '/locations' },
    { name: location.name }
  ];

  const structuredData = [
    breadcrumbSchema(breadcrumbItems, lang),
    {
      "@context": "https://schema.org",
      "@type": "SportsClub",
      "name": location.name,
      "address": {
        "@type": "PostalAddress",
        "streetAddress": location.street_address,
        "addressLocality": location.city,
        "postalCode": location.postal_code,
        "addressCountry": "NL"
      },
      "url": location.website_url,
      "sport": "Padel",
      ...(location.number_of_courts && { "numberOfRooms": location.number_of_courts }),
      ...(displayDesc && { "description": displayDesc }),
      ...(displayLogo && { "image": displayLogo })
    }
  ];

  const courts = [];
  if (location.indoor_courts) courts.push(`${location.indoor_courts} indoor`);
  if (location.outdoor_courts) courts.push(`${location.outdoor_courts} outdoor`);

  const trainersHtml = trainerLocs.map((tl: any) => {
    const tp = tl.trainer_profiles;
    if (!tp) return '';
    const name = trainerNames[tp.user_id] || 'Trainer';
    return `<li><a href="${SITE_URL}/${lang}/trainer/${tp.slug || tp.user_id}">${escHtml(name)}</a></li>`;
  }).filter(Boolean).join('');

  const body = `
    ${breadcrumb(breadcrumbItems, lang)}
    <h1>${escHtml(location.name)}</h1>
    <p>📍 ${escHtml([location.street_address, location.postal_code, location.city].filter(Boolean).join(', '))}</p>
    ${courts.length > 0 ? `<p>🏟️ ${courts.join(', ')} courts</p>` : ''}
    ${displayDesc ? `<h2>${lang === 'nl' ? 'Over deze locatie' : 'About this location'}</h2><p>${escHtml(displayDesc)}</p>` : ''}
    ${trainersHtml ? `<h2>${lang === 'nl' ? 'Trainers op deze locatie' : 'Trainers at this location'} (${trainerLocs.length})</h2><ul>${trainersHtml}</ul>` : ''}
    ${location.website_url ? `<p><a href="${location.website_url}" target="_blank" rel="noopener">${lang === 'nl' ? 'Bezoek website' : 'Visit website'} →</a></p>` : ''}
    <p><a href="${SITE_URL}/${lang}/trainers/${citySlug}">${lang === 'nl' ? `Vind meer trainers in ${location.city}` : `Find more trainers in ${location.city}`} →</a></p>
  `;

  return htmlDoc({ title, description, url: `/locations/${slug}`, lang, image: displayLogo || `${SITE_URL}/og-locations.png`, structuredData, body });
}

async function renderAcademyPage(supabase: any, slug: string, lang: string): Promise<string> {
  const { data: academy } = await supabase
    .from('academy_profiles')
    .select('id, name, slug, description, logo_url, banner_url, website_url, is_verified, is_public')
    .eq('slug', slug)
    .eq('is_public', true)
    .maybeSingle();

  if (!academy) return renderNotFound(lang);

  // Fetch trainers and locations
  const [trainersRes, locsRes] = await Promise.all([
    supabase.from('academy_trainers').select('trainer_profile_id, trainer_profiles:trainer_profiles(slug, user_id)').eq('academy_profile_id', academy.id).eq('status', 'active'),
    supabase.from('academy_locations').select('location:locations(name, city, slug)').eq('academy_profile_id', academy.id).eq('is_active', true),
  ]);

  const trainers = trainersRes.data || [];
  const locations = locsRes.data || [];

  // Fetch trainer names
  const userIds = trainers.map((t: any) => t.trainer_profiles?.user_id).filter(Boolean);
  let names: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data } = await supabase.from('profiles').select('user_id, full_name').in('user_id', userIds);
    data?.forEach((p: any) => { names[p.user_id] = p.full_name; });
  }

  const title = `${academy.name} - Padel Academy`;
  const description = academy.description
    ? academy.description.slice(0, 155)
    : `${academy.name} - Professional padel training academy with ${trainers.length} certified trainers at ${locations.length} locations.`;

  const breadcrumbItems = [
    { name: 'Home', url: '/' },
    { name: 'Academies', url: '/academies' },
    { name: academy.name }
  ];

  const structuredData = [
    breadcrumbSchema(breadcrumbItems, lang),
    {
      "@context": "https://schema.org",
      "@type": "EducationalOrganization",
      "name": academy.name,
      "description": academy.description,
      "url": `${SITE_URL}/${lang}/academies/${slug}`,
      "logo": academy.logo_url,
      "numberOfEmployees": trainers.length,
      "member": trainers.slice(0, 5).map((t: any) => ({
        "@type": "Person",
        "name": names[t.trainer_profiles?.user_id] || 'Trainer',
        "jobTitle": "Padel Trainer"
      }))
    }
  ];

  const trainersHtml = trainers.map((t: any) => {
    const tp = t.trainer_profiles;
    if (!tp) return '';
    const name = names[tp.user_id] || 'Trainer';
    return `<li><a href="${SITE_URL}/${lang}/trainer/${tp.slug || tp.user_id}">${escHtml(name)}</a></li>`;
  }).filter(Boolean).join('');

  const locationsHtml = locations.map((l: any) => {
    if (!l.location) return '';
    return `<li><a href="${SITE_URL}/${lang}/locations/${l.location.slug}">${escHtml(l.location.name)}</a> - ${escHtml(l.location.city)}</li>`;
  }).filter(Boolean).join('');

  const body = `
    ${breadcrumb(breadcrumbItems, lang)}
    <h1>${escHtml(academy.name)}</h1>
    ${academy.is_verified ? '<span class="badge">✓ Verified Academy</span>' : ''}
    <div class="stats">
      <div class="stat"><div class="stat-value">${trainers.length}</div><div class="stat-label">Trainers</div></div>
      <div class="stat"><div class="stat-value">${locations.length}</div><div class="stat-label">Locations</div></div>
    </div>
    ${academy.description ? `<h2>${lang === 'nl' ? 'Over de academie' : 'About the Academy'}</h2><p>${escHtml(academy.description)}</p>` : ''}
    ${trainersHtml ? `<h2>${lang === 'nl' ? 'Onze Trainers' : 'Our Trainers'}</h2><ul>${trainersHtml}</ul>` : ''}
    ${locationsHtml ? `<h2>${lang === 'nl' ? 'Locaties' : 'Locations'}</h2><ul>${locationsHtml}</ul>` : ''}
    ${academy.website_url ? `<p><a href="${academy.website_url}" target="_blank" rel="noopener">${lang === 'nl' ? 'Bezoek website' : 'Visit website'} →</a></p>` : ''}
  `;

  return htmlDoc({ title, description, url: `/academies/${slug}`, lang, image: academy.logo_url || academy.banner_url, structuredData, body });
}

async function renderTrainersDirectory(supabase: any, lang: string): Promise<string> {
  // Get all cities with trainer counts
  const { data: locations } = await supabase
    .from('locations')
    .select('city')
    .eq('is_active', true);

  const cityCounts: Record<string, number> = {};
  locations?.forEach((l: any) => {
    cityCounts[l.city] = (cityCounts[l.city] || 0) + 1;
  });

  const cities = Object.entries(cityCounts)
    .sort((a, b) => b[1] - a[1]);

  const { count: trainerCount } = await supabase
    .from('trainer_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('is_public', true);

  const title = lang === 'nl' 
    ? 'Padel Trainers in Nederland | PadelTrainer.ai'
    : 'Padel Trainers in the Netherlands | PadelTrainer.ai';
  const description = `Browse ${trainerCount || 0}+ certified padel trainers across ${cities.length} cities in the Netherlands. Find the perfect trainer near you.`;

  const citiesHtml = cities.map(([city, count]) => {
    const slug = encodeURIComponent(city.toLowerCase().replace(/\s+/g, '-'));
    return `<div class="card"><a href="${SITE_URL}/${lang}/trainers/${slug}"><h3>${escHtml(city)}</h3><p>${count} padel clubs</p></a></div>`;
  }).join('');

  const body = `
    <h1>${lang === 'nl' ? 'Padel Trainers in Nederland' : 'Padel Trainers in the Netherlands'}</h1>
    <p>${escHtml(description)}</p>
    <h2>${lang === 'nl' ? 'Kies een stad' : 'Choose a City'} (${cities.length})</h2>
    <div class="grid">${citiesHtml}</div>
  `;

  return htmlDoc({ title, description, url: '/trainers', lang, image: `${SITE_URL}/og-trainers.png`, body });
}

async function renderLocationsDirectory(supabase: any, lang: string): Promise<string> {
  const { data: locations } = await supabase
    .from('locations')
    .select('name, city, slug, indoor_courts, outdoor_courts')
    .eq('is_active', true)
    .order('city')
    .limit(100);

  const title = lang === 'nl'
    ? 'Padel Locaties in Nederland | PadelTrainer.ai'
    : 'Padel Locations in the Netherlands | PadelTrainer.ai';
  const description = `Browse padel clubs and locations across the Netherlands. Find courts near you and book lessons with certified trainers.`;

  const locationsHtml = (locations || []).map((l: any) => {
    const courts = [];
    if (l.indoor_courts) courts.push(`${l.indoor_courts} indoor`);
    if (l.outdoor_courts) courts.push(`${l.outdoor_courts} outdoor`);
    return `<div class="card">
      <h3><a href="${SITE_URL}/${lang}/locations/${l.slug}">${escHtml(l.name)}</a></h3>
      <p>${escHtml(l.city)}${courts.length > 0 ? ` · ${courts.join(', ')} courts` : ''}</p>
    </div>`;
  }).join('');

  const body = `
    <h1>${lang === 'nl' ? 'Padel Locaties' : 'Padel Locations'}</h1>
    <p>${escHtml(description)}</p>
    <div class="grid">${locationsHtml}</div>
  `;

  return htmlDoc({ title, description, url: '/locations', lang, image: `${SITE_URL}/og-locations.png`, body });
}

function renderStaticPage(title: string, description: string, lang: string, url: string): string {
  return htmlDoc({ title, description, url, lang, body: `<h1>${escHtml(title)}</h1><p>${escHtml(description)}</p>` });
}

function renderNotFound(lang: string): string {
  return htmlDoc({
    title: 'Page Not Found - PadelTrainer.ai',
    description: 'The page you are looking for does not exist.',
    url: '/404',
    lang,
    body: `<h1>${lang === 'nl' ? 'Pagina niet gevonden' : 'Page Not Found'}</h1><p><a href="${SITE_URL}/${lang}">${lang === 'nl' ? 'Terug naar home' : 'Back to home'}</a></p>`
  });
}

function renderFallback(path: string, lang: string): string {
  return htmlDoc({
    title: 'PadelTrainer.ai',
    description: 'Find and book padel trainers in the Netherlands.',
    url: path,
    lang,
    body: `<h1>PadelTrainer.ai</h1><p>Find and book padel trainers in the Netherlands.</p><p><a href="${SITE_URL}/${lang}">Go to homepage</a></p>`
  });
}

// ─── Sanity CMS Helpers ─────────────────────────────────────────

const SANITY_PROJECT_ID = 'ru3aqhjn';
const SANITY_DATASET = 'production';

async function sanityFetch(query: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ query });
  for (const [k, v] of Object.entries(params)) {
    qs.set(`$${k}`, `"${v}"`);
  }
  const url = `https://${SANITY_PROJECT_ID}.api.sanity.io/v2024-01-01/data/query/${SANITY_DATASET}?${qs.toString()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  return json.result;
}

async function renderSanityArticle(type: string, slug: string, lang: string, basePath: string): Promise<string> {
  // Build a flexible query that works for all content types
  const nameField = type === 'trainer' ? 'name' : 'title';
  const descFields: Record<string, string> = {
    blogPost: 'excerpt',
    rulesArticle: 'intro',
    stroke: 'shortDescription',
    trainer: 'bio',
    videoTip: 'shortSummary',
    learningArticle: 'intro',
  };
  const descField = descFields[type] || 'excerpt';

  const query = `*[_type == "${type}" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
    ${nameField},
    h1,
    ${descField},
    seo,
    "slug": slug.current
  }`;

  const doc = await sanityFetch(query, { slug });
  if (!doc) return renderNotFound(lang);

  const title = doc.seo?.titleTag || doc.h1 || doc[nameField] || slug;
  const description = doc.seo?.metaDescription || doc[descField] || `Learn about ${title} on PadelTrainer.ai`;

  const body = `
    <div class="breadcrumb">
      <a href="${SITE_URL}/${lang}">Home</a><span>›</span>
      <a href="${SITE_URL}/${lang}${basePath}">${escHtml(basePath.replace(/^\//, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))}</a><span>›</span>
      <strong>${escHtml(title)}</strong>
    </div>
    <h1>${escHtml(title)}</h1>
    <p>${escHtml(typeof description === 'string' ? description : '')}</p>
  `;

  return htmlDoc({ title: `${title} | PadelTrainer.ai`, description: typeof description === 'string' ? description : '', url: `${basePath}/${slug}`, lang, body });
}

async function renderBlogListing(lang: string): Promise<string> {
  const query = `*[_type == "blogPost" && !(_id in path("drafts.**"))] | order(datePublished desc) [0...10] {
    title, "slug": slug.current, excerpt, category, datePublished
  }`;
  const posts = await sanityFetch(query) || [];

  const title = 'Padel Blog — Tips, Guides & Training Advice';
  const description = 'Read the latest padel tips, training guides, and expert advice. Improve your game with insights from top coaches and players.';

  const postsHtml = posts.map((p: any) => `
    <div class="card">
      <h3><a href="${SITE_URL}/${lang}/blog/${p.slug}">${escHtml(p.title)}</a></h3>
      ${p.category ? `<span class="badge">${escHtml(p.category)}</span>` : ''}
      ${p.excerpt ? `<p>${escHtml(p.excerpt.slice(0, 120))}</p>` : ''}
    </div>
  `).join('');

  const body = `
    <h1>Padel Blog</h1>
    <p>${escHtml(description)}</p>
    <div class="grid">${postsHtml}</div>
  `;

  return htmlDoc({ title, description, url: '/blog', lang, body });
}
