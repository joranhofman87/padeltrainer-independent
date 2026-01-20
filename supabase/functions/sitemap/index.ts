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
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Static pages with their priorities and change frequencies
    const staticPages = [
      { url: '/', priority: '1.0', changefreq: 'daily' },
      { url: '/about', priority: '0.8', changefreq: 'monthly' },
      { url: '/pricing', priority: '0.9', changefreq: 'weekly' },
      { url: '/trainers', priority: '0.9', changefreq: 'daily' },
      { url: '/locations', priority: '0.8', changefreq: 'daily' },
      { url: '/blog', priority: '0.7', changefreq: 'weekly' },
      { url: '/partner', priority: '0.6', changefreq: 'monthly' },
      { url: '/terms', priority: '0.3', changefreq: 'yearly' },
      { url: '/privacy', priority: '0.3', changefreq: 'yearly' },
      { url: '/auth', priority: '0.5', changefreq: 'monthly' },
    ];

    // Fetch all trainers with public profiles (include all, not just verified)
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

    // Build sitemap XML
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

    // Add static pages
    for (const page of staticPages) {
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}${page.url}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
      xml += `    <priority>${page.priority}</priority>\n`;
      xml += '  </url>\n';
    }

    // Add trainer profile pages
    if (trainers) {
      for (const trainer of trainers) {
        const lastmod = trainer.updated_at 
          ? new Date(trainer.updated_at).toISOString().split('T')[0] 
          : today;
        xml += '  <url>\n';
        xml += `    <loc>${SITE_URL}/trainer/${trainer.user_id}</loc>\n`;
        xml += `    <lastmod>${lastmod}</lastmod>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.7</priority>\n`;
        xml += '  </url>\n';
      }
    }

    // Add location pages
    if (locations) {
      for (const location of locations) {
        const lastmod = location.updated_at 
          ? new Date(location.updated_at).toISOString().split('T')[0] 
          : today;
        xml += '  <url>\n';
        xml += `    <loc>${SITE_URL}/locations/${location.slug}</loc>\n`;
        xml += `    <lastmod>${lastmod}</lastmod>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.6</priority>\n`;
        xml += '  </url>\n';
      }
    }

    // Add city landing pages for SEO
    for (const cityName of uniqueCities) {
      const citySlug = cityName.toLowerCase().replace(/\s+/g, '-');
      xml += '  <url>\n';
      xml += `    <loc>${SITE_URL}/trainers/${citySlug}</loc>\n`;
      xml += `    <lastmod>${today}</lastmod>\n`;
      xml += `    <changefreq>weekly</changefreq>\n`;
      xml += `    <priority>0.8</priority>\n`;
      xml += '  </url>\n';
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
