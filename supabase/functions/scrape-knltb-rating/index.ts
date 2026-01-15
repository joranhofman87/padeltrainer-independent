const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { knltbNumber } = await req.json();

    if (!knltbNumber) {
      return new Response(
        JSON.stringify({ success: false, error: 'KNLTB number is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
    if (!apiKey) {
      console.error('FIRECRAWL_API_KEY not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Scraper not configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // KNLTB player profile URL pattern
    const profileUrl = `https://mijnknltb.toernooi.nl/player/${knltbNumber}`;
    
    console.log('Scraping KNLTB profile:', profileUrl);

    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: profileUrl,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor: 3000, // Wait for dynamic content to load
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Firecrawl API error:', data);
      return new Response(
        JSON.stringify({ success: false, error: data.error || 'Failed to scrape profile' }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse the markdown content to extract rating
    const markdown = data.data?.markdown || data.markdown || '';
    
    // Look for padel rating patterns in the content
    // Common patterns: "Padel: 7.0", "Rating: 7.0", "Enkelspel: 7.0"
    const ratingPatterns = [
      /padel[:\s]+(\d+\.?\d*)/i,
      /rating[:\s]+(\d+\.?\d*)/i,
      /enkelspel[:\s]+(\d+\.?\d*)/i,
      /dubbelspel[:\s]+(\d+\.?\d*)/i,
      /speelsterkte[:\s]+(\d+\.?\d*)/i,
      /(\d+\.\d+)\s*(?:padel|rating)/i,
    ];

    let rating: number | null = null;
    for (const pattern of ratingPatterns) {
      const match = markdown.match(pattern);
      if (match && match[1]) {
        const parsed = parseFloat(match[1]);
        if (parsed >= 1 && parsed <= 10) {
          rating = parsed;
          break;
        }
      }
    }

    if (rating) {
      console.log('Found KNLTB rating:', rating);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            knltbNumber,
            rating,
            source: 'knltb',
            scrapedAt: new Date().toISOString(),
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // If we couldn't parse a rating, return the raw content for debugging
    console.log('Could not parse rating from content');
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Could not find rating in profile',
        debug: markdown.substring(0, 500), // First 500 chars for debugging
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