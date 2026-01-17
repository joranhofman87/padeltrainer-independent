import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { knltbNumber, profileId, storeHistory = false } = await req.json();

    if (!knltbNumber) {
      return new Response(
        JSON.stringify({ success: false, error: 'KNLTB number is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const firecrawlApiKey = Deno.env.get('FIRECRAWL_API_KEY');
    const knltbUsername = Deno.env.get('KNLTB_USERNAME');
    const knltbPassword = Deno.env.get('KNLTB_PASSWORD');

    if (!firecrawlApiKey) {
      console.error('FIRECRAWL_API_KEY not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Scraper not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!knltbUsername || !knltbPassword) {
      console.error('KNLTB credentials not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'KNLTB credentials not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Scraping KNLTB rating for:', knltbNumber);

    // Use Firecrawl with actions to automate login and search
    const scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://mijnknltb.toernooi.nl/',
        formats: ['markdown'],
        onlyMainContent: false,
        waitFor: 3000,
        actions: [
          // Wait for page load
          { type: 'wait', milliseconds: 2000 },
          // Accept cookies if present
          { type: 'click', selector: 'button[id*="accept"], button[class*="accept"], .cookie-accept, #onetrust-accept-btn-handler', timeout: 3000 },
          { type: 'wait', milliseconds: 1000 },
          // Enter username
          { type: 'write', text: knltbUsername, selector: 'input[name="username"], input[name="email"], input[id="username"], input[type="email"]' },
          // Enter password  
          { type: 'write', text: knltbPassword, selector: 'input[name="password"], input[type="password"], input[id="password"]' },
          // Click login button
          { type: 'click', selector: 'button[type="submit"], input[type="submit"], button[class*="login"], .login-button' },
          { type: 'wait', milliseconds: 5000 },
          // Navigate to search or use search bar
          { type: 'write', text: knltbNumber, selector: 'input[type="search"], input[name="search"], input[placeholder*="zoek"], input[class*="search"]' },
          { type: 'click', selector: 'button[type="submit"], .search-button, button[class*="search"]' },
          { type: 'wait', milliseconds: 5000 },
          // Click on first search result (player profile link)
          { type: 'click', selector: 'a[href*="player-profile"], .player-link, .search-result a' },
          { type: 'wait', milliseconds: 3000 },
          { type: 'scrape' }
        ],
      }),
    });

    const scrapeData = await scrapeResponse.json();
    
    if (!scrapeResponse.ok) {
      console.error('Firecrawl scrape failed:', scrapeData);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: scrapeData.error || 'Failed to scrape KNLTB profile' 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    
    console.log('KNLTB scraped, content length:', markdown.length);
    console.log('Content sample:', markdown.substring(0, 800));
    
    // Check if we're still on login page
    if (markdown.toLowerCase().includes('inloggen') && markdown.toLowerCase().includes('wachtwoord')) {
      console.error('Still on login page - authentication may have failed');
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Authentication failed. Please check KNLTB credentials.',
          suggestion: 'Please enter your rating manually',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    // Check for cookie consent page
    if (markdown.toLowerCase().includes('cookies') && markdown.toLowerCase().includes('akkoord')) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'The KNLTB website requires cookie consent which blocks automated access.',
          suggestion: 'Please enter your padel dubbel rating manually (e.g., 4.48)',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const rating = extractPadelRating(markdown);
    
    if (rating) {
      console.log('Found padel rating:', rating);
      
      // Store in history if requested and profileId provided
      if (storeHistory && profileId) {
        try {
          const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
          const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
          const supabase = createClient(supabaseUrl, supabaseServiceKey);
          
          // Insert into rating history
          const { error: historyError } = await supabase
            .from('player_rating_history')
            .insert({
              profile_id: profileId,
              rating: rating,
              rating_system: 'knltb',
              source: 'knltb_scrape',
              scraped_at: new Date().toISOString(),
            });
          
          if (historyError) {
            console.error('Failed to store rating history:', historyError);
          } else {
            console.log('Rating history stored successfully');
          }
          
          // Update profile with latest rating
          const { error: profileError } = await supabase
            .from('profiles')
            .update({
              skill_rating: rating,
              rating_system: 'knltb',
            })
            .eq('id', profileId);
          
          if (profileError) {
            console.error('Failed to update profile:', profileError);
          } else {
            console.log('Profile updated with new rating');
          }
        } catch (dbError) {
          console.error('Database error:', dbError);
        }
      }
      
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            knltbNumber,
            rating,
            source: 'knltb_scrape',
            scrapedAt: new Date().toISOString(),
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Could not find padel dubbel rating on profile.',
        suggestion: 'Please enter your rating manually',
        debug: markdown.substring(0, 1000),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error scraping KNLTB:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

function extractPadelRating(markdown: string): number | null {
  // Normalize the text
  const normalized = markdown
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ');

  // Various patterns for finding padel dubbel ratings
  // Format: "4,4803" (European decimal) - we want 4.48
  const patterns = [
    // "Padel Dubbel" followed by rating
    /padel\s*dubbel[:\s\|]*(\d+)[,.](\d+)/i,
    // Table row format with dubbel
    /dubbel[:\s\|]*(\d+)[,.](\d+)/i,
    // Generic padel rating
    /padel[:\s]*(\d+)[,.](\d+)/i,
    // Speelsterkte rating
    /speelsterkte[:\s]*(\d+)[,.](\d+)/i,
    // Rating in a table context - matches 4,4803 format specifically
    /(\d+)[,.](\d{4})/i,
    // Standard rating format like 4.48 or 4,48
    /rating[:\s]*(\d+)[,.](\d{2,4})/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1] && match[2]) {
      const intPart = parseInt(match[1]);
      const decPart = match[2];
      // For rating like 4,4803 - the rating is 4.48 (first 2 decimal places)
      const rating = parseFloat(`${intPart}.${decPart.substring(0, 2)}`);
      
      if (rating >= 1 && rating <= 10) {
        return rating;
      }
    }
  }

  return null;
}
