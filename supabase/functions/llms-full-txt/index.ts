import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_URL = 'https://padeltrainer.ai';

// deno-lint-ignore no-explicit-any
async function fetchAllRows<T>(
  supabase: any,
  table: string,
  selectColumns: string,
  filters?: { column: string; operator: string; value: boolean | string | number }[],
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch trainers, locations, and academies using fetchAllRows (bypasses 1000-row limit)
    const [trainers, locations, academies] = await Promise.all([
      fetchAllRows<{ id: string; user_id: string; slug: string; specializations: string[] | null; is_verified: boolean; hourly_rate: number | null }>(
        supabase, 'trainer_profiles', 'id, user_id, slug, specializations, is_verified, hourly_rate'
      ),
      fetchAllRows<{ id: string; name: string; city: string; slug: string; indoor_courts: number | null; outdoor_courts: number | null }>(
        supabase, 'locations', 'id, name, city, slug, indoor_courts, outdoor_courts',
        [{ column: 'is_active', operator: 'eq', value: true }]
      ),
      fetchAllRows<{ name: string; slug: string; description: string | null }>(
        supabase, 'academy_profiles', 'name, slug, description',
        [
          { column: 'is_verified', operator: 'eq', value: true },
          { column: 'is_public', operator: 'eq', value: true },
        ]
      ),
    ]);

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
      
      profiles?.forEach((p: { user_id: string; full_name: string | null; location: string | null }) => {
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
    const today = new Date().toISOString().slice(0, 10);
    let output = `# PadelTrainer.ai - Full Entity Catalog\n\n`;
    output += `Last updated: ${today}\n\n`;
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
      const verified = t.is_verified ? ' ✓' : '';

      output += `- **${name}**${verified}`;
      if (city) output += ` | ${city}`;
      if (specs) output += ` | ${specs}`;
      output += ` | ${SITE_URL}/en/trainer/${slug}\n`;
    });

    // Cities section
    output += `\n## Cities (${Object.keys(cityCounts).length})\n\n`;
    Object.entries(cityCounts)
      .sort((a, b) => b[1].trainers - a[1].trainers)
      .forEach(([city, counts]) => {
        const citySlug = city.toLowerCase().replace(/\s+/g, '-');
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
