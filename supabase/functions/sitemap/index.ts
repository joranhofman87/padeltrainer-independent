import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';
const LANGUAGES = ['en', 'nl'];

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
      { path: '/blog', priority: '0.7', changefreq: 'weekly' },
      { path: '/partner', priority: '0.6', changefreq: 'monthly' },
      { path: '/terms', priority: '0.3', changefreq: 'yearly' },
      { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
    ];

    // Fetch all trainers with public profiles
    const { data: trainers, error: trainersError } = await supabase
      .from('trainer_profiles')
      .select('user_id, updated_at');

    if (trainersError) {
      console.error('Error fetching trainers:', trainersError);
    }

    // Fetch unique cities for city landing pages
    const { data: cityData, error: citiesError } = await supabase
      .from('locations')
      .select('city')
      .eq('is_active', true);

    if (citiesError) {
      console.error('Error fetching cities:', citiesError);
    }

    const uniqueCities = [...new Set(cityData?.map(l => l.city) || [])];

    // Fetch all active locations
    const { data: locations, error: locationsError } = await supabase
      .from('locations')
      .select('slug, updated_at')
      .eq('is_active', true);

    if (locationsError) {
      console.error('Error fetching locations:', locationsError);
    }

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
        xml += generateUrlEntry(`/trainer/${trainer.user_id}`, lastmod, 'weekly', '0.7');
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
    for (const cityName of uniqueCities) {
      const citySlug = cityName.toLowerCase().replace(/\s+/g, '-');
      xml += generateUrlEntry(`/trainers/${citySlug}`, today, 'weekly', '0.8');
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
