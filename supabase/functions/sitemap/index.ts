import { createClient } from "npm:@supabase/supabase-js@2";
import { createClient as createSanityClient } from "npm:@sanity/client@6";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';
const LANGUAGES = ['en', 'nl', 'es', 'de', 'fr'];
const SITEMAP_BASE_URL = `${SITE_URL}/sitemaps`;
const LOCATIONS_PER_PAGE = 5000;
const CITIES_PER_PAGE = 5000;

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

function xmlHeader(): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
}

function generateUrlEntry(path: string, lastmod: string, changefreq: string, priority: string): string {
  let entry = '';
  for (const lang of LANGUAGES) {
    const fullUrl = `${SITE_URL}/${lang}${path}`;
    entry += '  <url>\n';
    entry += `    <loc>${fullUrl}</loc>\n`;
    entry += `    <lastmod>${lastmod}</lastmod>\n`;
    entry += `    <changefreq>${changefreq}</changefreq>\n`;
    entry += `    <priority>${priority}</priority>\n`;
    for (const altLang of LANGUAGES) {
      entry += `    <xhtml:link rel="alternate" hreflang="${altLang}" href="${SITE_URL}/${altLang}${path}"/>\n`;
    }
    entry += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/nl${path}"/>\n`;
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
      const articleUrl = `${SITE_URL}/${article.locale}/blog/${article.slug}`;
      xml += '  <url>\n';
      xml += `    <loc>${articleUrl}</loc>\n`;
      xml += `    <lastmod>${lastmod}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.7</priority>\n`;
      for (const alt of group) {
        xml += `    <xhtml:link rel="alternate" hreflang="${alt.locale}" href="${SITE_URL}/${alt.locale}/blog/${alt.slug}"/>\n`;
      }
      const nlVersion = group.find(a => a.locale === 'nl') || group[0];
      xml += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/${nlVersion.locale}/blog/${nlVersion.slug}"/>\n`;
      xml += '  </url>\n';
    }
  }
  return xml;
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
      // Count locations and cities to determine pagination
      const locations = await fetchAllRows<{ slug: string; city: string }>(
        supabase, 'locations', 'slug, city', [{ column: 'is_active', operator: 'eq', value: true }]
      );
      const cityMap = new Map<string, boolean>();
      locations.forEach(loc => {
        const citySlug = encodeURIComponent(loc.city.toLowerCase().replace(/\s+/g, '-'));
        cityMap.set(citySlug, true);
      });

      const locationPages = Math.ceil(locations.length / LOCATIONS_PER_PAGE);
      const cityPages = Math.ceil(cityMap.size / CITIES_PER_PAGE);

      xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
      xml += '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

      // Static sitemap (static pages + trainers + academies + blog)
      xml += `  <sitemap>\n    <loc>${SITEMAP_BASE_URL}/sitemap-static.xml</loc>\n    <lastmod>${today}</lastmod>\n  </sitemap>\n`;

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
        { path: '/terms', priority: '0.3', changefreq: 'yearly' },
        { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
      ];

      for (const p of staticPages) {
        xml += generateUrlEntry(p.path, today, p.changefreq, p.priority);
      }

      // Trainers
      const { data: trainers } = await supabase
        .from('trainer_profiles')
        .select('user_id, slug, updated_at');

      if (trainers) {
        for (const trainer of trainers) {
          const lastmod = trainer.updated_at ? new Date(trainer.updated_at).toISOString().split('T')[0] : today;
          xml += generateUrlEntry(`/trainer/${trainer.slug || trainer.user_id}`, lastmod, 'weekly', '0.7');
        }
      }

      // Academies
      const { data: academies } = await supabase
        .from('academy_profiles')
        .select('slug, updated_at')
        .eq('is_verified', true)
        .eq('is_public', true);

      if (academies) {
        for (const academy of academies) {
          const lastmod = academy.updated_at ? new Date(academy.updated_at).toISOString().split('T')[0] : today;
          xml += generateUrlEntry(`/academies/${academy.slug}`, lastmod, 'weekly', '0.7');
        }
      }

      // Blog
      const { data: blogArticles } = await supabase
        .from('articles')
        .select('slug, locale, canonical_id, published_at, updated_at')
        .eq('status', 'published');

      if (blogArticles) {
        xml += generateBlogEntries(blogArticles, today);
      }

      // Sanity CMS content: Rules, Strokes, Coaches, Video Tips, Learning Articles
      // Fetch with language + translationOf to build proper hreflang groups
      const [sanityRules, sanityStrokes, sanityCoaches, sanityVideoTips, sanityLearningArticles, sanityTopics, sanityProducts] = await Promise.all([
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null }[]>(
          `*[_type == "rulesArticle" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null }[]>(
          `*[_type == "stroke" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null }[]>(
          `*[_type == "trainer" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null }[]>(
          `*[_type == "videoTip" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null; seo: { indexable?: boolean } | null }[]>(
          `*[_type == "learningArticle" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf, seo }`
        ),
        sanity.fetch<{ slug: string; isIndexable: boolean }[]>(
          `*[_type == "topic" && !(_id in path("drafts.**"))]{ "slug": slug.current, "isIndexable": coalesce(isIndexable, true) }`
        ),
        sanity.fetch<{ slug: string; language: string; translationOf: { _ref: string } | null }[]>(
          `*[_type == "product" && !(_id in path("drafts.**"))]{ _id, "slug": slug.current, language, translationOf }`
        ),
      ]);

      // Helper to generate language-aware entries with proper hreflang alternates
      function generateSanityEntries(
        // deno-lint-ignore no-explicit-any
        docs: any[],
        pathPrefix: string,
        priority: string,
        // deno-lint-ignore no-explicit-any
        filterFn?: (doc: any) => boolean
      ): string {
        let result = '';
        // Group by translation chain
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
            const fullUrl = `${SITE_URL}/${doc.language}/${pathPrefix}/${doc.slug}`;
            result += '  <url>\n';
            result += `    <loc>${fullUrl}</loc>\n`;
            result += `    <lastmod>${today}</lastmod>\n`;
            result += `    <changefreq>weekly</changefreq>\n`;
            result += `    <priority>${priority}</priority>\n`;
            // Add hreflang alternates for all translations in the group
            for (const alt of group) {
              result += `    <xhtml:link rel="alternate" hreflang="${alt.language}" href="${SITE_URL}/${alt.language}/${pathPrefix}/${alt.slug}"/>\n`;
            }
            const nlVersion = group.find((a: { language: string }) => a.language === 'nl') || group[0];
            result += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/${nlVersion.language}/${pathPrefix}/${nlVersion.slug}"/>\n`;
            result += '  </url>\n';
          }
        }
        return result;
      }

      xml += generateSanityEntries(sanityRules, 'padel-rules', '0.7');
      xml += generateSanityEntries(sanityStrokes, 'padel-strokes', '0.7');
      xml += generateSanityEntries(sanityCoaches, 'padel-coaches', '0.7');
      xml += generateSanityEntries(sanityVideoTips, 'video-tips', '0.6');
      xml += generateSanityEntries(
        sanityLearningArticles, 'learn', '0.7',
        (doc) => doc.seo?.indexable !== false
      );
      for (const topic of sanityTopics || []) {
        if (!topic.isIndexable) continue;
        xml += generateUrlEntry(`/topics/${topic.slug}`, today, 'weekly', '0.6');
      }

      xml += '</urlset>';

    } else if (type === 'locations') {
      xml = xmlHeader();

      const allLocations = await fetchAllRows<{ slug: string; city: string; updated_at: string }>(
        supabase, 'locations', 'slug, city, updated_at',
        [{ column: 'is_active', operator: 'eq', value: true }],
        'slug'
      );

      const start = (page - 1) * LOCATIONS_PER_PAGE;
      const pageLocations = allLocations.slice(start, start + LOCATIONS_PER_PAGE);

      for (const location of pageLocations) {
        const lastmod = location.updated_at ? new Date(location.updated_at).toISOString().split('T')[0] : today;
        xml += generateUrlEntry(`/locations/${location.slug}`, lastmod, 'weekly', '0.6');
      }

      xml += '</urlset>';

    } else if (type === 'cities') {
      xml = xmlHeader();

      const allLocations = await fetchAllRows<{ city: string }>(
        supabase, 'locations', 'city',
        [{ column: 'is_active', operator: 'eq', value: true }]
      );

      const cityMap = new Map<string, string>();
      allLocations.forEach(loc => {
        const citySlug = encodeURIComponent(loc.city.toLowerCase().replace(/\s+/g, '-'));
        if (!cityMap.has(citySlug)) cityMap.set(citySlug, loc.city);
      });

      const allCitySlugs = Array.from(cityMap.keys()).sort();
      const start = (page - 1) * CITIES_PER_PAGE;
      const pageCities = allCitySlugs.slice(start, start + CITIES_PER_PAGE);

      for (const citySlug of pageCities) {
        xml += generateUrlEntry(`/trainers/${citySlug}`, today, 'weekly', '0.8');
      }

      xml += '</urlset>';

    } else if (type === 'provinces') {
      xml = xmlHeader();

      const provinceSlugs = [
        'noord-holland', 'zuid-holland', 'noord-brabant', 'gelderland', 'utrecht',
        'overijssel', 'limburg', 'friesland', 'groningen', 'drenthe', 'flevoland', 'zeeland',
        'antwerpen', 'vlaams-brabant', 'oost-vlaanderen', 'west-vlaanderen',
        'cataluna', 'comunidad-de-madrid', 'comunidad-valenciana', 'andalucia',
        'nordrhein-westfalen', 'bayern', 'baden-wurttemberg'
      ];

      for (const provinceSlug of provinceSlugs) {
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
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Error generating sitemap:', error);
    return new Response('Error generating sitemap', { status: 500, headers: corsHeaders });
  }
});
