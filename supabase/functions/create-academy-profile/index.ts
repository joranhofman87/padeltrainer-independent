import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { corsHeaders, requireUser } from "../_shared/auth.ts";

interface CreateAcademyBody {
  name?: string;
  contactEmail?: string;
  description?: string;
  country?: string;
  timezone?: string;
}

async function ensureAcademyRole(admin: SupabaseClient, userId: string) {
  const { error } = await admin
    .from("user_roles")
    .upsert({ user_id: userId, role: "academy" }, { onConflict: "user_id,role" });
  if (error) {
    console.error("[create-academy-profile] Failed to ensure academy role:", error);
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
    const body = (await req.json()) as CreateAcademyBody;

    const { data: existingManagers, error: managerLookupError } = await admin
      .from("academy_managers")
      .select("academy_profile_id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1);

    if (managerLookupError) {
      console.error("[create-academy-profile] Manager lookup failed:", managerLookupError);
      return new Response(JSON.stringify({ error: "Failed to check existing academy" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (existingManagers?.length) {
      const academyId = existingManagers[0].academy_profile_id;
      await ensureAcademyRole(admin, user.id);
      return new Response(
        JSON.stringify({ success: true, academyId, existing: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return new Response(JSON.stringify({ error: "Academy name is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: ownedProfile, error: ownedError } = await admin
      .from("academy_profiles")
      .select("id")
      .eq("created_by", user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (ownedError) {
      console.error("[create-academy-profile] Owned profile lookup failed:", ownedError);
      return new Response(JSON.stringify({ error: "Failed to check existing academy" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (ownedProfile?.id) {
      const { error: repairManagerError } = await admin.from("academy_managers").upsert(
        {
          academy_profile_id: ownedProfile.id,
          user_id: user.id,
          role: "owner",
        },
        { onConflict: "academy_profile_id,user_id" },
      );
      if (repairManagerError) {
        console.error("[create-academy-profile] Manager repair failed:", repairManagerError);
        return new Response(JSON.stringify({ error: "Failed to link academy manager" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      await ensureAcademyRole(admin, user.id);
      return new Response(
        JSON.stringify({ success: true, academyId: ownedProfile.id, existing: true, repaired: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const tz =
      typeof body.timezone === "string" && body.timezone.trim()
        ? body.timezone.trim()
        : "Europe/Amsterdam";
    const country =
      typeof body.country === "string" && body.country.trim() ? body.country.trim() : "NL";

    const { data: academy, error: profileError } = await admin
      .from("academy_profiles")
      .insert({
        name,
        description: body.description?.trim() || null,
        contact_email: body.contactEmail?.trim() || null,
        created_by: user.id,
        country,
        timezone: tz,
        is_verified: true,
        is_public: false,
      })
      .select("id")
      .single();

    if (profileError || !academy) {
      console.error("[create-academy-profile] Profile insert failed:", profileError);
      return new Response(
        JSON.stringify({ error: profileError?.message || "Failed to create academy profile" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { error: managerError } = await admin.from("academy_managers").insert({
      academy_profile_id: academy.id,
      user_id: user.id,
      role: "owner",
    });

    if (managerError) {
      console.error("[create-academy-profile] Manager insert failed:", managerError);
      await admin.from("academy_profiles").delete().eq("id", academy.id);
      return new Response(JSON.stringify({ error: "Failed to create academy manager" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await ensureAcademyRole(admin, user.id);

    return new Response(
      JSON.stringify({ success: true, academyId: academy.id, existing: false }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[create-academy-profile] Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
