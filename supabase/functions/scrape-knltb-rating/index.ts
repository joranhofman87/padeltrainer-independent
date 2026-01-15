const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { knltbNumber, profileUrl: providedUrl } = await req.json();

    if (!knltbNumber && !providedUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'KNLTB number or profile URL is required' }),
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

    // If a profile URL was provided, extract UUID and use it
    let profileUrl = providedUrl;
    if (profileUrl && profileUrl.includes('player-profile/')) {
      // User provided their profile URL directly
      console.log('Using provided profile URL:', profileUrl);
    } else if (knltbNumber) {
      // Try to search for the player - but this is limited due to cookie consent
      // For now, inform user they need to provide their profile URL
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Automatic lookup is not available due to KNLTB website restrictions.',
          suggestion: 'Please provide your KNLTB profile URL or enter your rating manually.',
          instructions: 'Go to mijnknltb.toernooi.nl, search for yourself, and copy your profile URL',
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!profileUrl) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Profile URL is required for rating lookup',
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Scraping profile:', profileUrl);

    // Scrape the profile page
    const scrapeResponse = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: profileUrl,
        formats: ['markdown'],
        onlyMainContent: false,
        waitFor: 5000,
      }),
    });

    const scrapeData = await scrapeResponse.json();
    
    if (!scrapeResponse.ok) {
      console.error('Scrape failed:', scrapeData);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: scrapeData.error || 'Failed to scrape profile' 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    const markdown = scrapeData.data?.markdown || scrapeData.markdown || '';
    
    console.log('Profile scraped, content length:', markdown.length);
    console.log('Content sample:', markdown.substring(0, 500));
    
    // Check if we hit the cookie consent page
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
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            knltbNumber: knltbNumber || 'unknown',
            rating,
            source: 'knltb',
            profileUrl,
            scrapedAt: new Date().toISOString(),
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    return new Response(
      JSON.stringify({
        success: false,
        error: 'Could not find padel dubbel rating on profile. The page may require login.',
        suggestion: 'Please enter your rating manually',
        debug: markdown.substring(0, 500),
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
    // Rating in a table context
    /(\d+)[,.](\d{4})/i, // Matches 4,4803 format specifically
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