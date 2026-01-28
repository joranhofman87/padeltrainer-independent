import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface ScrapeParams {
  batch_size?: number;
  page_offset?: number;
  dry_run?: boolean;
  academy_slugs?: string[];
}

interface AcademyListItem {
  name: string;
  city: string;
  slug: string;
  logoThumb: string | null;
}

interface ExtractedData {
  website_url: string | null;
  contact_email: string | null;
  phone: string | null;
  social_instagram: string | null;
  social_facebook: string | null;
  social_linkedin: string | null;
  locations: string[];
  trainers: string[];
  specializations: string[];
}

// Generate URL-friendly slug
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// Delay helper
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call Firecrawl to scrape a URL
async function scrapeUrl(
  url: string,
  firecrawlApiKey: string
): Promise<{ success: boolean; markdown?: string; error?: string }> {
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Firecrawl error:", data);
      return { success: false, error: data.error || `HTTP ${response.status}` };
    }

    const markdown = data.data?.markdown || data.markdown;
    return { success: true, markdown };
  } catch (error) {
    console.error("Firecrawl fetch error:", error);
    return { success: false, error: String(error) };
  }
}

// Parse listing page markdown to extract academy entries from the table
function parseListingPage(markdown: string): AcademyListItem[] {
  const academies: AcademyListItem[] = [];
  const seen = new Set<string>();

  // The page has a table structure with rows like:
  // | [![Logo Name](url)\<br>Academy Name](https://padelgids.nl/padelscholen/slug/) | City | Number |
  
  // Find the table section - it starts after "| Name | City | Number of locations |"
  const tableStart = markdown.indexOf("| Name | City | Number of locations |");
  const tableEnd = markdown.indexOf("## Veelgestelde vragen");
  
  if (tableStart === -1) {
    console.log("Could not find academy table in markdown");
    return academies;
  }
  
  // Extract only the table content, excluding FAQ section
  const tableContent = tableEnd !== -1 
    ? markdown.slice(tableStart, tableEnd) 
    : markdown.slice(tableStart);
  
  // Pattern to match table rows with academy links
  // Matches: [Academy Name](https://padelgids.nl/padelscholen/slug/) | City | Number |
  const tableRowPattern = /\[([^\]]+)\]\(https:\/\/padelgids\.nl\/padelscholen\/([a-z0-9-]+)\/?\)\s*\|\s*([^|]+)\s*\|\s*(\d+)/gi;
  
  let match;
  while ((match = tableRowPattern.exec(tableContent)) !== null) {
    let name = match[1].trim();
    const slug = match[2].trim();
    const city = match[3].trim();
    
    // Clean up name - remove any remaining markdown like \<br>
    name = name.replace(/\\?<br>/gi, "").trim();
    
    // Skip if we've already seen this slug
    if (seen.has(slug)) {
      continue;
    }
    
    // Skip navigation or invalid entries
    if (
      slug === "padelscholen" ||
      slug === "toevoegen" ||
      name.toLowerCase().includes("page") ||
      name.length < 3
    ) {
      continue;
    }
    
    seen.add(slug);
    academies.push({
      name,
      city,
      slug,
      logoThumb: null,
    });
  }

  // Fallback: also try to match simpler academy link pattern within table
  // For cases where the full URL might be formatted differently
  const simplePattern = /\|\s*\[!\[.*?\].*?\n?([^\]]+)\]\((?:https:\/\/padelgids\.nl)?\/padelscholen\/([a-z0-9-]+)\/?\)\s*\|\s*([^|]+)\s*\|/gi;
  
  while ((match = simplePattern.exec(tableContent)) !== null) {
    let name = match[1].trim();
    const slug = match[2].trim();
    const city = match[3].trim();
    
    name = name.replace(/\\?<br>/gi, "").trim();
    
    if (seen.has(slug)) {
      continue;
    }
    
    if (
      slug === "padelscholen" ||
      slug === "toevoegen" ||
      name.toLowerCase().includes("page") ||
      name.length < 3
    ) {
      continue;
    }
    
    seen.add(slug);
    academies.push({
      name,
      city,
      slug,
      logoThumb: null,
    });
  }

  console.log(`Parsed ${academies.length} academies from table`);
  return academies;
}

// Call Lovable AI to extract structured data from detail page markdown
async function extractAcademyData(
  markdown: string,
  lovableApiKey: string
): Promise<ExtractedData> {
  const defaultData: ExtractedData = {
    website_url: null,
    contact_email: null,
    phone: null,
    social_instagram: null,
    social_facebook: null,
    social_linkedin: null,
    locations: [],
    trainers: [],
    specializations: [],
  };

  try {
    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Je bent een data-extractie assistent. Analyseer de markdown van een padelacademie pagina en extraheer gestructureerde data.
              
Geef je antwoord als JSON met deze structuur:
{
  "website_url": "string of null",
  "contact_email": "string of null", 
  "phone": "string of null",
  "social_instagram": "string of null",
  "social_facebook": "string of null",
  "social_linkedin": "string of null",
  "locations": ["naam van locatie/club 1", "naam van locatie/club 2"],
  "trainers": ["trainer naam 1", "trainer naam 2"],
  "specializations": ["jeugd", "beginners", "competitie", etc.]
}

Regels:
- Zoek naar website URLs (geen sociale media)
- Zoek naar email adressen
- Zoek naar telefoonnummers (Nederlands formaat)
- Zoek naar Instagram, Facebook, LinkedIn links
- Zoek naar namen van clubs/locaties waar ze lesgeven
- Zoek naar trainers/coaches namen
- Identificeer specialisaties: jeugd, beginners, gevorderden, competitie, privéles, groepsles, etc.`,
            },
            {
              role: "user",
              content: `Extraheer de data uit deze pagina:\n\n${markdown.slice(0, 8000)}`,
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "extract_academy_data",
                description: "Extract structured academy data from markdown",
                parameters: {
                  type: "object",
                  properties: {
                    website_url: { type: "string", nullable: true },
                    contact_email: { type: "string", nullable: true },
                    phone: { type: "string", nullable: true },
                    social_instagram: { type: "string", nullable: true },
                    social_facebook: { type: "string", nullable: true },
                    social_linkedin: { type: "string", nullable: true },
                    locations: {
                      type: "array",
                      items: { type: "string" },
                    },
                    trainers: {
                      type: "array",
                      items: { type: "string" },
                    },
                    specializations: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: [
                    "website_url",
                    "contact_email",
                    "phone",
                    "social_instagram",
                    "social_facebook",
                    "social_linkedin",
                    "locations",
                    "trainers",
                    "specializations",
                  ],
                },
              },
            },
          ],
          tool_choice: {
            type: "function",
            function: { name: "extract_academy_data" },
          },
        }),
      }
    );

    if (!response.ok) {
      console.error("AI extraction failed:", response.status);
      return defaultData;
    }

    const result = await response.json();
    const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];

    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      return {
        website_url: parsed.website_url || null,
        contact_email: parsed.contact_email || null,
        phone: parsed.phone || null,
        social_instagram: parsed.social_instagram || null,
        social_facebook: parsed.social_facebook || null,
        social_linkedin: parsed.social_linkedin || null,
        locations: parsed.locations || [],
        trainers: parsed.trainers || [],
        specializations: parsed.specializations || [],
      };
    }

    return defaultData;
  } catch (error) {
    console.error("AI extraction error:", error);
    return defaultData;
  }
}

// Generate unique Dutch description using Lovable AI
async function generateUniqueDescription(
  name: string,
  city: string,
  locationNames: string[],
  specializations: string[],
  lovableApiKey: string
): Promise<string> {
  try {
    const locationsText =
      locationNames.length > 0
        ? `Locaties: ${locationNames.slice(0, 5).join(", ")}`
        : "Geen specifieke locaties bekend";

    const specsText =
      specializations.length > 0
        ? `Specialisaties: ${specializations.join(", ")}`
        : "";

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content: `Je schrijft unieke, feitelijke beschrijvingen voor padelacademies in het Nederlands.

REGELS:
- Schrijf 2-3 zinnen (maximaal 100 woorden)
- Begin NIET met "Welkom bij" of andere generieke openers
- Schrijf in de derde persoon
- Maak de tekst uniek door specifieke details te noemen
- Focus op wat deze academie onderscheidt
- Wees feitelijk, niet promotioneel
- Gebruik de gegeven informatie om een authentieke beschrijving te maken`,
            },
            {
              role: "user",
              content: `Schrijf een unieke beschrijving voor deze padelacademie:

Academie: ${name}
${city ? `Stad: ${city}` : ""}
Aantal locaties: ${locationNames.length || "onbekend"}
${locationsText}
${specsText}`,
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      console.error("AI description generation failed:", response.status);
      return "";
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;

    return content?.trim() || "";
  } catch (error) {
    console.error("AI description error:", error);
    return "";
  }
}

// Main handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Validate auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const firecrawlApiKey = Deno.env.get("FIRECRAWL_API_KEY");
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");

    if (!firecrawlApiKey) {
      return new Response(
        JSON.stringify({ error: "FIRECRAWL_API_KEY not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!lovableApiKey) {
      return new Response(
        JSON.stringify({ error: "LOVABLE_API_KEY not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // Verify user and admin role
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user?.id) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = userData.user.id;

    // Check admin status using RPC
    const { data: isAdmin } = await supabase.rpc("is_admin", {
      _user_id: userId,
    });

    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse parameters
    const params: ScrapeParams = await req.json().catch(() => ({}));
    const batchSize = Math.min(params.batch_size || 10, 30);
    const pageOffset = params.page_offset || 1;
    const dryRun = params.dry_run || false;
    const specificSlugs = params.academy_slugs || [];

    console.log(
      `Starting scrape: batch=${batchSize}, page=${pageOffset}, dryRun=${dryRun}`
    );

    const results = {
      scraped: 0,
      created: 0,
      skipped: 0,
      errors: [] as string[],
      academies: [] as Array<{ name: string; slug: string; status: string }>,
    };

    let academiesToProcess: AcademyListItem[] = [];

    // If specific slugs provided, use those
    if (specificSlugs.length > 0) {
      academiesToProcess = specificSlugs.map((slug) => ({
        name: slug,
        city: "",
        slug,
        logoThumb: null,
      }));
    } else {
      // Scrape listing page
      const listingUrl = `https://padelgids.nl/padelscholen/?page=${pageOffset}`;
      console.log(`Scraping listing: ${listingUrl}`);

      const listingResult = await scrapeUrl(listingUrl, firecrawlApiKey);

      if (!listingResult.success || !listingResult.markdown) {
        return new Response(
          JSON.stringify({
            error: `Failed to scrape listing page: ${listingResult.error}`,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      academiesToProcess = parseListingPage(listingResult.markdown).slice(
        0,
        batchSize
      );
      console.log(`Found ${academiesToProcess.length} academies on page`);
    }

    // Get existing locations for matching
    const { data: existingLocations } = await supabase
      .from("locations")
      .select("id, name, city")
      .eq("is_active", true);

    const locationMap = new Map(
      (existingLocations || []).map((loc) => [
        `${loc.name.toLowerCase()}-${loc.city.toLowerCase()}`,
        loc.id,
      ])
    );

    // Process each academy
    for (const academy of academiesToProcess) {
      try {
        console.log(`Processing: ${academy.name} (${academy.slug})`);

        // Check for existing academy
        const { data: existing } = await supabase
          .from("academy_profiles")
          .select("id")
          .or(`slug.eq.${academy.slug},name.ilike.${academy.name}`)
          .maybeSingle();

        if (existing) {
          console.log(`Skipping existing: ${academy.name}`);
          results.skipped++;
          results.academies.push({
            name: academy.name,
            slug: academy.slug,
            status: "skipped (exists)",
          });
          continue;
        }

        // Rate limiting delay
        await delay(500);

        // Scrape detail page
        const detailUrl = `https://padelgids.nl/padelscholen/${academy.slug}/`;
        const detailResult = await scrapeUrl(detailUrl, firecrawlApiKey);
        results.scraped++;

        if (!detailResult.success || !detailResult.markdown) {
          console.error(
            `Failed to scrape ${academy.slug}: ${detailResult.error}`
          );
          results.errors.push(`${academy.name}: ${detailResult.error}`);
          results.academies.push({
            name: academy.name,
            slug: academy.slug,
            status: "error (scrape failed)",
          });
          continue;
        }

        // Extract structured data using AI
        await delay(200);
        const extractedData = await extractAcademyData(
          detailResult.markdown,
          lovableApiKey
        );

        // Generate unique description
        await delay(200);
        const description = await generateUniqueDescription(
          academy.name,
          academy.city || extractedData.locations[0]?.split(",").pop() || "",
          extractedData.locations,
          extractedData.specializations,
          lovableApiKey
        );

        if (dryRun) {
          console.log(`[DRY RUN] Would create: ${academy.name}`);
          console.log(`  Description: ${description.slice(0, 100)}...`);
          console.log(`  Locations: ${extractedData.locations.join(", ")}`);
          results.academies.push({
            name: academy.name,
            slug: academy.slug,
            status: "dry run (would create)",
          });
          continue;
        }

        // Insert academy profile
        const { data: newAcademy, error: insertError } = await supabase
          .from("academy_profiles")
          .insert({
            name: academy.name,
            slug: academy.slug,
            description: description || null,
            website_url: extractedData.website_url,
            contact_email: extractedData.contact_email,
            phone: extractedData.phone,
            social_instagram: extractedData.social_instagram,
            social_facebook: extractedData.social_facebook,
            social_linkedin: extractedData.social_linkedin,
            is_verified: false,
            is_public: true,
          })
          .select("id")
          .single();

        if (insertError) {
          console.error(`Insert error for ${academy.name}:`, insertError);
          results.errors.push(`${academy.name}: ${insertError.message}`);
          results.academies.push({
            name: academy.name,
            slug: academy.slug,
            status: "error (insert failed)",
          });
          continue;
        }

        // Match and link locations
        let linkedLocations = 0;
        for (const locationName of extractedData.locations) {
          // Try to find matching location
          const normalizedName = locationName.toLowerCase().trim();

          // Check exact match first
          let matchedLocationId: string | undefined;

          for (const [key, id] of locationMap.entries()) {
            if (
              key.includes(normalizedName) ||
              normalizedName.includes(key.split("-")[0])
            ) {
              matchedLocationId = id;
              break;
            }
          }

          if (matchedLocationId) {
            const { error: linkError } = await supabase
              .from("academy_locations")
              .insert({
                academy_profile_id: newAcademy.id,
                location_id: matchedLocationId,
                is_active: true,
                show_on_academy_page: true,
              });

            if (!linkError) {
              linkedLocations++;
            }
          }
        }

        console.log(
          `Created: ${academy.name} with ${linkedLocations} linked locations`
        );
        results.created++;
        results.academies.push({
          name: academy.name,
          slug: academy.slug,
          status: `created (${linkedLocations} locations linked)`,
        });
      } catch (error) {
        console.error(`Error processing ${academy.name}:`, error);
        results.errors.push(`${academy.name}: ${String(error)}`);
        results.academies.push({
          name: academy.name,
          slug: academy.slug,
          status: "error (exception)",
        });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        page: pageOffset,
        batch_size: batchSize,
        dry_run: dryRun,
        ...results,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Scrape academies error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
