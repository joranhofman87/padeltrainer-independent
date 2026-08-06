import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key",
};

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "netherlands": "NL", "nederland": "NL", "holland": "NL",
  "spain": "ES", "españa": "ES", "espana": "ES",
  "france": "FR", "italy": "IT", "italia": "IT",
  "united kingdom": "GB", "uk": "GB", "great britain": "GB",
  "germany": "DE", "deutschland": "DE", "belgium": "BE", "belgië": "BE", "belgie": "BE",
  "denmark": "DK", "sweden": "SE", "norway": "NO", "finland": "FI",
  "united states": "US", "usa": "US", "portugal": "PT", "austria": "AT",
  "switzerland": "CH", "ireland": "IE", "poland": "PL", "czechia": "CZ",
  "czech republic": "CZ", "mexico": "MX", "méxico": "MX",
  "united arab emirates": "AE", "indonesia": "ID", "australia": "AU",
};

function normalizeCountryParam(raw: string): string {
  const trimmed = raw.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_NAME_TO_CODE[trimmed.toLowerCase()] ?? trimmed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Simple API key auth — the calling project sends x-api-key header
  const apiKey = req.headers.get("x-api-key");
  const expectedKey = Deno.env.get("PUBLIC_API_KEY");

  if (!expectedKey || apiKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const url = new URL(req.url);
  const resource = url.searchParams.get("resource");

  try {
    if (resource === "locations") {
      const country = url.searchParams.get("country");
      const city = url.searchParams.get("city");
      const limit = Math.min(Number(url.searchParams.get("limit") || 1000), 5000);
      const offset = Number(url.searchParams.get("offset") || 0);

      let query = supabase
        .from("locations")
        .select(
          "id, name, slug, street_address, postal_code, city, country, latitude, longitude, website_url, phone, email, logo_url, indoor_courts, outdoor_courts, google_maps_url, google_rating, google_review_count, is_active"
        )
        .eq("is_active", true)
        .range(offset, offset + limit - 1)
        .order("name");

      // locations.country stores ISO alpha-2 codes since 20260612160000; keep
      // pre-normalization consumers working by aliasing common name queries.
      if (country) query = query.eq("country", normalizeCountryParam(country));
      if (city) query = query.ilike("city", city);

      const { data, error } = await query;
      if (error) throw error;

      return new Response(JSON.stringify({ data, count: data?.length ?? 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (resource === "academies") {
      const country = url.searchParams.get("country");
      const limit = Math.min(Number(url.searchParams.get("limit") || 1000), 5000);
      const offset = Number(url.searchParams.get("offset") || 0);

      let query = supabase
        .from("academy_profiles")
        .select(
          "id, name, slug, country, description, logo_url, banner_url, website_url, contact_email, phone, social_facebook, social_instagram, social_linkedin, social_tiktok, social_youtube, is_public, is_verified"
        )
        .eq("is_public", true)
        .range(offset, offset + limit - 1)
        .order("name");

      if (country) query = query.eq("country", country);

      const { data, error } = await query;
      if (error) throw error;

      return new Response(JSON.stringify({ data, count: data?.length ?? 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        error: "Invalid resource. Use ?resource=locations or ?resource=academies",
        available_resources: ["locations", "academies"],
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    // Log full detail server-side; never echo raw DB error text to callers.
    console.error("Public API error:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
