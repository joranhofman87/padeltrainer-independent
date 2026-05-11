import { createClient } from "npm:@supabase/supabase-js@2";
import { createClient as createSanityClient } from "npm:@sanity/client@6";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';
const LANGUAGES = ['en', 'nl', 'es', 'de', 'fr', 'it'];
const SITEMAP_BASE_URL = `${SITE_URL}/sitemaps`;
const LOCATIONS_PER_PAGE = 2500;
const CITIES_PER_PAGE = 2500;

const sanity = createSanityClient({
  projectId: 'ru3aqhjn',
  dataset: 'production',
  apiVersion: '2024-01-01',
  useCdn: true,
});

// deno-lint-ignore no-explicit-any
async function fetchAllRows<T>(
  supabase: any,
  table: string,
  selectColumns: string,
  filters?: { column: string; operator: string; value: boolean | string | number }[],
  orderBy?: string
): Promise<T[]> {
  const allRows: T[] = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    let query = supabase
      .from(table)
      .select(selectColumns)
      .range(from, from + pageSize - 1);

    if (filters) {
      for (const filter of filters) {
        if (filter.operator === 'eq') {
          query = query.eq(filter.column, filter.value);
        }
      }
    }

    if (orderBy) {
      query = query.order(orderBy);
    }

    const { data, error } = await query;
    if (error) { console.error(`Error fetching ${table}:`, error); break; }
    if (data) {
      allRows.push(...(data as T[]));
      hasMore = data.length === pageSize;
      from += pageSize;
    } else {
      hasMore = false;
    }
  }
  return allRows;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlHeader(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
}

function generateUrlEntry(path: string, lastmod: string, changefreq: string, priority: string): string {
  const safePath = escapeXml(path);
  let entry = '';
  for (const lang of LANGUAGES) {
    const fullUrl = `${SITE_URL}/${lang}${safePath}`;
    entry += '  <url>\n';
    entry += `    <loc>${fullUrl}</loc>\n`;
    entry += `    <lastmod>${lastmod}</lastmod>\n`;
    entry += `    <changefreq>${changefreq}</changefreq>\n`;
    entry += `    <priority>${priority}</priority>\n`;
    for (const altLang of LANGUAGES) {
      entry += `    <xhtml:link rel="alternate" hreflang="${altLang}" href="${SITE_URL}/${altLang}${safePath}"/>\n`;
    }
    entry += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/en${safePath}"/>\n`;
    entry += '  </url>\n';
  }
  return entry;
}

function generateBlogEntries(blogArticles: { slug: string; locale: string; canonical_id: string; published_at: string | null; updated_at: string | null }[], today: string): string {
  let xml = '';
  const articlesByCanonical = new Map<string, typeof blogArticles>();
  for (const article of blogArticles) {
    const group = articlesByCanonical.get(article.canonical_id) || [];
    group.push(article);
    articlesByCanonical.set(article.canonical_id, group);
  }

  for (const [, group] of articlesByCanonical) {
    for (const article of group) {
      const lastmod = (article.updated_at || article.published_at || today).split('T')[0];
      const safeSlug = escapeXml(article.slug);
      const articleUrl = `${SITE_URL}/${article.locale}/blog/${safeSlug}`;
      xml += '  <url>\n';
      xml += `    <loc>${articleUrl}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.7</priority>\n`;
      for (const alt of group) {
        xml += `    <xhtml:link rel="alternate" hreflang="${alt.locale}" href="${SITE_URL}/${alt.locale}/blog/${escapeXml(alt.slug)}"/>\n`;
      }
      const enVersion = group.find(a => a.locale === 'en') || group.find(a => a.locale === 'nl') || group[0];
      xml += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/en/blog/${escapeXml(enVersion.slug)}"/>\n`;
      xml += '  </url>\n';
    }
  }
  return xml;
}

// Helper to generate language-aware entries with proper hreflang alternates from Sanity docs
function generateSanityEntries(
  // deno-lint-ignore no-explicit-any
  docs: any[],
  pathPrefix: string,
  priority: string,
  today: string,
  // deno-lint-ignore no-explicit-any
  filterFn?: (doc: any) => boolean
): string {
  let result = '';
  // deno-lint-ignore no-explicit-any
  const groups = new Map<string, any[]>();
  for (const doc of docs) {
    if (filterFn && !filterFn(doc)) continue;
    const lang = doc.language || 'en';
    const rootId = doc.translationOf?._ref || doc._id;
    const group = groups.get(rootId) || [];
    group.push({ ...doc, language: lang });
    groups.set(rootId, group);
  }

  for (const [, group] of groups) {
    for (const doc of group) {
      const lastmod = doc._updatedAt ? doc._updatedAt.split('T')[0] : today;
      const safeSlug = escapeXml(doc.slug);
      const fullUrl = `${SITE_URL}/${doc.language}/${pathPrefix}/${safeSlug}`;
      result += '  <url>\n';
      result += `    <loc>${fullUrl}</loc>\n`;
      result += `    <lastmod>${lastmod}</lastmod>\n`;
      result += `    <changefreq>weekly</changefreq>\n`;
      result += `    <priority>${priority}</priority>\n`;
      for (const alt of group) {
        result += `    <xhtml:link rel="alternate" hreflang="${alt.language}" href="${SITE_URL}/${alt.language}/${pathPrefix}/${escapeXml(alt.slug)}"/>\n`;
      }
      const enVersion = group.find((a: { language: string }) => a.language === 'en') || group.find((a: { language: string }) => a.language === 'nl') || group[0];
      result += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/en/${pathPrefix}/${escapeXml(enVersion.slug)}"/>\n`;
      result += '  </url>\n';
    }
  }
  return result;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const type = url.searchParams.get('type') || 'index';
    const page = parseInt(url.searchParams.get('page') || '1', 10);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const today = new Date().toISOString().split('T')[0];
    let xml = '';

    if (type === 'index') {
      // Use count query for locations (avoids fetching all rows)
      const { count: locationCount } = await supabase
        .from('locations')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true);

      // Fetch only city column to count unique cities
      const [allCities, sanityCityIndex] = await Promise.all([
        fetchAllRows<{ city: string }>(
          supabase, 'locations', 'city',
          [{ column: 'is_active', operator: 'eq', value: true }]
        ),
        sanity.fetch<{ citySlug: string }[]>(
          `*[_type == "cityPage" && !(_id in path("drafts.**"))]{ citySlug }`
        ).catch(() => [] as { citySlug: string }[]),
      ]);
      const citySet = new Set(allCities.map(loc =>
        loc.city.toLowerCase().replace(/\s+/g, '-')
      ));
      for (const doc of sanityCityIndex) {
        if (doc.citySlug) citySet.add(doc.citySlug);
      }

      const locationPages = Math.ceil((locationCount || 0) / LOCATIONS_PER_PAGE);
      const cityPages = Math.ceil(citySet.size / CITIES_PER_PAGE);

      xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

      // Static sitemap (static pages + trainers + academies + blog)
      xml += `  <sitemap>\n    <loc>${SITEMAP_BASE_URL}/sitemap-static.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`;

      // Content sitemap (Sanity CMS content: rules, strokes, coaches, etc.)
      xml += `  <sitemap>\n    <loc>${SITEMAP_BASE_URL}/sitemap-content.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`;

      // Location sitemaps (paginated)
      for (let i = 1; i <= locationPages; i++) {
        xml += `  <sitemap>\n    <loc>${SITEMAP_BASE_URL}/sitemap-locations-${i}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`;
      }

      // City sitemaps (paginated)
      for (let i = 1; i <= cityPages; i++) {
        xml += `  <sitemap>\n    <loc>${SITEMAP_BASE_URL}/sitemap-cities-${i}.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`;
      }

      // Provinces sitemap
      xml += `  <sitemap>\n    <loc>${SITEMAP_BASE_URL}/sitemap-provinces.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`;

      xml += '</sitemapindex>';

    } else if (type === 'static') {
      // Only static pages + Supabase DB queries (trainers, academies, blog)
      xml = xmlHeader();

      const staticPages = [
        { path: '', priority: '1.0', changefreq: 'daily' },
        { path: '/about', priority: '0.8', changefreq: 'monthly' },
        { path: '/pricing', priority: '0.9', changefreq: 'weekly' },
        { path: '/trainers', priority: '0.9', changefreq: 'daily' },
        { path: '/locations', priority: '0.8', changefreq: 'daily' },
        { path: '/academies', priority: '0.8', changefreq: 'weekly' },
        { path: '/blog', priority: '0.7', changefreq: 'weekly' },
        { path: '/partner', priority: '0.6', changefreq: 'monthly' },
        { path: '/padel-rules', priority: '0.7', changefreq: 'weekly' },
        { path: '/padel-strokes', priority: '0.7', changefreq: 'weekly' },
        { path: '/padel-coaches', priority: '0.7', changefreq: 'weekly' },
        { path: '/video-tips', priority: '0.7', changefreq: 'weekly' },
        { path: '/learn', priority: '0.8', changefreq: 'weekly' },
        { path: '/topics', priority: '0.7', changefreq: 'weekly' },
        { path: '/playground', priority: '0.7', changefreq: 'weekly' },
        { path: '/playground/red-flag-quiz', priority: '0.7', changefreq: 'monthly' },
        { path: '/playground/racket-finder', priority: '0.7', changefreq: 'monthly' },
        { path: '/playground/level-test', priority: '0.7', changefreq: 'monthly' },
        { path: '/founding-trainers', priority: '0.6', changefreq: 'monthly' },
        { path: '/brand', priority: '0.5', changefreq: 'monthly' },
        { path: '/press', priority: '0.5', changefreq: 'monthly' },
        { path: '/gear/rackets', priority: '0.7', changefreq: 'weekly' },
        { path: '/terms', priority: '0.3', changefreq: 'yearly' },
        { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
      ];

      for (const p of staticPages) {
        xml += generateUrlEntry(p.path, today, p.changefreq, p.priority);
      }

      // Trainers (use fetchAllRows to bypass 1000-row limit)
      const trainers = await fetchAllRows<{ user_id: string; slug: string; updated_at: string }>(
        supabase, 'trainer_profiles', 'user_id, slug, updated_at'
      );

      for (const trainer of trainers) {
        const lastmod = trainer.updated_at ? new Date(trainer.updated_at).toISOString().split('T')[0] : today;
        xml += generateUrlEntry(`/trainer/${trainer.slug || trainer.user_id}`, lastmod, 'weekly', '0.7');
      }

      // Academies (use fetchAllRows to bypass 1000-row limit)
      const academies = await fetchAllRows<{ slug: string; updated_at: string }>(
        supabase, 'academy_profiles', 'slug, updated_at',
        [
          { column: 'is_verified', operator: 'eq', value: true },
          { column: 'is_public', operator: 'eq', value: true },
        ]
      );

      for (const academy of academies) {
        const lastmod = academy.updated_at ? new Date(academy.updated_at).toISOString().split('T')[0] : today;
        xml += generateUrlEntry(`/academies/${academy.slug}`, lastmod, 'weekly', '0.7');
      }

      // Blog (use fetchAllRows to bypass 1000-row limit)
      const blogArticles = await fetchAllRows<{ slug: string; locale: string; canonical_id: string; published_at: string; updated_at: string }>(
        supabase, 'articles', 'slug, locale, canonical_id, published_at, updated_at',
        [{ column: 'status', operator: 'eq', value: 'published' }]
      );

      xml += generateBlogEntries(blogArticles, today);

      xml += '</urlset>';

    } else if (type === 'content') {
      // Sanity CMS content only — isolated from DB queries for faster execution
      xml = xmlHeader();

      const [sanityRules, sanityStrokes, sanityCoaches, sanityVideoTips, sanityLearningArticles, sanityTopics, sanityProducts] = await Promise.all([
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; _updatedAt: string }[]>(
          `*[_type == "rulesArticle" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, _updatedAt }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; _updatedAt: string }[]>(
          `*[_type == "stroke" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, _updatedAt }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; _updatedAt: string }[]>(
          `*[_type == "trainer" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, _updatedAt }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; _updatedAt: string }[]>(
          `*[_type == "videoTip" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, _updatedAt }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; seo: { indexable?: boolean } | null; _updatedAt: string }[]>(
          `*[_type == "learningArticle" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, seo, _updatedAt }`
        ),
        sanity.fetch<{ slug: string; isIndexable: boolean; _updatedAt: string }[]>(
          `*[_type == "topic" && !(_id in path("drafts.**"))]{ "slug": slug.current, "isIndexable": coalesce(isIndexable, true), _updatedAt }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; _updatedAt: string }[]>(
          `*[_type == "product" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, _updatedAt }`
        ),
      ]);

      xml += generateSanityEntries(sanityRules, 'padel-rules', '0.7', today);
      xml += generateSanityEntries(sanityStrokes, 'padel-strokes', '0.7', today);
      xml += generateSanityEntries(sanityCoaches, 'padel-coaches', '0.7', today);
      xml += generateSanityEntries(sanityVideoTips, 'video-tips', '0.6', today);
      xml += generateSanityEntries(
        sanityLearningArticles, 'learn', '0.7', today,
        (doc) => doc.seo?.indexable !== false
      );
      xml += generateSanityEntries(sanityProducts, 'gear/rackets', '0.6', today);
      for (const topic of sanityTopics || []) {
        if (!topic.isIndexable) continue;
        const topicLastmod = topic._updatedAt ? topic._updatedAt.split('T')[0] : today;
        xml += generateUrlEntry(`/topics/${topic.slug}`, topicLastmod, 'weekly', '0.6');
      }

      xml += '</urlset>';

    } else if (type === 'locations') {
      xml = xmlHeader();

      const start = (page - 1) * LOCATIONS_PER_PAGE;
      const end = start + LOCATIONS_PER_PAGE - 1;

      // True server-side pagination: fetch only the rows for this page window
      // Batch in chunks of 1000 within the page window to bypass Supabase's 1000-row limit
      const pageLocations: { slug: string; city: string; updated_at: string }[] = [];
      const batchSize = 1000;
      for (let offset = start; offset <= end; offset += batchSize) {
        const batchEnd = Math.min(offset + batchSize - 1, end);
        const { data, error } = await supabase
          .from('locations')
          .select('slug, city, updated_at')
          .eq('is_active', true)
          .order('slug')
          .range(offset, batchEnd);
        if (error) { console.error('Error fetching locations page:', error); break; }
        if (data) pageLocations.push(...data);
        if (!data || data.length < batchSize) break;
      }

      for (const location of pageLocations) {
        const lastmod = location.updated_at
          ? new Date(location.updated_at).toISOString().split('T')[0]
          : today;
        xml += generateUrlEntry(`/locations/${location.slug}`, lastmod, 'weekly', '0.6');
      }

      xml += '</urlset>';

    } else if (type === 'cities') {
      xml = xmlHeader();

      // Fetch city + updated_at to compute per-city max(updated_at) for B3 lastmod
      const allCityRows = await fetchAllRows<{ city: string; updated_at: string | null }>(
        supabase, 'locations', 'city, updated_at',
        [{ column: 'is_active', operator: 'eq', value: true }]
      );

      const cityMap = new Map<string, string>();
      const cityLastmod = new Map<string, string>();
      allCityRows.forEach(loc => {
        const citySlug = loc.city.toLowerCase().replace(/\s+/g, '-');
        if (!cityMap.has(citySlug)) cityMap.set(citySlug, loc.city);
        if (loc.updated_at) {
          const d = loc.updated_at.split('T')[0];
          const prev = cityLastmod.get(citySlug);
          if (!prev || d > prev) cityLastmod.set(citySlug, d);
        }
      });

      // Also fetch Sanity cityPage slugs to include cities that may not have DB locations yet
      const sanityCitySlugs = await sanity.fetch<{ citySlug: string; _updatedAt: string }[]>(
        `*[_type == "cityPage" && !(_id in path("drafts.**"))]{ citySlug, _updatedAt }`
      ).catch(() => [] as { citySlug: string; _updatedAt: string }[]);

      for (const doc of sanityCitySlugs) {
        if (doc.citySlug && !cityMap.has(doc.citySlug)) {
          cityMap.set(doc.citySlug, doc.citySlug);
        }
        if (doc.citySlug && doc._updatedAt) {
          const d = doc._updatedAt.split('T')[0];
          const prev = cityLastmod.get(doc.citySlug);
          if (!prev || d > prev) cityLastmod.set(doc.citySlug, d);
        }
      }

      const allCitySlugs = Array.from(cityMap.keys()).sort();
      const start = (page - 1) * CITIES_PER_PAGE;
      const pageCities = allCitySlugs.slice(start, start + CITIES_PER_PAGE);

      for (const citySlug of pageCities) {
        const lm = cityLastmod.get(citySlug) || today;
        xml += generateUrlEntry(`/trainers/${citySlug}`, lm, 'weekly', '0.8');
        xml += generateUrlEntry(`/padel/${citySlug}`, lm, 'weekly', '0.8');
      }

      xml += '</urlset>';

    } else if (type === 'provinces') {
      xml = xmlHeader();

      // Data-driven: fetch distinct provinces from the locations table
      const allProvinceRows = await fetchAllRows<{ province: string }>(
        supabase, 'locations', 'province',
        [{ column: 'is_active', operator: 'eq', value: true }]
      );

      const provinceSlugSet = new Set<string>();
      for (const row of allProvinceRows) {
        if (row.province) {
          const slug = row.province.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          if (slug) provinceSlugSet.add(slug);
        }
      }

      // Fallback: ensure key provinces are always included even if no locations exist yet
      const fallbackSlugs = [
        'noord-holland', 'zuid-holland', 'noord-brabant', 'gelderland', 'utrecht',
        'overijssel', 'limburg', 'friesland', 'groningen', 'drenthe', 'flevoland', 'zeeland',
        'antwerpen', 'vlaams-brabant', 'oost-vlaanderen', 'west-vlaanderen',
        'cataluna', 'comunidad-de-madrid', 'comunidad-valenciana', 'andalucia',
        'nordrhein-westfalen', 'bayern', 'baden-wurttemberg',
        'ile-de-france', 'provence-alpes-cote-d-azur', 'occitanie',
        'nouvelle-aquitaine', 'auvergne-rhone-alpes', 'hauts-de-france',
        'pays-de-la-loire', 'grand-est',
      ];
      for (const slug of fallbackSlugs) {
        provinceSlugSet.add(slug);
      }

      const sortedSlugs = Array.from(provinceSlugSet).sort();
      for (const provinceSlug of sortedSlugs) {
        xml += generateUrlEntry(`/trainers/region/${provinceSlug}`, today, 'weekly', '0.7');
      }

      xml += '</urlset>';

    } else {
      return new Response('Invalid type parameter', { status: 400, headers: corsHeaders });
    }

    return new Response(xml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml',
        // Long edge/CDN cache; refresh weekly. SWR keeps responses warm during regen.
        'Cache-Control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      },
    });
  } catch (error) {
    console.error('Error generating sitemap:', error);
    return new Response('Error generating sitemap', { status: 500, headers: corsHeaders });
  }
});
