import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SOURCE_API_URL =
  "https://uotzmkubfebvebqphwmf.supabase.co/functions/v1/export-padeltrainer";
const SOURCE_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvdHpta3ViZmVidmVicXBod21mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0ODQ5MzMsImV4cCI6MjA4OTA2MDkzM30.QEMTtqDesK6cO35Ltm2Ts9CDL2RaYOaSuHan1TdvYfA";

interface SourceRecord {
  [key: string]: unknown;
}

interface Summary {
  inserted_locations: number;
  inserted_academies: number;
  linked: number;
  skipped_duplicate: number;
  skipped_invalid: number;
  total_source: number;
  dry_run: boolean;
}

async function fetchAllPages(resource: string): Promise<SourceRecord[]> {
  const all: SourceRecord[] = [];
  let offset = 0;
  const limit = 200;
  let hasMore = true;

  while (hasMore) {
    const res = await fetch(SOURCE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SOURCE_API_KEY}`,
      },
      body: JSON.stringify({ resource, limit, offset }),
    });

    if (!res.ok) {
      throw new Error(
        `Source API error for ${resource}: ${res.status} ${await res.text()}`
      );
    }

    const json = await res.json();
    const data = json.data as SourceRecord[];
    all.push(...data);
    hasMore = json.has_more === true;
    offset += limit;
  }

  return all;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth: admin only
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify caller identity
    const authClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } =
      await authClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub as string;

    // Check admin role using service client
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: adminCheck } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();

    if (!adminCheck) {
      return new Response(JSON.stringify({ error: "Admin access required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse body
    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;

    const summary: Summary = {
      inserted_locations: 0,
      inserted_academies: 0,
      linked: 0,
      skipped_duplicate: 0,
      skipped_invalid: 0,
      total_source: 0,
      dry_run: dryRun,
    };

    // ─── Phase 1: Locations ───
    console.log("Phase 1: Fetching locations from source...");
    const sourceLocations = await fetchAllPages("locations");
    summary.total_source += sourceLocations.length;
    console.log(`Fetched ${sourceLocations.length} locations from source`);

    // Get existing slugs
    const { data: existingLocSlugs } = await adminClient
      .from("locations")
      .select("slug");
    const existingLocSlugSet = new Set(
      (existingLocSlugs || []).map((r: { slug: string }) => r.slug)
    );

    // Map source internal_id → inserted location id for linking
    const sourceIdToLocationId = new Map<string, string>();

    for (const loc of sourceLocations) {
      const city = loc.city as string | null;
      if (!city || city.trim() === "") {
        summary.skipped_invalid++;
        continue;
      }

      const slug = loc.slug as string;
      if (!slug || existingLocSlugSet.has(slug)) {
        summary.skipped_duplicate++;
        continue;
      }

      const record = {
        name: loc.name as string,
        slug,
        street_address: (loc.street_address as string) || null,
        city,
        country: (loc.country as string) || null,
        latitude: (loc.latitude as number) || null,
        longitude: (loc.longitude as number) || null,
        website_url: (loc.website_url as string) || null,
        phone: (loc.phone as string) || null,
        email: (loc.email as string) || null,
        logo_url: (loc.logo_url as string) || null,
        indoor_courts: (loc.indoor_courts as number) || null,
        outdoor_courts: (loc.outdoor_courts as number) || null,
        google_maps_url: (loc.google_maps_url as string) || null,
        google_rating: (loc.google_rating as number) || null,
        google_review_count: (loc.google_review_count as number) || null,
      };

      if (!dryRun) {
        const { data: inserted, error: insertErr } = await adminClient
          .from("locations")
          .insert(record)
          .select("id")
          .single();

        if (insertErr) {
          console.error(`Failed to insert location ${slug}:`, insertErr.message);
          summary.skipped_invalid++;
          continue;
        }

        // Track source id → new location id
        const sourceId = (loc.id as string) || (loc._internal_id as string);
        if (sourceId && inserted) {
          sourceIdToLocationId.set(sourceId, inserted.id);
        }
      }

      existingLocSlugSet.add(slug);
      summary.inserted_locations++;

      // Also track source id for dry run
      if (dryRun) {
        const sourceId = (loc.id as string) || (loc._internal_id as string);
        if (sourceId) {
          sourceIdToLocationId.set(sourceId, `dry-run-${slug}`);
        }
      }
    }

    console.log(`Phase 1 complete: ${summary.inserted_locations} locations to insert`);

    // ─── Phase 2: Academies ───
    console.log("Phase 2: Fetching academies from source...");
    const sourceAcademies = await fetchAllPages("academies");
    summary.total_source += sourceAcademies.length;
    console.log(`Fetched ${sourceAcademies.length} academies from source`);

    // Get existing academy slugs
    const { data: existingAcaSlugs } = await adminClient
      .from("academy_profiles")
      .select("slug");
    const existingAcaSlugSet = new Set(
      (existingAcaSlugs || []).map((r: { slug: string }) => r.slug)
    );

    // Track source academy id → inserted academy id for linking
    const sourceAcaIdToInserted = new Map<
      string,
      { academyId: string; linkedClubId: string | null }
    >();

    for (const aca of sourceAcademies) {
      const slug = aca.slug as string;
      if (!slug || existingAcaSlugSet.has(slug)) {
        summary.skipped_duplicate++;
        continue;
      }

      const socialLinks = (aca.social_links as Record<string, string>) || {};

      const record = {
        name: aca.name as string,
        slug,
        country: (aca.country as string) || "NL",
        description: (aca.description as string) || null,
        logo_url: (aca.logo_url as string) || null,
        website_url: (aca.website_url as string) || null,
        contact_email: (aca.contact_email as string) || null,
        phone: (aca.phone as string) || null,
        social_facebook: socialLinks.facebook || null,
        social_instagram: socialLinks.instagram || null,
      };

      if (!dryRun) {
        const { data: inserted, error: insertErr } = await adminClient
          .from("academy_profiles")
          .insert(record)
          .select("id")
          .single();

        if (insertErr) {
          console.error(`Failed to insert academy ${slug}:`, insertErr.message);
          summary.skipped_invalid++;
          continue;
        }

        const linkedClubId = (aca._linked_club_id as string) || null;
        if (inserted) {
          sourceAcaIdToInserted.set(slug, {
            academyId: inserted.id,
            linkedClubId,
          });
        }
      } else {
        const linkedClubId = (aca._linked_club_id as string) || null;
        sourceAcaIdToInserted.set(slug, {
          academyId: `dry-run-${slug}`,
          linkedClubId,
        });
      }

      existingAcaSlugSet.add(slug);
      summary.inserted_academies++;
    }

    console.log(`Phase 2 complete: ${summary.inserted_academies} academies to insert`);

    // ─── Phase 3: Link academies to locations ───
    console.log("Phase 3: Linking academies to locations...");

    for (const [, { academyId, linkedClubId }] of sourceAcaIdToInserted) {
      if (!linkedClubId) continue;

      const locationId = sourceIdToLocationId.get(linkedClubId);
      if (!locationId) {
        console.log(`No location found for linked_club_id ${linkedClubId}`);
        continue;
      }

      if (!dryRun) {
        // Check if link already exists
        const { data: existingLink } = await adminClient
          .from("academy_locations")
          .select("id")
          .eq("academy_profile_id", academyId)
          .eq("location_id", locationId)
          .maybeSingle();

        if (existingLink) continue;

        const { error: linkErr } = await adminClient
          .from("academy_locations")
          .insert({
            academy_profile_id: academyId,
            location_id: locationId,
          });

        if (linkErr) {
          console.error(`Failed to link academy ${academyId} to location ${locationId}:`, linkErr.message);
          continue;
        }
      }

      summary.linked++;
    }

    console.log(`Phase 3 complete: ${summary.linked} links created`);
    console.log("Import summary:", JSON.stringify(summary));

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Import error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
