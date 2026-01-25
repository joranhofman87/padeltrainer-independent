import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.claims.sub;

    // Verify caller is a club manager or trainer
    const { data: isClubManager } = await supabaseUser.rpc("is_any_club_manager", { _user_id: userId });
    const { data: isTrainer } = await supabaseUser.rpc("is_trainer", { _user_id: userId });

    if (!isClubManager && !isTrainer) {
      return new Response(
        JSON.stringify({ error: "Only club managers or trainers can create manual player registrations" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { email, fullName, phone, ratingSystem, rating } = await req.json();

    if (!email || !fullName) {
      return new Response(
        JSON.stringify({ error: "Email and full name are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user with this email already exists
    const { data: existingUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

    let profileId: string;
    let temporaryPassword: string | null = null;
    let isNewUser = false;

    if (existingUser) {
      // User exists, get their profile ID
      const { data: existingProfile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("user_id", existingUser.id)
        .single();

      if (profileError || !existingProfile) {
        return new Response(
          JSON.stringify({ error: "User exists but profile not found" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      profileId = existingProfile.id;
    } else {
      // Create new user account with temporary password
      temporaryPassword = generatePassword();
      isNewUser = true;

      const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

      if (createError) {
        return new Response(
          JSON.stringify({ error: `Failed to create user: ${createError.message}` }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Update their profile with additional data
      await supabaseAdmin
        .from("profiles")
        .update({
          full_name: fullName,
          phone: phone || null,
          rating_system: ratingSystem || "knltb",
          skill_rating: rating || null,
        })
        .eq("user_id", newUser.user.id);

      // Add player role (upsert to avoid duplicates)
      await supabaseAdmin
        .from("user_roles")
        .upsert(
          { user_id: newUser.user.id, role: "player" },
          { onConflict: "user_id,role" }
        );

      // Get the profile ID (created by trigger)
      const { data: newProfile, error: profileError } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("user_id", newUser.user.id)
        .single();

      if (profileError || !newProfile) {
        return new Response(
          JSON.stringify({ error: "Failed to get new profile" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      profileId = newProfile.id;
    }

    return new Response(
      JSON.stringify({
        profileId,
        temporaryPassword,
        isNewUser,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in create-manual-player:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function generatePassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
  let password = "";
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}
