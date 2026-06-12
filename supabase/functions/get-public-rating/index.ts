import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Best-effort per-key throttle on the shared rate_limits table (same pattern
 * as send-auth-email). Returns true when the call is allowed (under `max`
 * within `windowMin` minutes). Fails OPEN on storage errors so a transient DB
 * hiccup never breaks legitimate public rating pages.
 */
async function throttle(
  admin: ReturnType<typeof createClient>,
  identifier: string,
  max: number,
  windowMin: number,
): Promise<boolean> {
  const windowStart = new Date(Date.now() - windowMin * 60 * 1000);
  try {
    const { data: existing } = await admin
      .from("rate_limits")
      .select("id, request_count, window_start")
      .eq("identifier", identifier)
      .eq("endpoint", "get-public-rating")
      .maybeSingle();

    if (existing && new Date(existing.window_start) > windowStart) {
      if (existing.request_count >= max) return false;
      await admin
        .from("rate_limits")
        .update({ request_count: existing.request_count + 1 })
        .eq("id", existing.id);
      return true;
    }

    await admin
      .from("rate_limits")
      .upsert(
        { identifier, endpoint: "get-public-rating", request_count: 1, window_start: new Date().toISOString() },
        { onConflict: "identifier,endpoint" },
      );
    return true;
  } catch (_err) {
    return true; // fail open
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { profileId } = await req.json();
    // Reject malformed IDs before they reach Postgres (invalid uuid casts error there).
    if (!profileId || typeof profileId !== 'string' || !UUID_RE.test(profileId)) {
      return new Response(JSON.stringify({ error: 'Invalid profileId' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Anti-abuse: unauthenticated lookup of player data by UUID — cap per IP
    // so leaked/guessed UUIDs can't be bulk-harvested.
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      req.headers.get("cf-connecting-ip") || "unknown";
    const ipOk = await throttle(supabase, `ip:${clientIp}`, 60, 60);
    if (!ipOk) {
      return new Response(
        JSON.stringify({ error: 'Too many requests. Please try again later.' }),
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '3600' } },
      );
    }

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

    // PII minimization: the public rating card only ever shows the first
    // name, so don't hand out the full name on an unauthenticated endpoint.
    const firstName = profile.full_name?.trim().split(/\s+/)[0] || 'Player';

    return new Response(JSON.stringify({
      player_name: firstName,
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
