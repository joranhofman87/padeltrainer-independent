import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface Location {
  id: string;
  name: string;
  street_address: string | null;
  postal_code: string | null;
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
}

interface GeocodeResult {
  location_id: string;
  location_name: string;
  status: 'success' | 'skipped' | 'error';
  latitude?: number;
  longitude?: number;
  error?: string;
  address_used?: string;
}

interface NominatimResponse {
  lat: string;
  lon: string;
  display_name: string;
}

// Delay helper for rate limiting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Build address string for geocoding
function buildAddressString(location: Location): string {
  const parts: string[] = [];
  
  if (location.street_address) {
    parts.push(location.street_address);
  }
  if (location.postal_code) {
    parts.push(location.postal_code);
  }
  parts.push(location.city);
  
  // Convert country code to full name for better results
  const countryMap: Record<string, string> = {
    'NL': 'Netherlands',
    'BE': 'Belgium',
    'DE': 'Germany',
    'FR': 'France',
    'ES': 'Spain',
    'PT': 'Portugal',
    'IT': 'Italy',
    'UK': 'United Kingdom',
    'GB': 'United Kingdom',
  };
  
  const country = countryMap[location.country] || location.country;
  parts.push(country);
  
  return parts.join(', ');
}

// Geocode a single address using Nominatim
async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  
  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'PadelTrainer/1.0 (geocoding service)',
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Nominatim API error: ${response.status}`);
  }
  
  const data: NominatimResponse[] = await response.json();
  
  if (data.length === 0) {
    return null;
  }
  
  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
  };
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const body = await req.json().catch(() => ({}));
    const {
      batch_size = 50,
      offset = 0,
      dry_run = false,
      location_ids = null,
      force = false,
    } = body;

    // Validate batch_size
    const validatedBatchSize = Math.min(Math.max(1, batch_size), 100);

    console.log(`Geocoding request: batch_size=${validatedBatchSize}, offset=${offset}, dry_run=${dry_run}, force=${force}`);

    // Build query
    let query = supabase
      .from('locations')
      .select('id, name, street_address, postal_code, city, country, latitude, longitude')
      .eq('is_active', true)
      .order('name', { ascending: true });

    // Filter by specific location IDs if provided
    if (location_ids && Array.isArray(location_ids) && location_ids.length > 0) {
      query = query.in('id', location_ids);
    } else {
      // Only filter by missing coordinates if not forcing re-geocode
      if (!force) {
        query = query.is('latitude', null);
      }
      query = query.range(offset, offset + validatedBatchSize - 1);
    }

    const { data: locations, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch locations: ${fetchError.message}`);
    }

    if (!locations || locations.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: 'No locations to process',
          batch_size: validatedBatchSize,
          offset,
          next_offset: null,
          total_processed: 0,
          summary: { success: 0, skipped: 0, errors: 0 },
          results: [],
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const results: GeocodeResult[] = [];
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Process each location
    for (let i = 0; i < locations.length; i++) {
      const location = locations[i] as Location;
      
      // Skip if already has coordinates and not forcing
      if (!force && location.latitude !== null && location.longitude !== null) {
        results.push({
          location_id: location.id,
          location_name: location.name,
          status: 'skipped',
          latitude: location.latitude,
          longitude: location.longitude,
        });
        skippedCount++;
        continue;
      }

      const address = buildAddressString(location);
      let finalLat: number | null = null;
      let finalLon: number | null = null;
      
      try {
        // Rate limiting: wait 1.5 seconds between requests (except for first)
        if (i > 0) {
          await delay(1500);
        }

        console.log(`Geocoding: ${location.name} - ${address}`);
        
        const coords = await geocodeAddress(address);

        if (coords) {
          finalLat = coords.lat;
          finalLon = coords.lon;
        } else {
          // Try with just city and country as fallback
          const fallbackAddress = `${location.city}, ${location.country === 'NL' ? 'Netherlands' : location.country}`;
          console.log(`Trying fallback: ${fallbackAddress}`);
          await delay(1500);
          
          const fallbackCoords = await geocodeAddress(fallbackAddress);
          
          if (fallbackCoords) {
            finalLat = fallbackCoords.lat;
            finalLon = fallbackCoords.lon;
          }
        }

        if (finalLat === null || finalLon === null) {
          results.push({
            location_id: location.id,
            location_name: location.name,
            status: 'error',
            error: 'No results from geocoding',
            address_used: address,
          });
          errorCount++;
          continue;
        }

        // Update database if not dry run
        if (!dry_run) {
          const { error: updateError } = await supabase
            .from('locations')
            .update({
              latitude: finalLat,
              longitude: finalLon,
            })
            .eq('id', location.id);

          if (updateError) {
            results.push({
              location_id: location.id,
              location_name: location.name,
              status: 'error',
              error: `Database update failed: ${updateError.message}`,
              address_used: address,
            });
            errorCount++;
            continue;
          }
        }

        results.push({
          location_id: location.id,
          location_name: location.name,
          status: 'success',
          latitude: finalLat,
          longitude: finalLon,
          address_used: address,
        });
        successCount++;
        
      } catch (error) {
        console.error(`Error geocoding ${location.name}:`, error);
        results.push({
          location_id: location.id,
          location_name: location.name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          address_used: address,
        });
        errorCount++;
      }
    }

    // Calculate next offset
    const hasMore = !location_ids && locations.length === validatedBatchSize;
    const nextOffset = hasMore ? offset + validatedBatchSize : null;

    return new Response(
      JSON.stringify({
        success: true,
        batch_size: validatedBatchSize,
        offset,
        next_offset: nextOffset,
        total_processed: locations.length,
        dry_run,
        summary: {
          success: successCount,
          skipped: skippedCount,
          errors: errorCount,
        },
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Geocode function error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  }
});
