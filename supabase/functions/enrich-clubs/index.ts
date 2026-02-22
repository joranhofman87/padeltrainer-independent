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
  description: string | null;
  phone: string | null;
  email: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  opening_hours: string | null;
  logo_url: string | null;
}

interface ExtractedData {
  indoor_courts: number;
  outdoor_courts: number;
  description: string;
  phone: string | null;
  email: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  opening_hours: string | null;
}

interface DetectedAcademy {
  name: string;
  website_url: string | null;
  description: string | null;
  contact_email: string | null;
  phone: string | null;
  social_facebook: string | null;
  social_instagram: string | null;
  social_linkedin: string | null;
  social_youtube: string | null;
  social_tiktok: string | null;
}

interface EnrichmentResult {
  location_id: string;
  location_name: string;
  status: "success" | "skipped" | "error";
  error?: string;
  fields_updated?: string[];
  data?: ExtractedData & { logo_url: string | null };
  academy_created?: string;
}

async function callLovableAI(prompt: string): Promise<string> {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

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

async function scrapeWebsite(url: string): Promise<{ markdown: string; links: string[]; logoUrl: string | null } | null> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY not configured");

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
      formats: ["markdown", "links", "branding"],
      onlyMainContent: false,
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
  const links: string[] = data.data?.links || data.links || [];
  const logoUrl = data.data?.branding?.images?.logo || data.branding?.images?.logo || null;

  console.log("Scraped content length:", markdown.length, "links:", links.length);

  return { markdown, links, logoUrl };
}

function extractSocialFromLinks(links: string[]): { facebook_url: string | null; instagram_url: string | null; linkedin_url: string | null; youtube_url: string | null; tiktok_url: string | null } {
  let facebook_url: string | null = null;
  let instagram_url: string | null = null;
  let linkedin_url: string | null = null;
  let youtube_url: string | null = null;
  let tiktok_url: string | null = null;

  for (const link of links) {
    if (!facebook_url && link.includes("facebook.com/") && !link.includes("sharer")) {
      facebook_url = link;
    }
    if (!instagram_url && link.includes("instagram.com/") && !link.includes("/p/")) {
      instagram_url = link;
    }
    if (!linkedin_url && link.includes("linkedin.com/")) {
      linkedin_url = link;
    }
    if (!youtube_url && (link.includes("youtube.com/") || link.includes("youtu.be/"))) {
      youtube_url = link;
    }
    if (!tiktok_url && link.includes("tiktok.com/")) {
      tiktok_url = link;
    }
  }

  return { facebook_url, instagram_url, linkedin_url, youtube_url, tiktok_url };
}

async function extractAllFields(
  websiteContent: string,
  links: string[],
  locationName: string,
  city: string,
  address: string | null,
  missingFields: string[]
): Promise<ExtractedData> {
  const socialFromLinks = extractSocialFromLinks(links);

  const prompt = `Analyze this club website content and extract information about this PADEL club.
Return ONLY valid JSON with these fields. Use null for any field you cannot find.

{
  "indoor_courts": number (ONLY padel courts marked as indoor/overdekt/binnen, default outdoor if unspecified),
  "outdoor_courts": number (ONLY padel courts, ignore tennis/squash/smashcourt),
  "description": "2-3 sentence factual description in Dutch about this padel club. Write in third person. Do NOT start with 'Welkom'. Focus on padel facilities only.",
  "phone": "phone number string or null",
  "email": "email address string or null",
  "facebook_url": "facebook page URL or null",
  "instagram_url": "instagram profile URL or null",
  "opening_hours": "opening hours as a compact string or null (e.g. 'Ma-Vr 08:00-23:00, Za-Zo 08:00-22:00')"
}

IMPORTANT RULES:
- ONLY count PADEL courts (padelbanen), NOT tennis, squash, or smashcourt
- Dutch terms: "padelbanen", "padelcourts", "padelvelden"
- Indoor: "overdekt", "indoor", "binnen", "hal"
- Outdoor: "buiten", "outdoor", "buitenbanen"
- If padel courts mentioned WITHOUT indoor/outdoor → count as OUTDOOR
- smashcourtbanen = tennis, NOT padel
- For description: write in Dutch, 2-3 sentences, max 150 words, third person, factual
- Only extract fields we need: ${missingFields.join(", ")}
- For fields not in the missing list, you can still extract them but they won't be used

Club: ${locationName}
City: ${city}
Address: ${address || "unknown"}

Website content:
${websiteContent.substring(0, 8000)}`;

  const response = await callLovableAI(prompt);

  const jsonMatch = response.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    console.error("Failed to extract JSON from AI response:", response.substring(0, 200));
    return {
      indoor_courts: 0, outdoor_courts: 0, description: "",
      phone: null, email: null, facebook_url: null, instagram_url: null, opening_hours: null,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      indoor_courts: parseInt(parsed.indoor_courts) || 0,
      outdoor_courts: parseInt(parsed.outdoor_courts) || 0,
      description: parsed.description || "",
      phone: parsed.phone || null,
      email: parsed.email || null,
      facebook_url: parsed.facebook_url || socialFromLinks.facebook_url || null,
      instagram_url: parsed.instagram_url || socialFromLinks.instagram_url || null,
      opening_hours: parsed.opening_hours || null,
    };
  } catch (e) {
    console.error("Failed to parse AI response:", e);
    return {
      indoor_courts: 0, outdoor_courts: 0, description: "",
      phone: null, email: null,
      facebook_url: socialFromLinks.facebook_url, instagram_url: socialFromLinks.instagram_url,
      opening_hours: null,
    };
  }
}

async function detectAcademy(
  websiteContent: string,
  links: string[],
  locationName: string,
  city: string
): Promise<DetectedAcademy | null> {
  const prompt = `Analyze this padel club website. Is there a PADEL ACADEMY or TRAINING SCHOOL mentioned that operates at this location?

Look for:
- Named academies (e.g. "Padel Time Academy", "Dutch Padel Academy")
- Training programs run by a separate organization
- Partnerships with padel schools or training institutes
- NOT the club's own lesson offerings (e.g. "we offer padel lessons" is NOT an academy)
- The academy must be a SEPARATE ENTITY with its own name, not just a club feature

Club: ${locationName}
City: ${city}

Website content:
${websiteContent.substring(0, 8000)}

If an academy is found, return ONLY valid JSON:
{
  "found": true,
  "name": "Academy Name",
  "website_url": "https://academy-website.com or null if not found",
  "description_hint": "Brief note about what they do (from the club page)"
}

If NO separate academy is detected, return:
{ "found": false }`;

  try {
    const response = await callLovableAI(prompt);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.found || !parsed.name) return null;

    // Try to find academy URL from links if not extracted
    let academyUrl = parsed.website_url || null;
    if (!academyUrl && parsed.name) {
      const nameLower = parsed.name.toLowerCase().replace(/\s+/g, "");
      for (const link of links) {
        const linkLower = link.toLowerCase().replace(/\s+/g, "");
        if (linkLower.includes(nameLower) || nameLower.split(" ").some((w: string) => w.length > 4 && linkLower.includes(w))) {
          academyUrl = link;
          break;
        }
      }
    }

    console.log(`Detected academy at ${locationName}: ${parsed.name} (url: ${academyUrl})`);

    return {
      name: parsed.name,
      website_url: academyUrl,
      description: null,
      contact_email: null,
      phone: null,
      social_facebook: null,
      social_instagram: null,
      social_linkedin: null,
      social_youtube: null,
      social_tiktok: null,
    };
  } catch (e) {
    console.error("Academy detection error:", e);
    return null;
  }
}

async function enrichAcademyFromWebsite(academy: DetectedAcademy): Promise<DetectedAcademy> {
  if (!academy.website_url) return academy;

  try {
    const scrapeResult = await scrapeWebsite(academy.website_url);
    if (!scrapeResult || !scrapeResult.markdown) return academy;

    const socialFromLinks = extractSocialFromLinks(scrapeResult.links);

    const prompt = `Analyze this padel academy website and extract information.
Return ONLY valid JSON with these fields. Use null for any field you cannot find.

{
  "description": "2-3 sentence factual description in Dutch about this padel academy. Write in third person. Focus on what they offer, their approach, and who they serve.",
  "contact_email": "email address or null",
  "phone": "phone number or null"
}

Academy: ${academy.name}

Website content:
${scrapeResult.markdown.substring(0, 8000)}`;

    const response = await callLovableAI(prompt);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      academy.description = parsed.description || null;
      academy.contact_email = parsed.contact_email || null;
      academy.phone = parsed.phone || null;
    }

    academy.social_facebook = socialFromLinks.facebook_url;
    academy.social_instagram = socialFromLinks.instagram_url;
    academy.social_linkedin = socialFromLinks.linkedin_url;
    academy.social_youtube = socialFromLinks.youtube_url;
    academy.social_tiktok = socialFromLinks.tiktok_url;
  } catch (e) {
    console.error(`Error enriching academy ${academy.name}:`, e);
  }

  return academy;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function createAcademyProfile(
  supabase: SupabaseClient,
  academy: DetectedAcademy,
  locationId: string,
  country: string
): Promise<string | null> {
  try {
    // Check if academy with same name already exists
    const slug = generateSlug(academy.name);
    const { data: existing } = await supabase
      .from("academy_profiles")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();

    if (existing) {
      console.log(`Academy "${academy.name}" already exists (${existing.id}), linking to location`);
      // Ensure location link exists
      await ensureAcademyLocationLink(supabase, existing.id, locationId);
      return existing.id;
    }

    // Create academy profile
    const { data: newAcademy, error: createError } = await supabase
      .from("academy_profiles")
      .insert({
        name: academy.name,
        slug,
        country,
        description: academy.description,
        contact_email: academy.contact_email,
        phone: academy.phone,
        website_url: academy.website_url,
        social_facebook: academy.social_facebook,
        social_instagram: academy.social_instagram,
        social_linkedin: academy.social_linkedin,
        social_youtube: academy.social_youtube,
        social_tiktok: academy.social_tiktok,
        is_public: false, // stays non-public until manually reviewed
        is_verified: false,
      })
      .select("id")
      .single();

    if (createError) {
      console.error("Error creating academy profile:", createError);
      return null;
    }

    console.log(`Created academy profile: ${academy.name} (${newAcademy.id})`);

    // Link academy to location
    await ensureAcademyLocationLink(supabase, newAcademy.id, locationId);

    return newAcademy.id;
  } catch (e) {
    console.error("Error in createAcademyProfile:", e);
    return null;
  }
}

async function ensureAcademyLocationLink(
  supabase: SupabaseClient,
  academyId: string,
  locationId: string
): Promise<void> {
  const { data: existingLink } = await supabase
    .from("academy_locations")
    .select("id")
    .eq("academy_profile_id", academyId)
    .eq("location_id", locationId)
    .maybeSingle();

  if (!existingLink) {
    const { error } = await supabase
      .from("academy_locations")
      .insert({
        academy_profile_id: academyId,
        location_id: locationId,
        is_active: true,
        show_on_academy_page: true,
        show_on_club_page: true,
      });
    if (error) console.error("Error linking academy to location:", error);
    else console.log(`Linked academy ${academyId} to location ${locationId}`);
  }
}

async function uploadLogo(
  supabase: SupabaseClient,
  locationId: string,
  logoUrl: string
): Promise<string | null> {
  try {
    console.log("Downloading logo from:", logoUrl);
    const response = await fetch(logoUrl);
    if (!response.ok) return null;

    const blob = await response.blob();
    const uint8Array = new Uint8Array(await blob.arrayBuffer());
    const extension = logoUrl.split(".").pop()?.split("?")[0] || "png";
    const filePath = `clubs/${locationId}/logo.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(filePath, uint8Array, { contentType: blob.type || "image/png", upsert: true });

    if (uploadError) { console.error("Upload error:", uploadError); return null; }

    const { data: { publicUrl } } = supabase.storage.from("avatars").getPublicUrl(filePath);
    return publicUrl;
  } catch (error) {
    console.error("Error uploading logo:", error);
    return null;
  }
}

function getMissingFields(location: Location): string[] {
  const missing: string[] = [];
  if (!location.description) missing.push("description");
  if ((location.indoor_courts ?? 0) === 0 && (location.outdoor_courts ?? 0) === 0) missing.push("indoor_courts", "outdoor_courts");
  if (!location.phone) missing.push("phone");
  if (!location.email) missing.push("email");
  if (!location.facebook_url) missing.push("facebook_url");
  if (!location.instagram_url) missing.push("instagram_url");
  if (!location.opening_hours) missing.push("opening_hours");
  if (!location.logo_url) missing.push("logo_url");
  return missing;
}

async function generateTranslatedDescriptions(
  baseDescription: string,
  locationName: string,
  city: string
): Promise<Record<string, string>> {
  const locales = ["nl", "en", "es", "de", "fr"];
  const descriptions: Record<string, string> = { nl: baseDescription };

  const prompt = `Translate this Dutch padel club description into English, Spanish, German, and French.
Keep the same factual tone, third person, 2-3 sentences. Return ONLY valid JSON.

Original Dutch description of "${locationName}" in ${city}:
"${baseDescription}"

Return JSON:
{
  "en": "English translation",
  "es": "Spanish translation",
  "de": "German translation",
  "fr": "French translation"
}`;

  try {
    const response = await callLovableAI(prompt);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      for (const locale of locales) {
        if (locale !== "nl" && parsed[locale]) {
          descriptions[locale] = parsed[locale];
        }
      }
    }
  } catch (e) {
    console.error("Translation error:", e);
  }

  return descriptions;
}

async function processLocation(
  supabase: SupabaseClient,
  location: Location,
  dryRun: boolean,
  fillMissingOnly: boolean
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = {
    location_id: location.id,
    location_name: location.name,
    status: "success",
    fields_updated: [],
  };

  try {
    if (!location.website_url) {
      result.status = "skipped";
      result.error = "No website URL";
      return result;
    }

    const missingFields = getMissingFields(location);
    if (fillMissingOnly && missingFields.length === 0) {
      result.status = "skipped";
      result.error = "All fields already filled";
      return result;
    }

    console.log(`Processing: ${location.name} (missing: ${missingFields.join(", ")})`);

    // Step 1: Scrape
    const scrapeResult = await scrapeWebsite(location.website_url);
    if (!scrapeResult || !scrapeResult.markdown) {
      result.status = "error";
      result.error = "Failed to scrape website";
      return result;
    }

    // Step 2: Extract all fields in one AI call
    const extracted = await extractAllFields(
      scrapeResult.markdown, scrapeResult.links,
      location.name, location.city, location.street_address, missingFields
    );
    console.log(`Extracted for ${location.name}:`, JSON.stringify(extracted).substring(0, 200));

    // Step 3: Upload logo if missing
    let storedLogoUrl: string | null = null;
    if (!location.logo_url && scrapeResult.logoUrl && !dryRun) {
      storedLogoUrl = await uploadLogo(supabase, location.id, scrapeResult.logoUrl);
    }

    result.data = { ...extracted, logo_url: storedLogoUrl || scrapeResult.logoUrl };

    // Step 4: Build conditional update (only NULL fields)
    if (!dryRun) {
      const locUpdate: Record<string, unknown> = {};

      if (!location.description && extracted.description) {
        locUpdate.description = extracted.description;
        result.fields_updated!.push("description");
      }
      if ((location.indoor_courts ?? 0) === 0 && (location.outdoor_courts ?? 0) === 0 && (extracted.indoor_courts > 0 || extracted.outdoor_courts > 0)) {
        locUpdate.indoor_courts = extracted.indoor_courts;
        locUpdate.outdoor_courts = extracted.outdoor_courts;
        result.fields_updated!.push("courts");
      }
      if (!location.phone && extracted.phone) {
        locUpdate.phone = extracted.phone;
        result.fields_updated!.push("phone");
      }
      if (!location.email && extracted.email) {
        locUpdate.email = extracted.email;
        result.fields_updated!.push("email");
      }
      if (!location.facebook_url && extracted.facebook_url) {
        locUpdate.facebook_url = extracted.facebook_url;
        result.fields_updated!.push("facebook_url");
      }
      if (!location.instagram_url && extracted.instagram_url) {
        locUpdate.instagram_url = extracted.instagram_url;
        result.fields_updated!.push("instagram_url");
      }
      if (!location.opening_hours && extracted.opening_hours) {
        locUpdate.opening_hours = extracted.opening_hours;
        result.fields_updated!.push("opening_hours");
      }
      if (!location.logo_url && storedLogoUrl) {
        locUpdate.logo_url = storedLogoUrl;
        result.fields_updated!.push("logo_url");
      }

      if (Object.keys(locUpdate).length > 0) {
        const { error: locError } = await supabase
          .from("locations")
          .update(locUpdate)
          .eq("id", location.id);
        if (locError) console.error("Error updating location:", locError);
      }

      // Also update club_profile if it exists (only NULL fields)
      const { data: existingProfile } = await supabase
        .from("club_profiles")
        .select("id, description, logo_url, phone, contact_email, social_facebook, social_instagram")
        .eq("location_id", location.id)
        .single();

      if (existingProfile) {
        const profileUpdate: Record<string, unknown> = {};
        if (!existingProfile.description && extracted.description) profileUpdate.description = extracted.description;
        if (!existingProfile.logo_url && storedLogoUrl) profileUpdate.logo_url = storedLogoUrl;
        if (!existingProfile.phone && extracted.phone) profileUpdate.phone = extracted.phone;
        if (!existingProfile.contact_email && extracted.email) profileUpdate.contact_email = extracted.email;
        if (!existingProfile.social_facebook && extracted.facebook_url) profileUpdate.social_facebook = extracted.facebook_url;
        if (!existingProfile.social_instagram && extracted.instagram_url) profileUpdate.social_instagram = extracted.instagram_url;

        if (Object.keys(profileUpdate).length > 0) {
          const { error: profileError } = await supabase
            .from("club_profiles")
            .update(profileUpdate)
            .eq("location_id", location.id);
          if (profileError) console.error("Error updating club_profile:", profileError);
        }
      }

      // Step 5: Generate and store translated descriptions
      const descriptionToTranslate = extracted.description || location.description;
      if (descriptionToTranslate) {
        const { data: existingTranslations } = await supabase
          .from("location_translations")
          .select("locale")
          .eq("location_id", location.id);

        const existingLocales = new Set((existingTranslations || []).map((t: { locale: string }) => t.locale));
        const missingLocales = ["nl", "en", "es", "de", "fr"].filter((l) => !existingLocales.has(l));

        if (missingLocales.length > 0) {
          console.log(`Generating translations for ${location.name}: ${missingLocales.join(", ")}`);
          const translations = await generateTranslatedDescriptions(descriptionToTranslate, location.name, location.city);

          const rows = missingLocales
            .filter((locale) => translations[locale])
            .map((locale) => ({
              location_id: location.id,
              locale,
              description: translations[locale],
            }));

          if (rows.length > 0) {
            const { error: transError } = await supabase
              .from("location_translations")
              .upsert(rows, { onConflict: "location_id,locale" });
            if (transError) console.error("Error inserting translations:", transError);
            else result.fields_updated!.push(`translations(${rows.map((r) => r.locale).join(",")})`);
          }
        }
      }

      // Step 6: Detect and auto-create academy if found
      const detected = await detectAcademy(
        scrapeResult.markdown,
        scrapeResult.links,
        location.name,
        location.city
      );

      if (detected) {
        console.log(`Academy detected at ${location.name}: ${detected.name}`);
        
        // Enrich academy from its own website
        const enrichedAcademy = await enrichAcademyFromWebsite(detected);
        
        // Create or link
        const academyId = await createAcademyProfile(
          supabase,
          enrichedAcademy,
          location.id,
          location.city ? "NL" : "NL" // default country
        );
        
        if (academyId) {
          result.academy_created = `${detected.name} (${academyId})`;
          result.fields_updated!.push(`academy:${detected.name}`);
        }
      }
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

    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(body.batch_size || 10, 50);
    const offset = body.offset || 0;
    const dryRun = body.dry_run === true;
    const fillMissingOnly = body.fill_missing_only !== false; // default true
    const locationIds: string[] | undefined = body.location_ids;

    console.log(`Starting enrichment - batch: ${batchSize}, offset: ${offset}, dry_run: ${dryRun}, fill_missing: ${fillMissingOnly}`);

    let query = supabase
      .from("locations")
      .select("id, name, city, street_address, website_url, indoor_courts, outdoor_courts, description, phone, email, facebook_url, instagram_url, opening_hours, logo_url")
      .not("website_url", "is", null)
      .order("name", { ascending: true });

    if (locationIds && locationIds.length > 0) {
      query = query.in("id", locationIds);
    } else {
      query = query.range(offset, offset + batchSize - 1);
    }

    const { data: locations, error: fetchError } = await query;

    if (fetchError) throw new Error(`Failed to fetch locations: ${fetchError.message}`);

    if (!locations || locations.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No locations to process", results: [], total_processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing ${locations.length} locations...`);

    const results: EnrichmentResult[] = [];
    for (const location of locations) {
      const result = await processLocation(supabase, location as Location, dryRun, fillMissingOnly);
      results.push(result);

      if (locations.indexOf(location) < locations.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const summary = {
      success: results.filter((r) => r.status === "success").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      errors: results.filter((r) => r.status === "error").length,
      fields_updated: results.flatMap((r) => r.fields_updated || []),
      academies_created: results.filter((r) => r.academy_created).map((r) => r.academy_created),
    };

    console.log("Enrichment complete:", summary);

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        fill_missing_only: fillMissingOnly,
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
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
