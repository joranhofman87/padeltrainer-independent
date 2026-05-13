/**
 * render-page: Zero-DB-cost pre-rendering for SEO bots.
 * 
 * This function serves static HTML with appropriate meta tags based on URL patterns.
 * It does NOT query the database at all — all content is derived from the URL path.
 * 
 * Auth: Requires Supabase anon key in Authorization header (sent by Cloudflare Worker).
 * Direct bot hits without the key are rejected with 401.
 */

import {
  cityFaqs, trainerFaqs, clubFaqs, academyFaqs, regionFaqs,
  renderFaqHtml, renderPopularCitiesHtml, renderPopularRegionsHtml,
  faqPageSchema, labels,
  renderLastUpdatedHtml, renderTldrHtml, speakableSchema,
  aggregateRatingSchema, reviewSchemas, localBusinessSchema, courseSchema,
  renderNearbyCitiesHtml, renderTopTrainersHtml, renderTopClubsHtml,
  renderTrainersAtClubHtml, renderRecentReviewsHtml, renderUpcomingCyclesHtml,
  renderProvinceCitiesHtml,
} from './seo-content.ts';
import {
  fetchCityFacts, fetchTrainerFacts, fetchClubFacts, fetchAcademyFacts,
  fetchProvinceFacts, getProvinceForCity, getNearbyCities, getProvinceBySlug,
} from './db-facts.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';
const SUPPORTED_LANGS = ['en', 'nl', 'es', 'de', 'fr', 'it'];
const OG_LOCALE_MAP: Record<string, string> = {
  en: 'en_US', nl: 'nl_NL', es: 'es_ES', de: 'de_DE', fr: 'fr_FR', it: 'it_IT',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const path = url.searchParams.get('path') || '/';

    // Strip language prefix
    const langMatch = path.match(/^\/(en|nl|es|de|fr|it)/);
    const lang = langMatch ? langMatch[1] : 'en';
    const cleanPath = path.replace(/^\/(en|nl|es|de|fr|it)/, '') || '/';

    const { html, status } = await renderPath(cleanPath, lang);

    return new Response(html, {
      status,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': status === 404 ? 'public, max-age=300' : 'public, max-age=3600',
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

async function renderPath(cleanPath: string, lang: string): Promise<{ html: string; status: number }> {
  const html = await renderPathInner(cleanPath, lang);
  // Sentinel emitted only by the fallback branch — return 404 + noindex caching.
  if (html.includes('<!-- render-page:notfound -->')) {
    return { html, status: 404 };
  }
  return { html, status: 200 };
}

async function renderPathInner(cleanPath: string, lang: string): Promise<string> {
  // Homepage
  if (cleanPath === '/' || cleanPath === '') {
    const titles: Record<string, string> = {
      nl: 'PadelTrainer.ai - Planning, Boekingen & Betalingen voor Padel Trainers',
      es: 'PadelTrainer.ai - Reservas y Pagos para Entrenadores de Pádel',
      de: 'PadelTrainer.ai - Buchungen & Zahlungen für Padel Trainer',
      fr: 'PadelTrainer.ai - Réservations et Paiements pour Entraîneurs de Padel',
      it: 'PadelTrainer.ai - Prenotazioni e Pagamenti per Istruttori di Padel',
    };
    const descs: Record<string, string> = {
      nl: 'Beheer je padel coaching vanuit één plek. Online boekingen, veilige betalingen en agenda synchronisatie.',
      es: 'Gestiona tu negocio de pádel desde un solo lugar. Reservas en línea, pagos seguros y sincronización de calendario.',
      de: 'Verwalte dein Padel-Coaching an einem Ort. Online-Buchungen, sichere Zahlungen und Kalender-Sync.',
      fr: 'Gérez votre coaching padel depuis un seul endroit. Réservations en ligne, paiements sécurisés et synchronisation du calendrier.',
      it: 'Gestisci la tua attività di padel da un unico posto. Prenotazioni online, pagamenti sicuri e sincronizzazione del calendario.',
    };
    const h1s: Record<string, string> = {
      nl: 'Vind Jouw Perfecte Padel Trainer',
      es: 'Encuentra Tu Entrenador de Pádel Perfecto',
      de: 'Finde Deinen Perfekten Padel Trainer',
      fr: 'Trouvez Votre Entraîneur de Padel Idéal',
      it: 'Trova il Tuo Istruttore di Padel Ideale',
    };
    const subs: Record<string, string> = {
      nl: 'Ontdek gecertificeerde padel trainers bij jou in de buurt.',
      es: 'Descubre entrenadores de pádel certificados cerca de ti.',
      de: 'Entdecke zertifizierte Padel Trainer in deiner Nähe.',
      fr: 'Découvrez des entraîneurs de padel certifiés près de chez vous.',
      it: 'Scopri istruttori di padel certificati vicino a te.',
    };
    const defaultTitle = 'PadelTrainer.ai - Scheduling, Bookings & Payments for Padel Trainers';
    const defaultDesc = 'Run your padel coaching business from one place. Online booking, secure payments, and calendar sync.';
    return page(
      titles[lang] || defaultTitle,
      descs[lang] || defaultDesc,
      '/', lang,
      `<h1>${h1s[lang] || 'Find Your Perfect Padel Trainer'}</h1>
       <p>${subs[lang] || 'Discover certified padel trainers near you.'}</p>`,
      [websiteSchema(), organizationSchema()]
    );
  }

  // Trainer profile: /trainer/:slug
  const trainerMatch = cleanPath.match(/^\/trainer\/([^/]+)$/);
  if (trainerMatch) {
    const slug = trainerMatch[1];
    const L = labels(lang);
    const facts = await fetchTrainerFacts(slug).catch(() => null);
    const displayName = facts?.name || slugToDisplay(slug);
    const canonicalUrl = `${SITE_URL}/${lang}/trainer/${slug}`;

    const personSchema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "Person",
      "name": displayName,
      "jobTitle": "Padel Trainer",
      "url": canonicalUrl,
    };
    if (facts?.bio) personSchema.description = facts.bio.slice(0, 500);
    if (facts?.city) personSchema.address = { "@type": "PostalAddress", addressLocality: facts.city };
    if (facts?.hourlyRate) {
      personSchema.makesOffer = {
        "@type": "Offer",
        priceCurrency: "EUR",
        price: facts.hourlyRate,
        itemOffered: { "@type": "Service", name: "Padel coaching session" },
      };
    }
    const ar = facts ? aggregateRatingSchema(facts.avgRating, facts.reviewCount) : null;
    if (ar) personSchema.aggregateRating = ar;

    const tldrParts: string[] = [];
    if (facts?.city) tldrParts.push(`Based in ${facts.city}`);
    if (facts?.experienceYears) tldrParts.push(`${facts.experienceYears}+ years coaching`);
    if (facts?.hourlyRate) tldrParts.push(`From €${facts.hourlyRate}/hour`);
    if (facts?.avgRating && facts.reviewCount > 0) tldrParts.push(`${facts.avgRating}★ (${facts.reviewCount} reviews)`);
    if (facts?.specializations?.length) tldrParts.push(`Specializes in ${facts.specializations.slice(0, 3).join(', ')}`);
    const tldr = tldrParts.length ? tldrParts.join(' · ') + '.' : `Padel trainer on PadelTrainer.ai.`;

    const faqs = trainerFaqs(displayName, lang);
    const description = facts?.bio
      ? facts.bio.slice(0, 155)
      : `Book padel lessons with ${displayName}${facts?.city ? ` in ${facts.city}` : ''}. ${facts?.hourlyRate ? `From €${facts.hourlyRate}/hr. ` : ''}View profile, experience and reviews.`;

    const reviewSds = facts ? reviewSchemas(facts.recentReviews, displayName) : [];
    const sd: object[] = [
      personSchema,
      breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: L.trainers, path: '/trainers' },
        { name: displayName },
      ]),
      faqPageSchema(faqs),
      speakableSchema(canonicalUrl),
      ...reviewSds,
    ];

    const citySlugForNearby = facts?.city ? facts.city.toLowerCase().replace(/\s+/g, '-') : null;
    const province = citySlugForNearby ? getProvinceForCity(citySlugForNearby) : undefined;
    const nearby = citySlugForNearby ? getNearbyCities(citySlugForNearby) : [];

    return page(
      `${displayName} — Padel Trainer${facts?.city ? ` in ${facts.city}` : ''} | PadelTrainer.ai`,
      description,
      `/trainer/${slug}`, lang,
      `<h1>${esc(displayName)}</h1>
       ${renderTldrHtml(tldr, lang)}
       ${renderLastUpdatedHtml(facts?.lastUpdated || null, lang)}
       ${facts?.bio ? `<p>${esc(facts.bio.slice(0, 600))}</p>` : ''}
       ${facts?.primaryClub ? `<p><strong>${esc(L.trainersAtClub)}:</strong> <a href="${SITE_URL}/${lang}/locations/${facts.primaryClub.slug}">${esc(facts.primaryClub.name)}</a> — ${esc(facts.primaryClub.city)}</p>` : ''}
       ${facts ? renderRecentReviewsHtml(facts.recentReviews, lang) : ''}
       ${renderFaqHtml(faqs, lang)}
       ${province ? renderNearbyCitiesHtml(province.name, nearby.map(c => ({ slug: c, name: slugToDisplay(c) })), lang) : ''}
       ${renderPopularCitiesHtml(lang)}`,
      sd
    );
  }

  // City trainers: /trainers/:city
  const cityTrainersMatch = cleanPath.match(/^\/trainers\/([^/]+)$/);
  if (cityTrainersMatch && cityTrainersMatch[1] !== 'region') {
    const citySlug = cityTrainersMatch[1];
    const city = slugToDisplay(citySlug);
    const L = labels(lang);
    const facts = await fetchCityFacts(citySlug).catch(() => null);
    const province = getProvinceForCity(citySlug);
    const nearby = getNearbyCities(citySlug);

    const tldrParts: string[] = [];
    if (facts?.trainerCount) tldrParts.push(`${facts.trainerCount} certified trainers`);
    if (facts?.locationCount) tldrParts.push(`${facts.locationCount} padel clubs`);
    if (facts?.minRate && facts?.maxRate) tldrParts.push(`Lessons €${facts.minRate}–€${facts.maxRate}/hr (avg €${facts.avgRate})`);
    const tldr = tldrParts.length
      ? `${tldrParts.join(' · ')}.`
      : `Find and book certified padel trainers in ${city}.`;

    const faqs = cityFaqs(city, lang);
    const canonicalUrl = `${SITE_URL}/${lang}/trainers/${citySlug}`;
    const description = facts?.trainerCount
      ? `${facts.trainerCount} certified padel trainers in ${city}${facts.minRate && facts.maxRate ? ` from €${facts.minRate}–€${facts.maxRate}/hr` : ''}. Compare rates, read verified reviews, and book your first lesson.`
      : `Find certified padel trainers in ${city}. Compare rates, read reviews, and book your first lesson today.`;

    return page(
      `Padel Trainers in ${city} | ${facts?.trainerCount ? `${facts.trainerCount} Coaches` : 'Find & Book Lessons'}`,
      description,
      `/trainers/${citySlug}`, lang,
      `<h1>${esc(L.topTrainers)} ${esc(city)}</h1>
       ${renderTldrHtml(tldr, lang)}
       ${renderLastUpdatedHtml(facts?.lastUpdated || null, lang)}
       ${facts ? renderTopTrainersHtml(city, facts.topTrainers, lang) : ''}
       ${facts ? renderTopClubsHtml(city, facts.topClubs, lang) : ''}
       ${renderFaqHtml(faqs, lang)}
       ${province ? renderNearbyCitiesHtml(province.name, nearby.map(c => ({ slug: c, name: slugToDisplay(c) })), lang) : ''}
       ${renderPopularCitiesHtml(lang, citySlug)}
       ${renderPopularRegionsHtml(lang)}`,
      [breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: L.trainers, path: '/trainers' },
        { name: city },
      ]), faqPageSchema(faqs), speakableSchema(canonicalUrl)]
    );
  }

  // Trainers directory
  if (cleanPath === '/trainers') {
    return page(
      'Find Padel Trainers | PadelTrainer.ai',
      'Browse all certified padel trainers. Filter by location, level, and specialization.',
      '/trainers', lang,
      `<h1>Find Padel Trainers</h1><p>Browse all certified padel trainers. Filter by location, level, and specialization.</p>`,
      [breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: 'Trainers' },
      ])]
    );
  }

  // Padel city: /padel/:city
  const padelCityMatch = cleanPath.match(/^\/padel\/([^/]+)$/);
  if (padelCityMatch) {
    const citySlug = padelCityMatch[1];
    const city = slugToDisplay(citySlug);
    const L = labels(lang);

    let seoTitle = `Padel in ${city} — Courts, Clubs & Coaches`;
    let seoDesc = `Find padel clubs and coaches in ${city}. Compare courts, book lessons and start playing padel today.`;

    try {
      const { createClient: createSanityClient } = await import("npm:@sanity/client@6");
      const sanityCli = createSanityClient({
        projectId: 'ru3aqhjn',
        dataset: 'production',
        apiVersion: '2024-01-01',
        useCdn: true,
      });
      const cityPage = await sanityCli.fetch(
        `*[_type == "cityPage" && citySlug == $slug && language == $lang && !(_id in path("drafts.**"))][0]{ "titleTag": seo.titleTag, "metaDescription": seo.metaDescription, cityName, province }`,
        { slug: citySlug, lang }
      );
      if (cityPage?.titleTag) seoTitle = cityPage.titleTag;
      if (cityPage?.metaDescription) seoDesc = cityPage.metaDescription;
    } catch {
      // Sanity fetch failed — use defaults
    }

    const facts = await fetchCityFacts(citySlug).catch(() => null);
    const province = getProvinceForCity(citySlug);
    const nearby = getNearbyCities(citySlug);
    const tldrParts: string[] = [];
    if (facts?.locationCount) tldrParts.push(`${facts.locationCount} padel clubs`);
    if (facts?.trainerCount) tldrParts.push(`${facts.trainerCount} certified coaches`);
    if (facts?.minRate && facts?.maxRate) tldrParts.push(`Lessons €${facts.minRate}–€${facts.maxRate}/hr`);
    const tldr = tldrParts.length ? `${tldrParts.join(' · ')}.` : `Discover padel in ${city}.`;
    const canonicalUrl = `${SITE_URL}/${lang}/padel/${citySlug}`;

    const faqs = cityFaqs(city, lang);
    return page(
      seoTitle,
      seoDesc,
      `/padel/${citySlug}`, lang,
      `<h1>Padel in ${esc(city)}</h1>
       ${renderTldrHtml(tldr, lang)}
       ${renderLastUpdatedHtml(facts?.lastUpdated || null, lang)}
       ${facts ? renderTopClubsHtml(city, facts.topClubs, lang) : ''}
       ${facts ? renderTopTrainersHtml(city, facts.topTrainers, lang) : ''}
       ${renderFaqHtml(faqs, lang)}
       ${province ? renderNearbyCitiesHtml(province.name, nearby.map(c => ({ slug: c, name: slugToDisplay(c) })), lang) : ''}
       ${renderPopularCitiesHtml(lang, citySlug)}`,
      [breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: city },
      ]), faqPageSchema(faqs), speakableSchema(canonicalUrl)]
    );
  }

  // Location: /locations/:slug
  const locationMatch = cleanPath.match(/^\/locations\/([^/]+)$/);
  if (locationMatch) {
    const locSlug = locationMatch[1];
    const L = labels(lang);
    const facts = await fetchClubFacts(locSlug).catch(() => null);
    const displayName = facts?.name || slugToDisplay(locSlug);
    const canonicalUrl = `${SITE_URL}/${lang}/locations/${locSlug}`;

    const placeSchema = facts
      ? localBusinessSchema({
          url: canonicalUrl,
          name: facts.name,
          city: facts.city,
          street: facts.street,
          postalCode: facts.postalCode,
          country: facts.country,
          latitude: facts.latitude,
          longitude: facts.longitude,
          reviewAvg: facts.reviewStats.avg,
          reviewCount: facts.reviewStats.count,
        })
      : { "@context": "https://schema.org", "@type": "SportsActivityLocation", name: displayName, url: canonicalUrl, sport: "Padel" };

    const tldrParts: string[] = [];
    if (facts?.totalCourts) tldrParts.push(`${facts.totalCourts} courts${facts.indoorCourts ? ` (${facts.indoorCourts} indoor` : ''}${facts.outdoorCourts ? `${facts.indoorCourts ? ', ' : ' ('}${facts.outdoorCourts} outdoor)` : facts.indoorCourts ? ')' : ''}`);
    if (facts?.googleRating) tldrParts.push(`${facts.googleRating}★ on Google${facts.googleReviewCount ? ` (${facts.googleReviewCount} reviews)` : ''}`);
    if (facts?.trainersAtClub.length) tldrParts.push(`${facts.trainersAtClub.length} resident coaches`);
    const tldr = tldrParts.length ? `${tldrParts.join(' · ')}.` : `Padel club ${displayName}.`;

    const faqs = clubFaqs(displayName, lang);
    const description = facts
      ? `${displayName} in ${facts.city}: ${facts.totalCourts || 'multiple'} padel courts${facts.googleRating ? `, rated ${facts.googleRating}★ on Google` : ''}. View trainers and book a lesson.`
      : `Discover ${displayName}. View courts, trainers, and book padel lessons at this club.`;

    return page(
      `${displayName} — Padel Club${facts ? ` in ${facts.city}` : ''} | PadelTrainer.ai`,
      description,
      `/locations/${locSlug}`, lang,
      `<h1>${esc(displayName)}</h1>
       ${renderTldrHtml(tldr, lang)}
       ${renderLastUpdatedHtml(facts?.lastUpdated || null, lang)}
       ${facts?.street ? `<p><strong>Address:</strong> ${esc(facts.street)}${facts.postalCode ? `, ${esc(facts.postalCode)}` : ''} ${esc(facts.city)}</p>` : ''}
       ${facts ? renderTrainersAtClubHtml(displayName, facts.trainersAtClub, lang) : ''}
       ${renderFaqHtml(faqs, lang)}
       ${facts ? `<p><a href="${SITE_URL}/${lang}/trainers/${facts.city.toLowerCase().replace(/\s+/g, '-')}">More trainers in ${esc(facts.city)}</a></p>` : ''}
       ${renderPopularCitiesHtml(lang)}`,
      [placeSchema, breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: L.locations, path: '/locations' },
        { name: displayName },
      ]), faqPageSchema(faqs), speakableSchema(canonicalUrl)]
    );
  }

  // Locations directory
  if (cleanPath === '/locations') {
    return page(
      'Padel Locations | PadelTrainer.ai',
      'Browse all padel clubs and locations. Find courts near you.',
      '/locations', lang,
      `<h1>Padel Locations</h1><p>Browse all padel clubs and locations. Find courts near you.</p>`,
      [breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: 'Locations' },
      ])]
    );
  }

  // Academy: /academies/:slug
  const academyMatch = cleanPath.match(/^\/academies\/([^/]+)$/);
  if (academyMatch) {
    const acSlug = academyMatch[1];
    const L = labels(lang);
    const facts = await fetchAcademyFacts(acSlug).catch(() => null);
    const displayName = facts?.name || slugToDisplay(acSlug);
    const canonicalUrl = `${SITE_URL}/${lang}/academies/${acSlug}`;

    const orgSchema: Record<string, unknown> = {
      "@context": "https://schema.org",
      "@type": "EducationalOrganization",
      "name": displayName,
      "url": canonicalUrl,
      "sport": "Padel",
    };
    if (facts?.description) orgSchema.description = facts.description.slice(0, 500);
    if (facts?.country) orgSchema.address = { "@type": "PostalAddress", addressCountry: facts.country };
    const sameAs = facts ? [facts.websiteUrl, facts.social.instagram, facts.social.facebook, facts.social.linkedin].filter(Boolean) : [];
    if (sameAs.length) orgSchema.sameAs = sameAs;

    const courseSds = (facts?.upcomingCycles || []).slice(0, 5).map(c => courseSchema({
      url: canonicalUrl,
      name: c.name,
      providerName: displayName,
      providerUrl: canonicalUrl,
      startDate: c.startDate,
      endDate: c.endDate,
      price: c.price,
      currency: c.currency,
    }));

    const tldrParts: string[] = [];
    if (facts?.trainerCount) tldrParts.push(`${facts.trainerCount} trainers`);
    if (facts?.activeCycleCount) tldrParts.push(`${facts.activeCycleCount} upcoming programs`);
    if (facts?.country) tldrParts.push(facts.country);
    const tldr = tldrParts.length ? `${tldrParts.join(' · ')}.` : `Padel academy ${displayName}.`;

    const faqs = academyFaqs(displayName, lang);
    const description = facts?.description
      ? facts.description.slice(0, 155)
      : `Discover ${displayName}. View trainers, programs, and book padel lessons.`;

    return page(
      `${displayName} — Padel Academy | PadelTrainer.ai`,
      description,
      `/academies/${acSlug}`, lang,
      `<h1>${esc(displayName)}</h1>
       ${renderTldrHtml(tldr, lang)}
       ${renderLastUpdatedHtml(facts?.lastUpdated || null, lang)}
       ${facts?.description ? `<p>${esc(facts.description.slice(0, 600))}</p>` : ''}
       ${facts ? renderUpcomingCyclesHtml(facts.upcomingCycles, lang) : ''}
       ${renderFaqHtml(faqs, lang)}
       ${renderPopularCitiesHtml(lang)}`,
      [orgSchema, breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: L.academies, path: '/academies' },
        { name: displayName },
      ]), faqPageSchema(faqs), speakableSchema(canonicalUrl), ...courseSds]
    );
  }

  // Blog listing
  if (cleanPath === '/blog') {
    const blogMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Padel Blog — Tips, Nieuws & Trainingsadvies | PadelTrainer.ai', desc: 'Lees de nieuwste padel artikelen, trainingstips, wedstrijdstrategieën en het laatste nieuws.' },
      es: { title: 'Blog de Pádel — Consejos, Noticias y Entrenamiento | PadelTrainer.ai', desc: 'Lee los últimos artículos de pádel, consejos de entrenamiento y estrategias de partido.' },
      de: { title: 'Padel Blog — Tipps, News & Trainingsratgeber | PadelTrainer.ai', desc: 'Lesen Sie die neuesten Padel-Artikel, Trainingstipps und Matchstrategien.' },
      fr: { title: 'Blog Padel — Conseils, Actualités & Entraînement | PadelTrainer.ai', desc: 'Lisez les derniers articles padel, conseils d\'entraînement et stratégies de match.' },
    };
    const m = blogMeta[lang] || { title: 'Padel Blog — Tips, News & Training Advice | PadelTrainer.ai', desc: 'Read the latest padel articles, training tips, match strategies, and industry news.' };
    return page(m.title, m.desc, '/blog', lang, `<h1>${esc(m.title.split('|')[0].trim())}</h1>`,
      [breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: 'Blog' },
      ])]
    );
  }

  // Blog article: /blog/:slug
  const blogMatch = cleanPath.match(/^\/blog\/([^/]+)$/);
  if (blogMatch) {
    const slug = blogMatch[1];
    const title = slugToDisplay(slug);
    const readVerb: Record<string, string> = { nl: 'Lees', es: 'Lee', de: 'Lesen', fr: 'Lire' };
    const verb = readVerb[lang] || 'Read';
    const articleSchema = {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": title,
      "url": `${SITE_URL}/${lang}/blog/${slug}`,
      "author": { "@type": "Organization", "name": "PadelTrainer.ai" },
      "publisher": {
        "@type": "Organization",
        "name": "PadelTrainer.ai",
        "logo": { "@type": "ImageObject", "url": `${SITE_URL}/favicon.png` },
      },
      "mainEntityOfPage": { "@type": "WebPage", "@id": `${SITE_URL}/${lang}/blog/${slug}` },
    };
    return page(
      `${title} | PadelTrainer.ai Blog`,
      `${verb} "${title}" — PadelTrainer.ai`,
      `/blog/${slug}`, lang,
      `<h1>${esc(title)}</h1>`,
      [articleSchema, breadcrumbSchema(lang, [
        { name: homeName(lang), path: '' },
        { name: 'Blog', path: '/blog' },
        { name: title },
      ])]
    );
  }

  // Learn
  if (cleanPath === '/learn') {
    const learnMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Leer Padel — Gidsen, Tactieken & Oefeningen', desc: 'Gidsen, tactieken, oefeningen en alles wat je nodig hebt om je padel te verbeteren.' },
      es: { title: 'Aprende Pádel — Guías, Tácticas y Ejercicios', desc: 'Guías, tácticas, ejercicios y todo lo que necesitas para mejorar tu juego de pádel.' },
      de: { title: 'Padel Lernen — Anleitungen, Taktiken & Übungen', desc: 'Anleitungen, Taktiken, Übungen und alles, was du brauchst, um dein Padel-Spiel zu verbessern.' },
      fr: { title: 'Apprendre le Padel — Guides, Tactiques & Exercices', desc: 'Guides, tactiques, exercices et tout ce dont vous avez besoin pour améliorer votre jeu de padel.' },
    };
    const lm = learnMeta[lang] || { title: 'Learn Padel — Guides, Tactics & Drills', desc: 'Guides, tactics, drills, and everything you need to improve your padel game.' };
    return page(lm.title, lm.desc, '/learn', lang, `<h1>${esc(lm.title.split('—')[0].trim())}</h1>`);
  }
  const learnMatch = cleanPath.match(/^\/learn\/([^/]+)$/);
  if (learnMatch) {
    const title = slugToDisplay(learnMatch[1]);
    const learnVerb: Record<string, string> = { nl: 'Leer alles over', es: 'Aprende sobre', de: 'Erfahre mehr über', fr: 'Découvrez' };
    const verb = learnVerb[lang] || 'Learn about';
    return page(`${title} | ${lang === 'nl' ? 'Leer Padel' : lang === 'es' ? 'Aprende Pádel' : lang === 'de' ? 'Padel Lernen' : lang === 'fr' ? 'Apprendre le Padel' : 'Learn Padel'}`, `${verb} ${title.toLowerCase()}.`, `/learn/${learnMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Padel rules
  if (cleanPath === '/padel-rules') {
    const rulesMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Padel Regels — Complete Gids', desc: 'Leer alle officiële padel regels, scoring, serveren en wedstrijdspel.' },
      es: { title: 'Reglas del Pádel — Guía Completa', desc: 'Aprende todas las reglas oficiales del pádel, puntuación, servicio y juego.' },
      de: { title: 'Padel Regeln — Vollständiger Leitfaden', desc: 'Lernen Sie alle offiziellen Padel-Regeln, Punktzählung, Aufschlag und Spielverlauf.' },
      fr: { title: 'Règles du Padel — Guide Complet', desc: 'Apprenez toutes les règles officielles du padel, le comptage des points, le service et le jeu.' },
    };
    const rm = rulesMeta[lang] || { title: 'Padel Rules — Complete Guide', desc: 'Learn all the official padel rules, scoring, serving, and match play.' };
    return page(rm.title, rm.desc, '/padel-rules', lang, `<h1>${esc(rm.title.split('—')[0].trim())}</h1>`);
  }
  const rulesMatch = cleanPath.match(/^\/padel-rules\/([^/]+)$/);
  if (rulesMatch) {
    const title = slugToDisplay(rulesMatch[1]);
    return page(`${title} | ${lang === 'nl' ? 'Padel Regels' : lang === 'es' ? 'Reglas del Pádel' : lang === 'de' ? 'Padel Regeln' : lang === 'fr' ? 'Règles du Padel' : 'Padel Rules'}`, title, `/padel-rules/${rulesMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Padel strokes
  if (cleanPath === '/padel-strokes') {
    const strokesMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Padel Slagen — Beheers Elke Slag', desc: 'Ontdek alle padel slagen en technieken.' },
      es: { title: 'Golpes de Pádel — Domina Cada Golpe', desc: 'Explora todos los golpes y técnicas de pádel.' },
      de: { title: 'Padel Schläge — Meistere Jeden Schlag', desc: 'Entdecken Sie alle Padel-Schläge und -Techniken.' },
      fr: { title: 'Coups de Padel — Maîtrisez Chaque Coup', desc: 'Explorez tous les coups et techniques de padel.' },
    };
    const sm = strokesMeta[lang] || { title: 'Padel Strokes — Master Every Shot', desc: 'Explore all padel strokes and techniques.' };
    return page(sm.title, sm.desc, '/padel-strokes', lang, `<h1>${esc(sm.title.split('—')[0].trim())}</h1>`);
  }
  const strokesMatch = cleanPath.match(/^\/padel-strokes\/([^/]+)$/);
  if (strokesMatch) {
    const title = slugToDisplay(strokesMatch[1]);
    return page(`${title} | ${lang === 'nl' ? 'Padel Slagen' : lang === 'es' ? 'Golpes de Pádel' : lang === 'de' ? 'Padel Schläge' : lang === 'fr' ? 'Coups de Padel' : 'Padel Strokes'}`, title, `/padel-strokes/${strokesMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Padel coaches
  if (cleanPath === '/padel-coaches') {
    const coachesMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Padel Coaches — Tips van Experts', desc: 'Ontdek padel coaches en hun trainingstips.' },
      es: { title: 'Entrenadores de Pádel — Consejos de Expertos', desc: 'Descubre entrenadores de pádel y sus consejos de entrenamiento.' },
      de: { title: 'Padel Coaches — Expertentipps', desc: 'Entdecken Sie Padel-Coaches und ihre Trainingstipps.' },
      fr: { title: 'Coaches de Padel — Conseils d\'Experts', desc: 'Découvrez des coaches de padel et leurs conseils d\'entraînement.' },
    };
    const cm = coachesMeta[lang] || { title: 'Padel Coaches — Expert Coaching Tips', desc: 'Discover expert padel coaches and their training tips.' };
    return page(cm.title, cm.desc, '/padel-coaches', lang, `<h1>${esc(cm.title.split('—')[0].trim())}</h1>`);
  }
  const coachesMatch = cleanPath.match(/^\/padel-coaches\/([^/]+)$/);
  if (coachesMatch) {
    const title = slugToDisplay(coachesMatch[1]);
    const learnFrom: Record<string, string> = { nl: 'Leer van', es: 'Aprende de', de: 'Lerne von', fr: 'Apprenez de' };
    const verb = learnFrom[lang] || 'Learn from';
    return page(`${title} | ${lang === 'nl' ? 'Padel Coaches' : lang === 'es' ? 'Entrenadores de Pádel' : lang === 'de' ? 'Padel Coaches' : lang === 'fr' ? 'Coaches de Padel' : 'Padel Coaches'}`, `${verb} ${title}.`, `/padel-coaches/${coachesMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Video tips
  if (cleanPath === '/video-tips') {
    const videoMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Padel Video Tips & Tutorials', desc: 'Bekijk padel coaching video\'s van experts.' },
      es: { title: 'Consejos en Vídeo de Pádel & Tutoriales', desc: 'Mira vídeos de entrenamiento de pádel de expertos.' },
      de: { title: 'Padel Video-Tipps & Tutorials', desc: 'Sehen Sie sich Padel-Coaching-Videos von Experten an.' },
      fr: { title: 'Conseils Vidéo Padel & Tutoriels', desc: 'Regardez des vidéos de coaching padel par des experts.' },
    };
    const vm = videoMeta[lang] || { title: 'Padel Video Tips & Tutorials', desc: 'Watch expert padel coaching videos.' };
    return page(vm.title, vm.desc, '/video-tips', lang, `<h1>${esc(vm.title.split('&')[0].trim())}</h1>`);
  }
  const videoMatch = cleanPath.match(/^\/video-tips\/([^/]+)$/);
  if (videoMatch) {
    const title = slugToDisplay(videoMatch[1]);
    const watchVerb: Record<string, string> = { nl: 'Bekijk', es: 'Mira', de: 'Ansehen', fr: 'Regardez' };
    const verb = watchVerb[lang] || 'Watch';
    return page(`${title} | ${lang === 'nl' ? 'Video Tips' : lang === 'es' ? 'Consejos en Vídeo' : lang === 'de' ? 'Video-Tipps' : lang === 'fr' ? 'Conseils Vidéo' : 'Video Tips'}`, `${verb}: ${title}`, `/video-tips/${videoMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Topics
  if (cleanPath === '/topics') {
    const topicsMeta: Record<string, { title: string; desc: string; h1: string }> = {
      nl: { title: 'Padel Onderwerpen | PadelTrainer.ai', desc: 'Ontdek padel onderwerpen van beginner tot gevorderd.', h1: 'Padel Onderwerpen' },
      es: { title: 'Temas de Pádel | PadelTrainer.ai', desc: 'Explora temas de pádel desde principiante hasta avanzado.', h1: 'Temas de Pádel' },
      de: { title: 'Padel Themen | PadelTrainer.ai', desc: 'Entdecke Padel-Themen von Anfänger bis Fortgeschrittene.', h1: 'Padel Themen' },
      fr: { title: 'Sujets de Padel | PadelTrainer.ai', desc: 'Explorez les sujets de padel du débutant au confirmé.', h1: 'Sujets de Padel' },
    };
    const tm = topicsMeta[lang] || { title: 'Padel Topics | PadelTrainer.ai', desc: 'Explore padel topics from beginner to advanced.', h1: 'Padel Topics' };
    return page(tm.title, tm.desc, '/topics', lang, `<h1>${esc(tm.h1)}</h1>`);
  }
  const topicsMatch = cleanPath.match(/^\/topics\/([^/]+)$/);
  if (topicsMatch) {
    const title = slugToDisplay(topicsMatch[1]);
    const topicDetailDesc: Record<string, string> = {
      nl: `Alles over ${title.toLowerCase()} in padel.`,
      es: `Todo sobre ${title.toLowerCase()} en pádel.`,
      de: `Alles über ${title.toLowerCase()} im Padel.`,
      fr: `Tout sur ${title.toLowerCase()} au padel.`,
    };
    const desc = topicDetailDesc[lang] || `Everything about ${title.toLowerCase()} in padel.`;
    const topicLabel: Record<string, string> = { nl: 'Padel Onderwerpen', es: 'Temas de Pádel', de: 'Padel Themen', fr: 'Sujets de Padel' };
    return page(`${title} | ${topicLabel[lang] || 'Padel Topics'}`, desc, `/topics/${topicsMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Gear / Rackets
  if (cleanPath === '/gear/rackets') {
    const racketsMeta: Record<string, { title: string; desc: string }> = {
      nl: { title: 'Padel Rackets — Vind Jouw Perfecte Racket', desc: 'Vergelijk padel rackets. Vind het perfecte racket voor jouw speelstijl.' },
      es: { title: 'Palas de Pádel — Encuentra Tu Pala Perfecta', desc: 'Compara palas de pádel. Encuentra la pala perfecta para tu estilo de juego.' },
      de: { title: 'Padel Schläger — Finde Deinen Perfekten Schläger', desc: 'Vergleiche Padel-Schläger und finde den perfekten für deinen Spielstil.' },
      fr: { title: 'Raquettes de Padel — Trouvez Votre Raquette Parfaite', desc: 'Comparez les raquettes de padel et trouvez celle qui correspond à votre style de jeu.' },
    };
    const rm = racketsMeta[lang] || { title: 'Padel Rackets — Find Your Perfect Racket', desc: 'Browse padel rackets. Compare specs and find the perfect racket.' };
    return page(rm.title, rm.desc, '/gear/rackets', lang, `<h1>${esc(rm.title.split('—')[0].trim())}</h1>`);
  }
  const racketMatch = cleanPath.match(/^\/gear\/rackets\/([^/]+)$/);
  if (racketMatch) {
    const title = slugToDisplay(racketMatch[1]);
    const readVerb: Record<string, string> = { nl: 'Lees de volledige review van de', es: 'Lee la reseña completa de la', de: 'Lesen Sie die vollständige Bewertung des', fr: 'Lisez l\'avis complet de la' };
    const verb = readVerb[lang] || 'Read the full review of the';
    return page(`${title} | ${lang === 'nl' ? 'Padel Racket Review' : lang === 'es' ? 'Reseña de Pala' : lang === 'de' ? 'Padel Schläger Bewertung' : lang === 'fr' ? 'Avis Raquette Padel' : 'Padel Racket Review'}`, `${verb} ${title}.`, `/gear/rackets/${racketMatch[1]}`, lang, `<h1>${esc(title)}</h1>`);
  }

  // Registration routes (no DB needed — generic meta)
  if (/^\/(academies|clubs)\/[^/]+\/register\/[^/]+$/.test(cleanPath) || /^\/register\/[^/]+$/.test(cleanPath)) {
    const regMeta: Record<string, { title: string; desc: string; h1: string; p: string }> = {
      nl: { title: 'Inschrijven voor Padeltraining | PadelTrainer.ai', desc: 'Schrijf je in voor padel trainingen. Boek je plek in een groeps- of privéles.', h1: 'Inschrijven voor Padeltraining', p: 'Boek je plek in een padeltraining.' },
      es: { title: 'Inscríbete en Clases de Pádel | PadelTrainer.ai', desc: 'Apúntate a clases de pádel. Reserva tu plaza en una clase grupal o privada.', h1: 'Inscríbete en Clases de Pádel', p: 'Reserva tu plaza en una clase de pádel.' },
      de: { title: 'Anmeldung zum Padel-Training | PadelTrainer.ai', desc: 'Melde dich für Padel-Training an. Buche deinen Platz in einer Gruppen- oder Privatstunde.', h1: 'Anmeldung zum Padel-Training', p: 'Buche deinen Platz im Padel-Training.' },
      fr: { title: 'Inscription au Padel | PadelTrainer.ai', desc: 'Inscrivez-vous aux cours de padel. Réservez votre place dans un cours collectif ou privé.', h1: 'Inscription au Padel', p: 'Réservez votre place dans un cours de padel.' },
    };
    const rm = regMeta[lang] || { title: 'Register for Padel Training | PadelTrainer.ai', desc: 'Sign up for padel training sessions. Book your spot in a group or private padel lesson.', h1: 'Register for Padel Training', p: 'Book your spot in a padel training session.' };
    return page(
      rm.title, rm.desc, cleanPath, lang,
      `<h1>${esc(rm.h1)}</h1><p>${esc(rm.p)}</p>`
    );
  }

  // Province/region pages: /trainers/region/:slug
  const provinceMatch = cleanPath.match(/^\/trainers\/region\/([^/]+)$/);
  if (provinceMatch) {
    const provinceSlug = provinceMatch[1];
    const provinceData = getProvinceBySlug(provinceSlug);
    const province = provinceData?.name || slugToDisplay(provinceSlug);
    const facts = await fetchProvinceFacts(provinceSlug).catch(() => null);
    const provinceMeta: Record<string, { title: string; desc: string }> = {
      en: { title: `Padel Trainers in ${province} | PadelTrainer.ai`, desc: `Find and book certified padel trainers in ${province}. Compare prices, read reviews and book your first lesson.` },
      nl: { title: `Padel Trainers in ${province} | PadelTrainer.ai`, desc: `Vind en boek gecertificeerde padel trainers in ${province}. Vergelijk prijzen, lees reviews en boek je eerste les.` },
      es: { title: `Entrenadores de Pádel en ${province} | PadelTrainer.ai`, desc: `Encuentra y reserva entrenadores de pádel certificados en ${province}. Compara precios, lee reseñas y reserva tu primera clase.` },
      de: { title: `Padel Trainer in ${province} | PadelTrainer.ai`, desc: `Finde und buche zertifizierte Padel-Trainer in ${province}. Vergleiche Preise, lies Bewertungen und buche deine erste Stunde.` },
      fr: { title: `Coachs de Padel à ${province} | PadelTrainer.ai`, desc: `Trouvez et réservez des coachs de padel certifiés à ${province}. Comparez les prix, lisez les avis et réservez votre premier cours.` },
    };
    const pm = provinceMeta[lang] || provinceMeta['en']!;
    const tldr = facts && facts.trainerCount
      ? `${facts.trainerCount}+ certified padel resources across ${facts.cityCount} cities in ${province}.`
      : `Padel trainers across ${province}.`;
    const canonicalUrl = `${SITE_URL}/${lang}${cleanPath}`;
    const faqs = regionFaqs(province, lang);
    return page(
      pm.title, pm.desc, cleanPath, lang,
      `<h1>${esc(pm.title.split('|')[0].trim())}</h1>
       ${renderTldrHtml(tldr, lang)}
       ${facts ? renderProvinceCitiesHtml(province, facts.topCities, lang) : ''}
       ${renderFaqHtml(faqs, lang)}
       ${renderPopularCitiesHtml(lang)}
       ${renderPopularRegionsHtml(lang)}`,
      [faqPageSchema(faqs), speakableSchema(canonicalUrl)]
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
    '/about': { title: 'About PadelTrainer.ai', desc: 'PadelTrainer.ai is the leading platform for padel trainers and academies.' },
    '/pricing': { title: 'Pricing — PadelTrainer.ai', desc: 'Explore our flexible pricing plans for padel trainers and academies.' },
    '/founding-trainers': { title: 'Founding 100 Trainers — Free Premium Racket', desc: 'Be one of the first 100 padel coaches on PadelTrainer.ai and receive a free premium racket.' },
    '/press': { title: 'Press Kit — PadelTrainer.ai', desc: 'Official press kit: download logos, brand assets, fact sheet, and contact the PadelTrainer.ai press team.' },
    '/partner': { title: 'Become a Partner — PadelTrainer.ai', desc: 'Partner with PadelTrainer.ai to reach thousands of padel players.' },
    '/privacy': { title: 'Privacy Policy — PadelTrainer.ai', desc: 'Read the PadelTrainer.ai privacy policy.' },
    '/terms': { title: 'Terms of Service — PadelTrainer.ai', desc: 'Read the PadelTrainer.ai terms of service.' },
    '/playground': { title: 'Padel Playground — Quizzes & Tools | PadelTrainer.ai', desc: 'Take fun padel quizzes, find your perfect racket, and test your level.' },
    '/playground/red-flag-quiz': { title: "What's Your Padel Red Flag? | Fun Quiz — PadelTrainer.ai", desc: 'Every padel player has a red flag. Take this 2-minute quiz to find out yours — and challenge your partner.' },
    '/playground/racket-finder': { title: 'Padel Racket Finder | PadelTrainer.ai', desc: 'Find the perfect padel racket for your playing style and level.' },
    '/playground/level-test': { title: 'Padel Level Test | PadelTrainer.ai', desc: 'Discover your padel level with our free assessment tool. Get personalized training recommendations.' },
  };

  const staticMatch = staticPages[cleanPath];
  if (staticMatch) {
    return page(staticMatch.title, staticMatch.desc, cleanPath, lang, `<h1>${esc(staticMatch.title)}</h1>`);
  }

  // Topic hub: /<lang>/<topic-slug> (locale-specific slugs from Sanity)
  const topicHubMatch = cleanPath.match(/^\/([a-z0-9][a-z0-9-]*)$/i);
  if (topicHubMatch && !isReservedShortHandle(topicHubMatch[1])) {
    const topicSlug = topicHubMatch[1].toLowerCase();
    const topic = await fetchTopicHub(lang, topicSlug);
    if (topic) {
      const title = topic.h1 || topic.title || slugToDisplay(topicSlug);
      const description = (topic.description || topic.intro || `Everything about ${title.toLowerCase()} in padel.`).slice(0, 200);
      const alternates: Array<{ lang: string; slug: string }> = [
        { lang, slug: topicSlug },
        ...(topic.alternates || []).filter(a => a && a.language && a.slug).map(a => ({ lang: a.language, slug: a.slug })),
      ];
      const cardsHtml = (topic.featuredGuides || []).slice(0, 6)
        .map(g => `<li><a href="${SITE_URL}/${lang}/learn/${esc(g.slug)}">${esc(g.h1 || g.title)}</a></li>`)
        .join('');
      const body = `<h1>${esc(title)}</h1>
        <p>${esc(description)}</p>
        ${cardsHtml ? `<ul>${cardsHtml}</ul>` : ''}
        <p><a href="${SITE_URL}/${lang}/${esc(topicSlug)}">View full guide</a></p>`;
      const topicUrl = `${SITE_URL}/${lang}/${topicSlug}`;
      const sd: object[] = [
        {
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          "name": title,
          "description": description,
          "url": topicUrl,
          "isPartOf": { "@type": "WebSite", "name": "PadelTrainer.ai", "url": SITE_URL },
          "inLanguage": lang,
        },
        breadcrumbSchema(lang, [
          { name: homeName(lang), path: '' },
          { name: title },
        ]),
      ];
      return page(`${title} | PadelTrainer.ai`, description, `/${topicSlug}`, lang, body, sd, alternates);
    }
  }

  // Short link: /<handle> for trainer or academy
  const shortMatch = cleanPath.match(/^\/([a-z0-9][a-z0-9-]*)$/i);
  if (shortMatch && !isReservedShortHandle(shortMatch[1])) {
    const handle = shortMatch[1].toLowerCase();
    const resolved = await resolvePublicHandle(handle);
    if (resolved) {
      const canonicalPath = resolved.owner_type === 'academy'
        ? `/academies/${resolved.slug}`
        : `/trainer/${resolved.slug}`;
      const displayName = slugToDisplay(resolved.slug);
      const isAcademy = resolved.owner_type === 'academy';
      return page(
        isAcademy
          ? `${displayName} — Padel Academy | PadelTrainer.ai`
          : `${displayName} — Padel Trainer | PadelTrainer.ai`,
        isAcademy
          ? `Discover ${displayName}. View trainers, programs, and book padel lessons.`
          : `Book padel lessons with ${displayName}. View profile, experience, rates, and reviews on PadelTrainer.ai.`,
        canonicalPath, lang,
        `<h1>${esc(displayName)}</h1><p><a href="${SITE_URL}/${lang}${canonicalPath}">View profile</a></p>`
      );
    }
  }

  // Fallback — unknown path, surface a real 404 to crawlers
  const titles404: Record<string, string> = {
    nl: 'Pagina niet gevonden', es: 'Página no encontrada', de: 'Seite nicht gefunden',
    fr: 'Page introuvable', it: 'Pagina non trovata',
  };
  const descs404: Record<string, string> = {
    nl: 'Deze pagina bestaat niet (meer). Bekijk onze trainers en clubs.',
    es: 'Esta página no existe. Explora nuestros entrenadores y clubes.',
    de: 'Diese Seite existiert nicht. Entdecke unsere Trainer und Clubs.',
    fr: "Cette page n'existe pas. Découvrez nos entraîneurs et clubs.",
    it: 'Questa pagina non esiste. Scopri i nostri istruttori e club.',
  };
  return page(
    titles404[lang] || 'Page not found',
    descs404[lang] || 'This page does not exist. Explore our trainers and clubs.',
    cleanPath, lang,
    `<!-- render-page:notfound --><h1>${esc(titles404[lang] || 'Page not found')}</h1><p>${esc(descs404[lang] || 'This page does not exist.')}</p><p><a href="${SITE_URL}/${lang}/trainers">Browse trainers</a> · <a href="${SITE_URL}/${lang}/locations">Browse clubs</a></p>`
  );
}

const RESERVED_SHORT_HANDLES = new Set([
  'app','api','pay','auth','signup','login','onboarding','admin',
  'trainer','trainers','academy','academies','club','clubs',
  'locations','location','book','register','claim',
  'playground','learn','learning','topics','blog',
  'padel','padel-strokes','padel-coaches','padel-rules','video-tips','gear',
  'brand','press','partner','privacy','terms','founding-trainers','about','pricing',
  'rating','sitemap','robots','llms','assets','static','public',
  'manifest','favicon','sw','service-worker','share','www','mail',
  'home','index','search','contact','support','help','docs',
  'en','nl','es','de','fr','it',
]);

function isReservedShortHandle(handle: string): boolean {
  return RESERVED_SHORT_HANDLES.has(handle.toLowerCase());
}

async function resolvePublicHandle(handle: string): Promise<{ owner_type: string; slug: string } | null> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) return null;
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/resolve_public_handle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': anonKey,
        'Authorization': `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ _handle: handle }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.owner_type || !data.slug) return null;
    return data as { owner_type: string; slug: string };
  } catch {
    return null;
  }
}

// ─── HTML Builder ───────────────────────────────────────────────

function page(
  title: string,
  description: string,
  urlPath: string,
  lang: string,
  body: string,
  structuredData?: object[],
  alternates?: Array<{ lang: string; slug: string }>,
): string {
  // Canonical normalization: strip trailing slash (except root), collapse double slashes
  const normalizePath = (p: string) => {
    if (!p || p === '/') return '';
    const collapsed = p.replace(/\/{2,}/g, '/');
    return collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
  };
  const canonicalPath = normalizePath(urlPath);
  const canonicalUrl = `${SITE_URL}/${lang}${canonicalPath}`;
  const ogImage = `${SITE_URL}/og-image.png`;
  const ogLocale = OG_LOCALE_MAP[lang] || 'en_US';

  let hreflangTags: string;
  let xDefaultHref: string;
  if (alternates && alternates.length > 0) {
    // Use explicit per-language slugs (for routes where slugs differ per locale, e.g. topic hubs)
    hreflangTags = alternates
      .map(a => `<link rel="alternate" hreflang="${a.lang}" href="${SITE_URL}/${a.lang}/${a.slug}">`)
      .join('\n  ');
    const enAlt = alternates.find(a => a.lang === 'en');
    xDefaultHref = enAlt
      ? `${SITE_URL}/en/${enAlt.slug}`
      : `${SITE_URL}/${lang}${canonicalPath}`;
  } else {
    hreflangTags = SUPPORTED_LANGS
      .map(l => `<link rel="alternate" hreflang="${l}" href="${SITE_URL}/${l}${canonicalPath}">`)
      .join('\n  ');
    xDefaultHref = `${SITE_URL}/en${canonicalPath}`;
  }
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
  <link rel="alternate" hreflang="x-default" href="${xDefaultHref}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/png">
  <meta property="og:image:alt" content="${esc(title)}">
  <meta property="og:site_name" content="PadelTrainer.ai">
  <meta property="og:locale" content="${ogLocale}">
  ${ogLocaleAlternates}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${ogImage}">
  <meta name="twitter:image:alt" content="${esc(title)}">
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

function breadcrumbSchema(lang: string, steps: Array<{ name: string; path?: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": steps.map((s, i) => {
      const item: Record<string, unknown> = { "@type": "ListItem", "position": i + 1, "name": s.name };
      if (s.path !== undefined) item.item = `${SITE_URL}/${lang}${s.path}`;
      return item;
    }),
  };
}

function homeName(lang: string): string {
  return ({ nl: 'Home', es: 'Inicio', de: 'Startseite', fr: 'Accueil', it: 'Home' } as Record<string, string>)[lang] || 'Home';
}

// ─── Topic hub (Sanity) ────────────────────────────────────────

const SANITY_PROJECT_ID = 'ru3aqhjn';
const SANITY_DATASET = 'production';
const TOPIC_CACHE_TTL_MS = 5 * 60 * 1000;

interface TopicHubData {
  title?: string;
  h1?: string;
  intro?: string;
  description?: string;
  contentType?: string;
  alternates?: Array<{ language: string; slug: string }>;
  featuredGuides?: Array<{ slug: string; title?: string; h1?: string }>;
}

const topicHubCache = new Map<string, { data: TopicHubData | null; at: number }>();

async function fetchTopicHub(lang: string, slug: string): Promise<TopicHubData | null> {
  const key = `${lang}:${slug}`;
  const cached = topicHubCache.get(key);
  if (cached && Date.now() - cached.at < TOPIC_CACHE_TTL_MS) {
    return cached.data;
  }
  try {
    const groq = `*[_type=="topic" && slug.current==$slug && language==$lang && !(_id in path("drafts.**"))][0]{
      title, h1, intro, description, contentType,
      "alternates": *[_type=="topic" && contentType==^.contentType && _id!=^._id && !(_id in path("drafts.**"))]{
        language, "slug": slug.current
      },
      "featuredGuides": featuredGuides[]->{ "slug": slug.current, title, h1 }
    }`;
    const url = `https://${SANITY_PROJECT_ID}.apicdn.sanity.io/v2024-01-01/data/query/${SANITY_DATASET}?query=${encodeURIComponent(groq)}&%24slug=${encodeURIComponent(JSON.stringify(slug))}&%24lang=${encodeURIComponent(JSON.stringify(lang))}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      topicHubCache.set(key, { data: null, at: Date.now() });
      return null;
    }
    const json = await res.json();
    const data = (json && json.result) ? (json.result as TopicHubData) : null;
    topicHubCache.set(key, { data, at: Date.now() });
    return data;
  } catch (err) {
    console.error('fetchTopicHub error:', err);
    return null;
  }
}
