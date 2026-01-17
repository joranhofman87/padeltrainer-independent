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

    if (!firecrawlApiKey) {
      console.error('FIRECRAWL_API_KEY not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Scraper not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Scraping KNLTB rating for:', knltbNumber);

    // Try the public KNLTB profile URL directly - no login needed
    // The KNLTB has a public search that shows basic player info
    const profileUrl = `https://www.knltb.nl/mijnknltb/leden/zoeken?q=${knltbNumber}`;
    
    console.log('Scraping URL:', profileUrl);

    const scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: profileUrl,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor: 5000,
        actions: [
          { type: 'wait', milliseconds: 3000 },
          { type: 'scrape' }
        ],
      }),
    });

    const scrapeData = await scrapeResponse.json();
    
    if (!scrapeResponse.ok || !scrapeData.success) {
      console.error('Firecrawl scrape failed:', scrapeData);
      
      // Try alternative: direct padel rating lookup
      console.log('Trying alternative padel API...');
      const altResult = await tryPadelRatingLookup(knltbNumber, firecrawlApiKey);
      
      if (altResult.success && altResult.rating) {
        return await handleSuccessfulRating(altResult.rating, knltbNumber, profileId, storeHistory, corsHeaders);
      }
      
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: scrapeData.error || 'Failed to scrape KNLTB profile',
          suggestion: 'Please enter your rating manually'
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    
    console.log('KNLTB scraped, content length:', markdown.length);
    console.log('Content preview:', markdown.substring(0, 500));
    
    const rating = extractPadelRating(markdown);
    
    if (rating) {
      return await handleSuccessfulRating(rating, knltbNumber, profileId, storeHistory, corsHeaders);
    }
    
    // If no rating found in main scrape, try alternative
    console.log('No rating in main scrape, trying alternative...');
    const altResult = await tryPadelRatingLookup(knltbNumber, firecrawlApiKey);
    
    if (altResult.success && altResult.rating) {
      return await handleSuccessfulRating(altResult.rating, knltbNumber, profileId, storeHistory, corsHeaders);
    }
    
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Could not find padel dubbel rating.',
        suggestion: 'Please enter your rating manually on your profile page',
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

async function tryPadelRatingLookup(knltbNumber: string, firecrawlApiKey: string): Promise<{ success: boolean; rating?: number }> {
  try {
    // Try the padel-specific ranking page
    const padelUrl = `https://www.padelbanen.nl/speler/${knltbNumber}`;
    
    console.log('Trying padel lookup at:', padelUrl);
    
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: padelUrl,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor: 3000,
      }),
    });
    
    const data = await response.json();
    
    if (response.ok && data.success) {
      const markdown = data.data?.markdown || data.markdown || '';
      console.log('Padel lookup content:', markdown.substring(0, 300));
      const rating = extractPadelRating(markdown);
      if (rating) {
        return { success: true, rating };
      }
    }
    
    return { success: false };
  } catch (err) {
    console.error('Alternative lookup failed:', err);
    return { success: false };
  }
}

async function handleSuccessfulRating(
  rating: number, 
  knltbNumber: string, 
  profileId: string | undefined, 
  storeHistory: boolean,
  corsHeaders: Record<string, string>
): Promise<Response> {
  console.log('Found padel rating:', rating);
  
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

function extractPadelRating(markdown: string): number | null {
  // Normalize the text
  const normalized = markdown
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();

  console.log('Extracting rating from normalized text sample:', normalized.substring(0, 200));

  // Various patterns for finding padel dubbel ratings
  const patterns = [
    // "Padel Dubbel" followed by rating like 4.48 or 4,48
    /padel\s*dubbel[:\s\|]*(\d+)[,.](\d{2,4})/i,
    // Speelsterkte rating
    /speelsterkte[:\s]*(\d+)[,.](\d{2,4})/i,
    // Rating with "dubbel" context
    /dubbel[:\s\|]*(\d+)[,.](\d{2,4})/i,
    // Explicit "rating" label
    /rating[:\s]*(\d+)[,.](\d{2,4})/i,
    // Padel context with rating
    /padel[:\s]*(\d+)[,.](\d{2,4})/i,
    // Standalone rating format (common in tables) - e.g. 4.48 or 4,4803
    /\b(\d)[,.](\d{2,4})\b/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match && match[1] && match[2]) {
      const intPart = parseInt(match[1]);
      const decPart = match[2];
      // For rating like 4,4803 - the rating is 4.48 (first 2 decimal places)
      const rating = parseFloat(`${intPart}.${decPart.substring(0, 2)}`);
      
      // Valid KNLTB padel rating range is roughly 1.0 to 9.9
      if (rating >= 1 && rating <= 10) {
        console.log('Matched rating:', rating, 'from pattern:', pattern);
        return rating;
      }
    }
  }

  return null;
}
