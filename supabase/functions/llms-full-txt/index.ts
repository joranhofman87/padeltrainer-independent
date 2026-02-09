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

    // Fetch trainers, locations, and academies in parallel
    const [trainersRes, locationsRes, academiesRes] = await Promise.all([
      supabase
        .from('trainer_profiles')
        .select('id, user_id, slug, specializations, is_verified, hourly_rate'),
      supabase
        .from('locations')
        .select('id, name, city, slug, indoor_courts, outdoor_courts')
        .eq('is_active', true),
      supabase
        .from('academy_profiles')
        .select('name, slug, description')
        .eq('is_verified', true)
        .eq('is_public', true),
    ]);

    const trainers = trainersRes.data || [];
    const locations = locationsRes.data || [];
    const academies = academiesRes.data || [];

    // Fetch trainer names from profiles
    const userIds = trainers.map(t => t.user_id);
    const profilesMap: Record<string, { full_name: string | null; location: string | null }> = {};
    
    // Batch fetch profiles (handle >1000)
    for (let i = 0; i < userIds.length; i += 1000) {
      const batch = userIds.slice(i, i + 1000);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, full_name, location')
        .in('user_id', batch);
      
      profiles?.forEach(p => {
        profilesMap[p.user_id] = { full_name: p.full_name, location: p.location };
      });
    }

    // Build city stats
    const cityCounts: Record<string, { trainers: number; locations: number }> = {};
    locations.forEach(loc => {
      const city = loc.city;
      if (!cityCounts[city]) cityCounts[city] = { trainers: 0, locations: 0 };
      cityCounts[city].locations++;
    });

    // Count trainers per city from their profile location
    trainers.forEach(t => {
      const profile = profilesMap[t.user_id];
      const city = profile?.location;
      if (city) {
        if (!cityCounts[city]) cityCounts[city] = { trainers: 0, locations: 0 };
        cityCounts[city].trainers++;
      }
    });

    // Build output
    let output = `# PadelTrainer.ai - Full Entity Catalog\n\n`;
    output += `> Complete listing of all trainers, locations, academies, and cities on PadelTrainer.ai.\n`;
    output += `> Generated: ${new Date().toISOString()}\n\n`;

    // Trainers section
    output += `## Trainers (${trainers.length})\n\n`;
    trainers.forEach(t => {
      const profile = profilesMap[t.user_id];
      const name = profile?.full_name || 'Unknown';
      const city = profile?.location || '';
      const slug = t.slug || t.id;
      const specs = t.specializations?.join(', ') || '';
      const rate = t.hourly_rate ? `€${t.hourly_rate}/hr` : '';
      const verified = t.is_verified ? ' ✓' : '';
      
      output += `- **${name}**${verified}`;
      if (city) output += ` | ${city}`;
      if (rate) output += ` | ${rate}`;
      if (specs) output += ` | ${specs}`;
      output += ` | ${SITE_URL}/en/trainer/${slug}\n`;
    });

    // Cities section
    output += `\n## Cities (${Object.keys(cityCounts).length})\n\n`;
    Object.entries(cityCounts)
      .sort((a, b) => b[1].trainers - a[1].trainers)
      .forEach(([city, counts]) => {
        const citySlug = encodeURIComponent(city.toLowerCase().replace(/\s+/g, '-'));
        output += `- **${city}** | ${counts.trainers} trainers | ${counts.locations} clubs | ${SITE_URL}/en/trainers/${citySlug}\n`;
      });

    // Locations section
    output += `\n## Padel Clubs & Locations (${locations.length})\n\n`;
    locations.forEach(loc => {
      const courts = [];
      if (loc.indoor_courts) courts.push(`${loc.indoor_courts} indoor`);
      if (loc.outdoor_courts) courts.push(`${loc.outdoor_courts} outdoor`);
      const courtStr = courts.length > 0 ? ` | ${courts.join(', ')} courts` : '';
      
      output += `- **${loc.name}** | ${loc.city}${courtStr} | ${SITE_URL}/en/locations/${loc.slug}\n`;
    });

    // Academies section
    output += `\n## Academies (${academies.length})\n\n`;
    academies.forEach(a => {
      const desc = a.description ? ` | ${a.description.slice(0, 100)}` : '';
      output += `- **${a.name}**${desc} | ${SITE_URL}/en/academies/${a.slug}\n`;
    });

    return new Response(output, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Error generating llms-full.txt:', error);
    return new Response('Error generating llms-full.txt', {
      status: 500,
      headers: corsHeaders,
    });
  }
});
