import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Location {
  id: string;
  name: string;
  city: string;
  street_address: string | null;
  website_url: string | null;
  indoor_courts: number | null;
  outdoor_courts: number | null;
}

interface EnrichmentResult {
  location_id: string;
  location_name: string;
  status: "success" | "skipped" | "error";
  error?: string;
  data?: {
    indoor_courts: number;
    outdoor_courts: number;
    description: string;
    logo_url: string | null;
  };
}

async function callLovableAI(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) {
    throw new Error("LOVABLE_API_KEY not configured");
  }

  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI Gateway error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function scrapeWebsite(url: string): Promise<{ markdown: string; logoUrl: string | null } | null> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY not configured");
  }

  let formattedUrl = url.trim();
  if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
    formattedUrl = `https://${formattedUrl}`;
  }

  console.log("Scraping URL:", formattedUrl);

  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: formattedUrl,
      formats: ["markdown", "branding"],
      onlyMainContent: false, // Get full page to capture "Over de club" sections
      waitFor: 3000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Firecrawl error:", errorText);
    return null;
  }

  const data = await response.json();
  const markdown = data.data?.markdown || data.markdown || "";
  const logoUrl = data.data?.branding?.images?.logo || data.branding?.images?.logo || null;

  // Log first 500 chars of scraped content for debugging
  console.log("Scraped content preview:", markdown.substring(0, 500));
  
  // Also check if padel is mentioned
  const padelMentions = (markdown.match(/padel/gi) || []).length;
  console.log(`Found ${padelMentions} mentions of 'padel' in content`);

  return { markdown, logoUrl };
}

async function extractPadelCourts(websiteContent: string): Promise<{ indoor_courts: number; outdoor_courts: number }> {
  const prompt = `Analyze this Dutch club website content and extract the number of PADEL courts.

CRITICAL RULES:
1. ONLY count PADEL courts (padelbanen) - COMPLETELY IGNORE tennis, squash, smashcourt, or other sports
2. Dutch terms for padel: "padelbanen", "padelcourts", "padelvelden", "padel banen", "padel court"
3. For INDOOR padel: "overdekt", "indoor", "binnen", "hal", "overdekte padelbanen"
4. For OUTDOOR padel: "buiten", "outdoor", "buitenbanen" 
5. DEFAULT RULE: If padel courts are mentioned WITHOUT specifying indoor/outdoor → count them as OUTDOOR
6. smashcourtbanen = tennis courts, NOT padel - ignore these completely

IMPORTANT: Look for patterns like:
- "vier padelbanen" = 4 padel courts (outdoor since no indoor specified)
- "8 smashcourtbanen en 4 padelbanen" = ONLY count the 4 padelbanen, ignore the 8 smashcourt
- "2 overdekte padelbanen" = 2 indoor padel courts

Return ONLY valid JSON: { "indoor_courts": number, "outdoor_courts": number }

Website content:
${websiteContent.substring(0, 6000)}`;

  const response = await callLovableAI(prompt);
  
  // Extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    console.error("Failed to extract JSON from AI response:", response);
    return { indoor_courts: 0, outdoor_courts: 0 };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      indoor_courts: parseInt(parsed.indoor_courts) || 0,
      outdoor_courts: parseInt(parsed.outdoor_courts) || 0,
    };
  } catch (e) {
    console.error("Failed to parse court counts:", e);
    return { indoor_courts: 0, outdoor_courts: 0 };
  }
}

async function generateDescription(
  name: string,
  city: string,
  address: string | null,
  indoorCourts: number,
  outdoorCourts: number,
  websiteContent: string
): Promise<string> {
  const totalCourts = indoorCourts + outdoorCourts;
  const courtInfo = totalCourts > 0
    ? `${indoorCourts} overdekte en ${outdoorCourts} buitenbanen`
    : "padelbanen";

  const prompt = `Schrijf een feitelijke beschrijving (2-3 zinnen, max 150 woorden) over deze padelclub in het Nederlands.

REGELS:
- Begin NIET met "Welkom bij" of andere welkomstzinnen
- Gebruik GEEN generieke gastvrijheidstaal
- Schrijf in de derde persoon over de club
- Focus ALLEEN op padelfaciliteiten, niet op tennis
- Noem: aantal padelbanen (${courtInfo}), locatie, eventuele padel-specifieke diensten
- Wees feitelijk en informatief

Club: ${name}
Stad: ${city}
Adres: ${address || "onbekend"}
Padelbanen: ${indoorCourts} overdekt, ${outdoorCourts} buiten
Website inhoud (voor context):
${websiteContent.substring(0, 2000)}`;

  const response = await callLovableAI(prompt);
  return response.trim();
}

async function uploadLogo(
  supabase: SupabaseClient,
  locationId: string,
  logoUrl: string
): Promise<string | null> {
  try {
    console.log("Downloading logo from:", logoUrl);
    
    const response = await fetch(logoUrl);
    if (!response.ok) {
      console.error("Failed to download logo:", response.status);
      return null;
    }

    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    const extension = logoUrl.split(".").pop()?.split("?")[0] || "png";
    const filePath = `clubs/${locationId}/logo.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, uint8Array, {
        contentType: blob.type || "image/png",
        upsert: true,
      });

    if (uploadError) {
      console.error("Failed to upload logo:", uploadError);
      return null;
    }

    const { data: { publicUrl } } = supabase.storage
      .from("avatars")
      .getPublicUrl(filePath);

    return publicUrl;
  } catch (error) {
    console.error("Error uploading logo:", error);
    return null;
  }
}

async function processLocation(
  supabase: SupabaseClient,
  location: Location,
  dryRun: boolean
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    location_id: location.id,
    location_name: location.name,
    status: "success",
  };

  try {
    // Skip if no website URL
    if (!location.website_url) {
      result.status = "skipped";
      result.error = "No website URL";
      return result;
    }

    // Step 1: Scrape the website
    console.log(`Processing: ${location.name}`);
    const scrapeResult = await scrapeWebsite(location.website_url);
    
    if (!scrapeResult || !scrapeResult.markdown) {
      result.status = "error";
      result.error = "Failed to scrape website";
      return result;
    }

    // Step 2: Extract padel court counts
    const courts = await extractPadelCourts(scrapeResult.markdown);
    console.log(`Extracted courts for ${location.name}:`, courts);

    // Step 3: Generate description
    const description = await generateDescription(
      location.name,
      location.city,
      location.street_address,
      courts.indoor_courts,
      courts.outdoor_courts,
      scrapeResult.markdown
    );
    console.log(`Generated description for ${location.name}:`, description.substring(0, 100));

    // Step 4: Upload logo (if found)
    let storedLogoUrl: string | null = null;
    if (scrapeResult.logoUrl && !dryRun) {
      storedLogoUrl = await uploadLogo(supabase, location.id, scrapeResult.logoUrl);
    }

    result.data = {
      indoor_courts: courts.indoor_courts,
      outdoor_courts: courts.outdoor_courts,
      description,
      logo_url: storedLogoUrl || scrapeResult.logoUrl,
    };

    // Step 5: Update database (if not dry run)
    if (!dryRun) {
      // Update locations table with court counts
      const { error: locError } = await supabase
        .from("locations")
        .update({
          indoor_courts: courts.indoor_courts,
          outdoor_courts: courts.outdoor_courts,
        })
        .eq("id", location.id);

      if (locError) {
        console.error("Error updating location:", locError);
      }

      // Check if club_profile exists for this location
      const { data: existingProfile } = await supabase
        .from("club_profiles")
        .select("id")
        .eq("location_id", location.id)
        .single();

      if (existingProfile) {
        // Update existing club_profile
        const { error: profileError } = await supabase
          .from("club_profiles")
          .update({
            description,
            logo_url: storedLogoUrl,
          })
          .eq("location_id", location.id);

        if (profileError) {
          console.error("Error updating club_profile:", profileError);
        }
      }
      // Note: We don't create new club_profiles as that requires user_id
    }

    return result;
  } catch (error) {
    result.status = "error";
    result.error = error instanceof Error ? error.message : "Unknown error";
    console.error(`Error processing ${location.name}:`, error);
    return result;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Parse request body
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(body.batch_size || 10, 50);
    const offset = body.offset || 0;
    const dryRun = body.dry_run === true;
    const locationIds: string[] | undefined = body.location_ids;

    console.log(`Starting enrichment - batch_size: ${batchSize}, offset: ${offset}, dry_run: ${dryRun}`);

    // Fetch locations to process
    let query = supabase
      .from("locations")
      .select("id, name, city, street_address, website_url, indoor_courts, outdoor_courts")
      .not("website_url", "is", null)
      .order("name", { ascending: true });

    if (locationIds && locationIds.length > 0) {
      query = query.in("id", locationIds);
    } else {
      query = query.range(offset, offset + batchSize - 1);
    }

    const { data: locations, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch locations: ${fetchError.message}`);
    }

    if (!locations || locations.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "No locations to process",
          results: [],
          total_processed: 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${locations.length} locations...`);

    // Process each location with a delay to avoid rate limits
    const results: EnrichmentResult[] = [];
    for (const location of locations) {
      const result = await processLocation(supabase, location as Location, dryRun);
      results.push(result);

      // Add delay between requests to avoid rate limits (reduced for faster processing)
      if (locations.indexOf(location) < locations.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const summary = {
      success: results.filter((r) => r.status === "success").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
    };

    console.log("Enrichment complete:", summary);

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        batch_size: batchSize,
        offset,
        next_offset: offset + locations.length,
        total_processed: locations.length,
        summary,
        results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Enrichment error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
