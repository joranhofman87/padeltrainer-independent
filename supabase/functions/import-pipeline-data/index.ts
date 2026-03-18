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
  const limit = 500;
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
    console.log(`Fetched ${all.length} ${resource} so far...`);
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

    // ─── Phase 1: Fetch all existing location identifiers upfront ───
    console.log("Loading existing location identifiers...");
    
    // Fetch all existing locations with dedup fields (paginate beyond 1000 limit)
    const existingLocs: { slug: string; google_maps_url: string | null; street_address: string | null; city: string | null }[] = [];
    let locOffset = 0;
    const LOC_PAGE = 1000;
    while (true) {
      const { data: page } = await adminClient
        .from("locations")
        .select("slug, google_maps_url, street_address, city")
        .range(locOffset, locOffset + LOC_PAGE - 1);
      if (!page || page.length === 0) break;
      existingLocs.push(...page);
      if (page.length < LOC_PAGE) break;
      locOffset += LOC_PAGE;
    }
    
    // Build dedup indexes: 1) Google Maps URL, 2) address+city, 3) slug
    const existingLocByGoogleUrl = new Set<string>();
    const existingLocByAddressCity = new Set<string>();
    const existingLocSlugSet = new Set<string>();
    
    for (const loc of existingLocs) {
      existingLocSlugSet.add(loc.slug);
      if (loc.google_maps_url) {
        existingLocByGoogleUrl.add(loc.google_maps_url.trim().toLowerCase());
      }
      if (loc.street_address && loc.city) {
        existingLocByAddressCity.add(
          `${loc.street_address.trim().toLowerCase()}::${loc.city.trim().toLowerCase()}`
        );
      }
    }
    console.log(`Existing locations: ${existingLocs.length} (${existingLocByGoogleUrl.size} with Google Maps URL, ${existingLocByAddressCity.size} with address+city)`);

    const { data: existingAcaRows } = await adminClient
      .from("academy_profiles")
      .select("slug");
    const existingAcaSlugSet = new Set(
      (existingAcaRows || []).map((r: { slug: string }) => r.slug)
    );
    console.log(`Existing academies: ${existingAcaSlugSet.size}`);

    // ─── Phase 2: Locations ───
    console.log("Phase 2: Fetching locations from source...");
    const sourceLocations = await fetchAllPages("locations");
    summary.total_source += sourceLocations.length;
    console.log(`Fetched ${sourceLocations.length} locations from source`);

    // Build batch of new locations, track source_id → slug for linking
    const sourceIdToSlug = new Map<string, string>();
    const locBatch: Record<string, unknown>[] = [];

    for (const loc of sourceLocations) {
      const city = loc.city as string | null;
      const slug = loc.slug as string;
      const sourceId = (loc.id as string) || (loc._internal_id as string);
      const googleMapsUrl = (loc.google_maps_url as string) || null;
      const streetAddress = (loc.street_address as string) || null;

      // Always track source_id → slug for linking (even if already exists)
      if (sourceId && slug) {
        sourceIdToSlug.set(sourceId, slug);
      }

      if (!city || city.trim() === "") {
        summary.skipped_invalid++;
        continue;
      }

      // 3-tier duplicate detection:
      // 1. Google Maps URL match (strongest)
      if (googleMapsUrl && existingLocByGoogleUrl.has(googleMapsUrl.trim().toLowerCase())) {
        summary.skipped_duplicate++;
        continue;
      }
      // 2. Address + city match
      if (streetAddress && city) {
        const addrKey = `${streetAddress.trim().toLowerCase()}::${city.trim().toLowerCase()}`;
        if (existingLocByAddressCity.has(addrKey)) {
          summary.skipped_duplicate++;
          continue;
        }
      }
      // 3. Slug match (fallback)
      if (!slug || existingLocSlugSet.has(slug)) {
        summary.skipped_duplicate++;
        continue;
      }

      locBatch.push({
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
      });

      existingLocSlugSet.add(slug);
    }

    console.log(`${locBatch.length} new locations to insert (${summary.skipped_duplicate} duplicates, ${summary.skipped_invalid} invalid)`);

    // Batch insert locations in chunks of 200
    if (!dryRun && locBatch.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < locBatch.length; i += CHUNK) {
        const chunk = locBatch.slice(i, i + CHUNK);
        const { error: insertErr } = await adminClient
          .from("locations")
          .insert(chunk);

        if (insertErr) {
          console.error(`Batch insert locations [${i}..${i + chunk.length}] error:`, insertErr.message);
          // Fall back to one-by-one for this chunk
          for (const rec of chunk) {
            const { error: singleErr } = await adminClient
              .from("locations")
              .insert(rec);
            if (singleErr) {
              console.error(`Failed location ${rec.slug}:`, singleErr.message);
              summary.skipped_invalid++;
            } else {
              summary.inserted_locations++;
            }
          }
        } else {
          summary.inserted_locations += chunk.length;
        }
        console.log(`Inserted locations batch: ${Math.min(i + CHUNK, locBatch.length)}/${locBatch.length}`);
      }
    } else {
      summary.inserted_locations = locBatch.length;
    }

    console.log(`Phase 2 complete: ${summary.inserted_locations} locations inserted`);

    // ─── Phase 3: Academies ───
    console.log("Phase 3: Fetching academies from source...");
    const sourceAcademies = await fetchAllPages("academies");
    summary.total_source += sourceAcademies.length;
    console.log(`Fetched ${sourceAcademies.length} academies from source`);

    // Track academy slug → linked_club_id for phase 4
    const acaSlugToLinkedClubId = new Map<string, string>();
    const acaBatch: Record<string, unknown>[] = [];

    for (const aca of sourceAcademies) {
      const slug = aca.slug as string;
      const linkedClubId = (aca._linked_club_id as string) || null;

      if (linkedClubId && slug) {
        acaSlugToLinkedClubId.set(slug, linkedClubId);
      }

      if (!slug || existingAcaSlugSet.has(slug)) {
        summary.skipped_duplicate++;
        continue;
      }

      const socialLinks = (aca.social_links as Record<string, string>) || {};

      acaBatch.push({
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
      });

      existingAcaSlugSet.add(slug);
    }

    console.log(`${acaBatch.length} new academies to insert`);

    if (!dryRun && acaBatch.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < acaBatch.length; i += CHUNK) {
        const chunk = acaBatch.slice(i, i + CHUNK);
        const { error: insertErr } = await adminClient
          .from("academy_profiles")
          .insert(chunk);

        if (insertErr) {
          console.error(`Batch insert academies [${i}..${i + chunk.length}] error:`, insertErr.message);
          for (const rec of chunk) {
            const { error: singleErr } = await adminClient
              .from("academy_profiles")
              .insert(rec);
            if (singleErr) {
              console.error(`Failed academy ${rec.slug}:`, singleErr.message);
              summary.skipped_invalid++;
            } else {
              summary.inserted_academies++;
            }
          }
        } else {
          summary.inserted_academies += chunk.length;
        }
        console.log(`Inserted academies batch: ${Math.min(i + CHUNK, acaBatch.length)}/${acaBatch.length}`);
      }
    } else {
      summary.inserted_academies = acaBatch.length;
    }

    console.log(`Phase 3 complete: ${summary.inserted_academies} academies inserted`);

    // ─── Phase 4: Link academies to locations via slug lookup ───
    console.log("Phase 4: Linking academies to locations...");

    // Build a map of slug → location_id from ALL locations in DB
    const { data: allLocations } = await adminClient
      .from("locations")
      .select("id, slug");
    const slugToLocationId = new Map<string, string>();
    for (const loc of allLocations || []) {
      slugToLocationId.set(loc.slug, loc.id);
    }

    // Build a map of slug → academy_id from ALL academies in DB
    const { data: allAcademies } = await adminClient
      .from("academy_profiles")
      .select("id, slug");
    const slugToAcademyId = new Map<string, string>();
    for (const aca of allAcademies || []) {
      slugToAcademyId.set(aca.slug, aca.id);
    }

    // Get existing links to avoid duplicates
    const { data: existingLinks } = await adminClient
      .from("academy_locations")
      .select("academy_profile_id, location_id");
    const existingLinkSet = new Set(
      (existingLinks || []).map(
        (l: { academy_profile_id: string; location_id: string }) =>
          `${l.academy_profile_id}::${l.location_id}`
      )
    );

    const linkBatch: { academy_profile_id: string; location_id: string }[] = [];

    for (const [acaSlug, linkedClubId] of acaSlugToLinkedClubId) {
      const academyId = slugToAcademyId.get(acaSlug);
      if (!academyId) continue;

      // Resolve linked_club_id → location slug → location id
      const locSlug = sourceIdToSlug.get(linkedClubId);
      if (!locSlug) continue;

      const locationId = slugToLocationId.get(locSlug);
      if (!locationId) continue;

      const key = `${academyId}::${locationId}`;
      if (existingLinkSet.has(key)) continue;

      linkBatch.push({ academy_profile_id: academyId, location_id: locationId });
      existingLinkSet.add(key);
    }

    console.log(`${linkBatch.length} new academy-location links to create`);

    if (!dryRun && linkBatch.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < linkBatch.length; i += CHUNK) {
        const chunk = linkBatch.slice(i, i + CHUNK);
        const { error: linkErr } = await adminClient
          .from("academy_locations")
          .insert(chunk);

        if (linkErr) {
          console.error(`Batch link error [${i}..${i + chunk.length}]:`, linkErr.message);
        } else {
          summary.linked += chunk.length;
        }
      }
    } else {
      summary.linked = linkBatch.length;
    }

    console.log(`Phase 4 complete: ${summary.linked} links created`);
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
