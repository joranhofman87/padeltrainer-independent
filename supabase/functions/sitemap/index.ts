import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';
const LANGUAGES = ['en', 'nl'];

// Helper to fetch all rows (handles >1000 limit)
// deno-lint-ignore no-explicit-any
async function fetchAllRows<T>(
  supabase: any,
  table: string,
  selectColumns: string,
  filters?: { column: string; operator: string; value: boolean | string | number }[]
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

    const { data, error } = await query;

    if (error) {
      console.error(`Error fetching ${table}:`, error);
      break;
    }

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Static pages with their priorities and change frequencies
    const staticPages = [
      { path: '', priority: '1.0', changefreq: 'daily' },
      { path: '/about', priority: '0.8', changefreq: 'monthly' },
      { path: '/pricing', priority: '0.9', changefreq: 'weekly' },
      { path: '/trainers', priority: '0.9', changefreq: 'daily' },
      { path: '/locations', priority: '0.8', changefreq: 'daily' },
      { path: '/academies', priority: '0.8', changefreq: 'weekly' },
      { path: '/blog', priority: '0.7', changefreq: 'weekly' },
      { path: '/partner', priority: '0.6', changefreq: 'monthly' },
      { path: '/terms', priority: '0.3', changefreq: 'yearly' },
      { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
    ];

    // Fetch all trainers with public profiles (use slug for SEO-friendly URLs)
    const { data: trainers, error: trainersError } = await supabase
      .from('trainer_profiles')
      .select('user_id, slug, updated_at');

    if (trainersError) {
      console.error('Error fetching trainers:', trainersError);
    }

    // Fetch all active locations (with pagination for >1000 rows)
    const locations = await fetchAllRows<{ slug: string; city: string; updated_at: string }>(
      supabase,
      'locations',
      'slug, city, updated_at',
      [{ column: 'is_active', operator: 'eq', value: true }]
    );

    // Fetch all verified public academies
    const { data: academies, error: academiesError } = await supabase
      .from('academy_profiles')
      .select('slug, updated_at')
      .eq('is_verified', true)
      .eq('is_public', true);

    if (academiesError) {
      console.error('Error fetching academies:', academiesError);
    }

    // Extract unique cities and create slugs (deduplicated, case-insensitive)
    // URL-encode special characters like apostrophes
    const cityMap = new Map<string, string>();
    locations?.forEach(loc => {
      const citySlug = encodeURIComponent(loc.city.toLowerCase().replace(/\s+/g, '-'));
      if (!cityMap.has(citySlug)) {
        cityMap.set(citySlug, loc.city);
      }
    });
    const uniqueCitySlugs = Array.from(cityMap.keys());

    const today = new Date().toISOString().split('T')[0];

    // Build sitemap XML with xhtml namespace for hreflang
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';

    // Helper function to generate URL entry with hreflang links
    const generateUrlEntry = (path: string, lastmod: string, changefreq: string, priority: string) => {
      let entry = '';
      for (const lang of LANGUAGES) {
        const fullUrl = `${SITE_URL}/${lang}${path}`;
        entry += '  <url>\n';
        entry += `    <loc>${fullUrl}</loc>\n`;
        entry += `    <lastmod>${lastmod}</lastmod>\n`;
        entry += `    <changefreq>${changefreq}</changefreq>\n`;
        entry += `    <priority>${priority}</priority>\n`;
        // Add hreflang links for all languages
        for (const altLang of LANGUAGES) {
          entry += `    <xhtml:link rel="alternate" hreflang="${altLang}" href="${SITE_URL}/${altLang}${path}"/>\n`;
        }
        // Add x-default pointing to Dutch
        entry += `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/nl${path}"/>\n`;
        entry += '  </url>\n';
      }
      return entry;
    };

    // Add static pages (for each language)
    for (const page of staticPages) {
      xml += generateUrlEntry(page.path, today, page.changefreq, page.priority);
    }

    // Add trainer profile pages (for each language)
    if (trainers) {
      for (const trainer of trainers) {
        const lastmod = trainer.updated_at 
          ? new Date(trainer.updated_at).toISOString().split('T')[0] 
          : today;
        xml += generateUrlEntry(`/trainer/${trainer.slug || trainer.user_id}`, lastmod, 'weekly', '0.7');
      }
    }

    // Add location pages (for each language)
    if (locations) {
      for (const location of locations) {
        const lastmod = location.updated_at 
          ? new Date(location.updated_at).toISOString().split('T')[0] 
          : today;
        xml += generateUrlEntry(`/locations/${location.slug}`, lastmod, 'weekly', '0.6');
      }
    }

    // Add city landing pages for SEO (for each language)
    for (const citySlug of uniqueCitySlugs) {
      xml += generateUrlEntry(`/trainers/${citySlug}`, today, 'weekly', '0.8');
    }

    // Add academy profile pages (for each language)
    if (academies) {
      for (const academy of academies) {
        const lastmod = academy.updated_at 
          ? new Date(academy.updated_at).toISOString().split('T')[0] 
          : today;
        xml += generateUrlEntry(`/academies/${academy.slug}`, lastmod, 'weekly', '0.7');
      }
    }

    xml += '</urlset>';

    return new Response(xml, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });
  } catch (error) {
    console.error('Error generating sitemap:', error);
    return new Response('Error generating sitemap', {
      status: 500,
      headers: corsHeaders,
    });
  }
});
