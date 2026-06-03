import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, requireUser } from "../_shared/auth.ts";
import {
  buildFullName,
  buildProfileNamePatch,
  syncProfileNamesAfterSignup,
} from "../_shared/signupProfileSync.ts";

const ALLOWED_ROLES = ["player", "trainer", "club", "academy"] as const;
type SignupRole = (typeof ALLOWED_ROLES)[number];

interface CompleteOAuthBody {
  role?: string;
  timezone?: string;
}

function resolveOAuthProfileNames(
  email: string,
  metadata: Record<string, unknown>,
): { firstName: string; lastName: string | null; fullName: string } {
  const firstName = String(metadata.first_name ?? metadata.given_name ?? "").trim();
  const lastName = String(metadata.last_name ?? metadata.family_name ?? "").trim();
  let fullName = String(metadata.full_name ?? metadata.name ?? "").trim();

  if (!fullName) {
    fullName = buildFullName(firstName, lastName);
  }
  if (!fullName && email) {
    fullName = email.split("@")[0] || "User";
  }
  if (!fullName) {
    fullName = "User";
  }

  const resolvedFirst = firstName || fullName.split(/\s+/).filter(Boolean)[0] || "User";
  const resolvedLast = lastName ||
    (fullName.includes(" ") ? fullName.split(/\s+/).slice(1).join(" ") : null);

  return {
    firstName: resolvedFirst,
    lastName: resolvedLast,
    fullName,
  };
}

async function ensureTrainerProfile(admin: SupabaseClient, userId: string, timezone: string) {
  const { data: existingTrainerProfile } = await admin
    .from("trainer_profiles")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  if (existingTrainerProfile) return;

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { error: trainerProfileError } = await admin.from("trainer_profiles").insert({
    user_id: userId,
    trial_started_at: now.toISOString(),
    trial_ends_at: trialEnd.toISOString(),
    subscription_status: "trial",
    is_public: false,
    timezone,
  });

  if (trainerProfileError) {
    console.error("[complete-oauth-signup] Failed to create trainer profile:", trainerProfileError);
    throw new Error("Failed to create trainer profile");
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

    const { supabase: admin } = authed;
    const body = (await req.json()) as CompleteOAuthBody;

    const authHeader = req.headers.get("Authorization")!;
    const token = authHeader.replace("Bearer ", "");
    const { data: authData, error: authUserError } = await admin.auth.getUser(token);
    if (authUserError || !authData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authUser = authData.user;
    const role = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
    if (!ALLOWED_ROLES.includes(role as SignupRole)) {
      return new Response(JSON.stringify({ error: "Invalid role" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const email = authUser.email?.trim() || "";
    if (!email) {
      return new Response(JSON.stringify({ error: "User email is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const metadata = (authUser.user_metadata ?? {}) as Record<string, unknown>;
    const { firstName, lastName, fullName } = resolveOAuthProfileNames(email, metadata);

    const profilePatch = buildProfileNamePatch({ firstName, lastName, fullName });
    await syncProfileNamesAfterSignup(admin, authUser.id, email, profilePatch);

    const { error: roleError } = await admin
      .from("user_roles")
      .upsert({ user_id: authUser.id, role }, { onConflict: "user_id,role" });

    if (roleError) {
      console.error("[complete-oauth-signup] Role upsert failed:", roleError);
      return new Response(JSON.stringify({ error: "Failed to assign role" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (role === "trainer") {
      const tz =
        typeof body.timezone === "string" && body.timezone.trim()
          ? body.timezone.trim()
          : "Europe/Amsterdam";
      try {
        await ensureTrainerProfile(admin, authUser.id, tz);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "Failed to create trainer profile" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    return new Response(
      JSON.stringify({ success: true, role }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[complete-oauth-signup] Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
