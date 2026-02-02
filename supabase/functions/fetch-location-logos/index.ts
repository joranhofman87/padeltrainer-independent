import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Location {
  id: string;
  name: string;
  website_url: string;
}

interface LogoResult {
  location_id: string;
  location_name: string;
  status: "success" | "skipped" | "error";
  error?: string;
  logo_url?: string | null;
}

async function scrapeLogoOnly(url: string): Promise<string | null> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY not configured");
  }

  let formattedUrl = url.trim();
  if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
    formattedUrl = `https://${formattedUrl}`;
  }

  console.log("Scraping logo from:", formattedUrl);

  const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: formattedUrl,
      formats: ["branding"], // Only branding - no markdown, no waitFor
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Firecrawl error:", errorText);
    return null;
  }

  const data = await response.json();
  const logoUrl = data.data?.branding?.images?.logo || data.branding?.images?.logo || null;

  console.log("Found logo:", logoUrl ? "yes" : "no");
  return logoUrl;
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
): Promise<LogoResult> {
  const result: LogoResult = {
    location_id: location.id,
    location_name: location.name,
    status: "success",
  };

  try {
    // Scrape logo from website
    const logoUrl = await scrapeLogoOnly(location.website_url);

    if (!logoUrl) {
      result.status = "success";
      result.logo_url = null;
      result.error = "No logo found";
      return result;
    }

    // Upload to storage (unless dry run)
    let storedLogoUrl: string | null = null;
    if (!dryRun) {
      storedLogoUrl = await uploadLogo(supabase, location.id, logoUrl);

      if (storedLogoUrl) {
        // Update database
        const { error: updateError } = await supabase
          .from("locations")
          .update({ logo_url: storedLogoUrl })
          .eq("id", location.id);

        if (updateError) {
          console.error("Error updating location:", updateError);
        }
      }
    }

    result.logo_url = storedLogoUrl || logoUrl;
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
    const locationIds: string[] | undefined = body.location_ids;

    console.log(`Starting logo fetch - batch_size: ${batchSize}, offset: ${offset}, dry_run: ${dryRun}`);

    // Fetch locations to process
    let query = supabase
      .from("locations")
      .select("id, name, website_url")
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

    // Process each location with minimal delay
    const results: LogoResult[] = [];
    for (const location of locations) {
      const result = await processLocation(supabase, location as Location, dryRun);
      results.push(result);

      // Small delay between requests (reduced from 500ms)
      if (locations.indexOf(location) < locations.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    const summary = {
      success: results.filter((r) => r.status === "success" && r.logo_url).length,
      no_logo: results.filter((r) => r.status === "success" && !r.logo_url).length,
      errors: results.filter((r) => r.status === "error").length,
    };

    console.log("Logo fetch complete:", summary);

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
    console.error("Logo fetch error:", error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
