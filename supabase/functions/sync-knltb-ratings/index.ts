import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface SyncResult {
  profileId: string;
  knltbNumber: string;
  fullName: string | null;
  success: boolean;
  rating?: number;
  error?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log('Starting monthly KNLTB rating sync...');

    // Get all profiles with KNLTB numbers and KNLTB rating system
    const { data: profiles, error: fetchError } = await supabase
      .from('profiles')
      .select('id, knltb_number, full_name, rating_system')
      .not('knltb_number', 'is', null)
      .neq('knltb_number', '')
      .eq('rating_system', 'knltb');

    if (fetchError) {
      console.error('Failed to fetch profiles:', fetchError);
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to fetch profiles' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!profiles || profiles.length === 0) {
      console.log('No profiles with KNLTB numbers found');
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'No profiles with KNLTB numbers to sync',
          results: [] 
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`Found ${profiles.length} profiles to sync`);

    const results: SyncResult[] = [];
    const baseUrl = supabaseUrl.replace('https://', '').split('.')[0];
    const scrapeUrl = `${supabaseUrl}/functions/v1/scrape-knltb-rating`;

    // Process profiles sequentially to avoid overwhelming the KNLTB website
    for (const profile of profiles) {
      console.log(`Syncing rating for ${profile.full_name || profile.id} (KNLTB: ${profile.knltb_number})`);

      try {
        // Call the scrape function for each profile
        const scrapeResponse = await fetch(scrapeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseServiceKey}`,
          },
          body: JSON.stringify({
            knltbNumber: profile.knltb_number,
            profileId: profile.id,
            storeHistory: true,
          }),
        });

        const scrapeResult = await scrapeResponse.json();

        if (scrapeResult.success && scrapeResult.data?.rating) {
          results.push({
            profileId: profile.id,
            knltbNumber: profile.knltb_number!,
            fullName: profile.full_name,
            success: true,
            rating: scrapeResult.data.rating,
          });
          console.log(`✓ Synced rating for ${profile.full_name}: ${scrapeResult.data.rating}`);
        } else {
          results.push({
            profileId: profile.id,
            knltbNumber: profile.knltb_number!,
            fullName: profile.full_name,
            success: false,
            error: scrapeResult.error || 'Unknown error',
          });
          console.log(`✗ Failed to sync rating for ${profile.full_name}: ${scrapeResult.error}`);
        }

        // Add a delay between requests to be respectful to the KNLTB website
        await new Promise(resolve => setTimeout(resolve, 5000));

      } catch (profileError) {
        console.error(`Error syncing profile ${profile.id}:`, profileError);
        results.push({
          profileId: profile.id,
          knltbNumber: profile.knltb_number!,
          fullName: profile.full_name,
          success: false,
          error: profileError instanceof Error ? profileError.message : 'Unknown error',
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`Sync complete. Success: ${successCount}, Failed: ${failCount}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Synced ${successCount} of ${profiles.length} profiles`,
        stats: {
          total: profiles.length,
          success: successCount,
          failed: failCount,
        },
        results,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in sync-knltb-ratings:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
