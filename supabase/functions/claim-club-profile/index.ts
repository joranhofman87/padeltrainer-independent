import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireUser } from "../_shared/auth.ts";

interface ClaimClubBody {
  locationId?: string;
  contactEmail?: string;
  phone?: string;
  description?: string;
}

async function ensureClubRole(admin: SupabaseClient, userId: string) {
  const { error } = await admin
    .from("user_roles")
    .upsert({ user_id: userId, role: "club" }, { onConflict: "user_id,role" });
  if (error) {
    console.error("[claim-club-profile] Failed to ensure club role:", error);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authed = await requireUser(req);
    if (authed instanceof Response) return authed;
    if (authed.isServiceRole) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { user, supabase: admin } = authed;
    const body = (await req.json()) as ClaimClubBody;

    const locationId = typeof body.locationId === "string" ? body.locationId.trim() : "";
    if (!locationId) {
      return new Response(JSON.stringify({ error: "Location is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const contactEmail = typeof body.contactEmail === "string" ? body.contactEmail.trim() : "";
    if (!contactEmail) {
      return new Response(JSON.stringify({ error: "Contact email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existingManagers, error: managerLookupError } = await admin
      .from("club_managers")
      .select("club_profile_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1);

    if (managerLookupError) {
      console.error("[claim-club-profile] Manager lookup failed:", managerLookupError);
      return new Response(JSON.stringify({ error: "Failed to check existing club" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (existingManagers?.length) {
      const clubProfileId = existingManagers[0].club_profile_id;
      await ensureClubRole(admin, user.id);
      return new Response(
        JSON.stringify({
          success: true,
          clubProfileId,
          existing: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: locationProfile, error: locationProfileError } = await admin
      .from("club_profiles")
      .select("id, created_by")
      .eq("location_id", locationId)
      .maybeSingle();

    if (locationProfileError) {
      console.error("[claim-club-profile] Location profile lookup failed:", locationProfileError);
      return new Response(JSON.stringify({ error: "Failed to check location claim" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (locationProfile?.id) {
      const { data: profileManagers, error: profileManagersError } = await admin
        .from("club_managers")
        .select("user_id")
        .eq("club_profile_id", locationProfile.id);

      if (profileManagersError) {
        console.error("[claim-club-profile] Profile managers lookup failed:", profileManagersError);
        return new Response(JSON.stringify({ error: "Failed to check location claim" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const userIsManager = profileManagers?.some((m) => m.user_id === user.id);
      if (userIsManager) {
        await ensureClubRole(admin, user.id);
        return new Response(
          JSON.stringify({
            success: true,
            clubProfileId: locationProfile.id,
            existing: true,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (profileManagers && profileManagers.length > 0) {
        return new Response(
          JSON.stringify({ error: "This location has already been claimed" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (locationProfile.created_by && locationProfile.created_by !== user.id) {
        return new Response(
          JSON.stringify({ error: "This location has already been claimed" }),
          { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const { error: repairManagerError } = await admin.from("club_managers").upsert(
        {
          club_profile_id: locationProfile.id,
          user_id: user.id,
          role: "owner",
        },
        { onConflict: "club_profile_id,user_id" },
      );

      if (repairManagerError) {
        console.error("[claim-club-profile] Manager repair failed:", repairManagerError);
        return new Response(JSON.stringify({ error: "Failed to link club manager" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await ensureClubRole(admin, user.id);
      return new Response(
        JSON.stringify({
          success: true,
          clubProfileId: locationProfile.id,
          existing: true,
          repaired: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: clubProfile, error: profileError } = await admin
      .from("club_profiles")
      .insert({
        location_id: locationId,
        contact_email: contactEmail,
        phone: body.phone?.trim() || null,
        description: body.description?.trim() || null,
        is_verified: false,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (profileError || !clubProfile) {
      const message = profileError?.code === "23505"
        ? "This location has already been claimed"
        : profileError?.message || "Failed to create club claim";
      console.error("[claim-club-profile] Profile insert failed:", profileError);
      return new Response(JSON.stringify({ error: message }), {
        status: profileError?.code === "23505" ? 409 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: managerError } = await admin.from("club_managers").insert({
      club_profile_id: clubProfile.id,
      user_id: user.id,
      role: "owner",
    });

    if (managerError) {
      console.error("[claim-club-profile] Manager insert failed:", managerError);
      await admin.from("club_profiles").delete().eq("id", clubProfile.id);
      return new Response(JSON.stringify({ error: "Failed to assign club ownership" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await ensureClubRole(admin, user.id);

    return new Response(
      JSON.stringify({ success: true, clubProfileId: clubProfile.id, existing: false }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[claim-club-profile] Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
