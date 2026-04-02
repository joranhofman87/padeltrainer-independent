import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { profileId } = await req.json();
    if (!profileId || typeof profileId !== 'string') {
      return new Response(JSON.stringify({ error: 'profileId required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Fetch profile (only public-safe fields)
    const { data: profile, error: profileErr } = await supabase
      .from('profiles')
      .select('full_name, skill_rating, rating_system')
      .eq('id', profileId)
      .single();

    if (profileErr || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const ratingSystem = profile.rating_system || 'knltb';

    // Fetch rating history
    const { data: history } = await supabase
      .from('player_rating_history')
      .select('rating, scraped_at')
      .eq('profile_id', profileId)
      .eq('rating_system', ratingSystem)
      .order('scraped_at', { ascending: true });

    if (!history || history.length === 0) {
      return new Response(JSON.stringify({ error: 'No rating history' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch system name
    const { data: systemData } = await supabase
      .from('rating_systems')
      .select('name, lower_is_better')
      .eq('code', ratingSystem)
      .single();

    return new Response(JSON.stringify({
      player_name: profile.full_name || 'Player',
      rating_system: ratingSystem,
      system_name: systemData?.name || ratingSystem.toUpperCase(),
      lower_is_better: systemData?.lower_is_better ?? (ratingSystem === 'knltb'),
      history,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Error in get-public-rating:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
