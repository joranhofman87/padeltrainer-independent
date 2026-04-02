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
    const url = new URL(req.url);
    const profileId = url.searchParams.get('profileId');

    if (!profileId) {
      return new Response('Missing profileId', { status: 400, headers: corsHeaders });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, rating_system')
      .eq('id', profileId)
      .single();

    if (!profile) {
      return new Response(renderFallbackSvg(), {
        headers: { ...corsHeaders, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    const ratingSystem = profile.rating_system || 'knltb';

    const { data: history } = await supabase
      .from('player_rating_history')
      .select('rating, scraped_at')
      .eq('profile_id', profileId)
      .eq('rating_system', ratingSystem)
      .order('scraped_at', { ascending: true });

    const { data: systemData } = await supabase
      .from('rating_systems')
      .select('name, lower_is_better')
      .eq('code', ratingSystem)
      .single();

    const lowerIsBetter = systemData?.lower_is_better ?? (ratingSystem === 'knltb');
    const systemName = systemData?.name || ratingSystem.toUpperCase();
    const firstName = profile.full_name?.split(' ')[0] || 'Player';

    if (!history || history.length === 0) {
      return new Response(renderFallbackSvg(), {
        headers: { ...corsHeaders, 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' },
      });
    }

    const firstRating = history[0].rating;
    const latestRating = history[history.length - 1].rating;
    const rawDiff = Number((firstRating - latestRating).toFixed(2));
    const improvement = lowerIsBetter ? rawDiff : -rawDiff;

    // Generate chart polyline
    const ratings = history.map(h => h.rating);
    const minR = Math.min(...ratings);
    const maxR = Math.max(...ratings);
    const range = maxR - minR || 1;
    
    const chartWidth = 700;
    const chartHeight = 200;
    const chartX = 250;
    const chartY = 280;

    const points = ratings.map((r, i) => {
      const x = chartX + (i / (ratings.length - 1)) * chartWidth;
      let y: number;
      if (lowerIsBetter) {
        y = chartY + ((r - minR) / range) * chartHeight;
      } else {
        y = chartY + chartHeight - ((r - minR) / range) * chartHeight;
      }
      return `${x},${y}`;
    }).join(' ');

    const fillPoints = `${chartX},${chartY + chartHeight} ${points} ${chartX + chartWidth},${chartY + chartHeight}`;

    const improvementText = improvement > 0 
      ? `↑ ${improvement.toFixed(1)} punten verbeterd`
      : improvement < 0 
        ? `↓ ${Math.abs(improvement).toFixed(1)} punten`
        : 'Geen verandering';
    const improvementColor = improvement > 0 ? '#22C55E' : improvement < 0 ? '#EF4444' : '#94A3B8';

    const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F97316" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#F97316" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)" rx="0"/>
  
  <!-- Title -->
  <text x="600" y="80" fill="#ffffff" font-size="36" font-weight="800" text-anchor="middle" font-family="system-ui, sans-serif">${escSvg(firstName)}'s Padel Rating</text>
  <text x="600" y="115" fill="#94A3B8" font-size="18" text-anchor="middle" font-family="system-ui, sans-serif">${escSvg(systemName)} Rating Journey</text>
  
  <!-- Stats -->
  <rect x="150" y="150" width="180" height="100" rx="12" fill="rgba(255,255,255,0.06)"/>
  <text x="240" y="200" fill="#ffffff" font-size="36" font-weight="800" text-anchor="middle" font-family="system-ui, sans-serif">${firstRating.toFixed(1)}</text>
  <text x="240" y="228" fill="#94A3B8" font-size="14" text-anchor="middle" font-family="system-ui, sans-serif">Start</text>
  
  <rect x="370" y="150" width="180" height="100" rx="12" fill="rgba(255,255,255,0.06)"/>
  <text x="460" y="200" fill="#ffffff" font-size="36" font-weight="800" text-anchor="middle" font-family="system-ui, sans-serif">${latestRating.toFixed(1)}</text>
  <text x="460" y="228" fill="#94A3B8" font-size="14" text-anchor="middle" font-family="system-ui, sans-serif">Nu</text>
  
  <!-- Improvement badge -->
  <rect x="600" y="165" width="350" height="50" rx="25" fill="${improvement > 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)'}"/>
  <text x="775" y="197" fill="${improvementColor}" font-size="20" font-weight="700" text-anchor="middle" font-family="system-ui, sans-serif">${escSvg(improvementText)}</text>
  
  <!-- Chart -->
  <polygon points="${fillPoints}" fill="url(#fill)"/>
  <polyline points="${points}" fill="none" stroke="#F97316" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  
  <!-- Branding -->
  <text x="600" y="575" fill="#64748B" font-size="16" text-anchor="middle" font-family="system-ui, sans-serif">Track jouw rating op <tspan fill="#F97316" font-weight="600">padeltrainer.ai</tspan></text>
</svg>`;

    return new Response(svg, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    console.error('Error generating OG image:', err);
    return new Response(renderFallbackSvg(), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'image/svg+xml' },
    });
  }
});

function escSvg(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderFallbackSvg(): string {
  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/>
      <stop offset="100%" stop-color="#16213e"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="600" y="290" fill="#ffffff" font-size="36" font-weight="800" text-anchor="middle" font-family="system-ui, sans-serif">Padel Rating Progress</text>
  <text x="600" y="340" fill="#94A3B8" font-size="20" text-anchor="middle" font-family="system-ui, sans-serif">Track your improvement on PadelTrainer.ai</text>
</svg>`;
}
